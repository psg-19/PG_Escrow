import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KMSClient, EncryptCommand } from "@aws-sdk/client-kms";
import { createDb, migrate, users, type DbHandle } from "@pg/db";
import { eq } from "drizzle-orm";
import { signup, login, loginWithGoogle, publicUser } from "../src/auth.js";
import { migrateWalletKeys } from "../src/wallet-migration.js";
import { unlockWalletKey } from "../src/kms.js";

let handle: DbHandle;
let vault: Map<string, { plaintext: Buffer; context: string }>;
beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("CHAIN", "localhost");
  vi.stubEnv("WALLET_KEY_PROTECTION", "kms");
  vi.stubEnv("AWS_REGION", "ap-south-1"); vi.stubEnv("AWS_KMS_KEY_ID", "test-key");
  handle = createDb("file::memory:"); await migrate(handle);
  vault = new Map();
  vi.spyOn(KMSClient.prototype, "send").mockImplementation(async (cmd: any) => {
    if (cmd instanceof EncryptCommand) {
      const id = `encrypted-${vault.size}`;
      vault.set(id, { plaintext: Buffer.from(cmd.input.Plaintext!), context: JSON.stringify(cmd.input.EncryptionContext) });
      return { CiphertextBlob: Buffer.from(id) };
    }
    const row = vault.get(Buffer.from(cmd.input.CiphertextBlob).toString());
    if (!row || row.context !== JSON.stringify(cmd.input.EncryptionContext)) throw new Error("InvalidCiphertextException");
    return { Plaintext: Buffer.from(row.plaintext) };
  });
});
afterEach(() => { handle.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const input = { email: "owner@example.test", name: "Owner", password: "test-password", role: "OWNER" as const };

describe("wallet persistence and migration", () => {
  it("persists ciphertext on password signup and never exposes it in publicUser", async () => {
    const { user } = await signup(handle, input);
    const [row] = await handle.db.select().from(users);
    expect(row!.custodialPrivateKey).toMatch(/^kms:v1:/);
    expect(publicUser(user)).not.toHaveProperty("custodialPrivateKey");
    const loggedIn = await login(handle, input.email, input.password);
    expect(loggedIn.user.walletAddress).toBe(user.walletAddress);
    expect(await unlockWalletKey(row!.custodialPrivateKey, row!.id, row!.walletAddress)).toMatch(/^0x/);
    await expect(unlockWalletKey(row!.custodialPrivateKey, "other-user", row!.walletAddress)).rejects.toThrow("decryption failed");
  });
  it("also protects new Google accounts", async () => {
    const result = await loginWithGoogle(handle, { supabaseId: "google-1", email: "google@example.test", name: "Google", avatarUrl: null }, "TENANT");
    expect(result).not.toHaveProperty("needsRole");
    const [row] = await handle.db.select().from(users);
    expect(row!.custodialPrivateKey).toMatch(/^kms:v1:/);
  });
  it("does not save an account if encryption fails", async () => {
    vi.spyOn(KMSClient.prototype, "send").mockRejectedValue(new Error("AccessDenied"));
    await expect(signup(handle, input)).rejects.toThrow("encryption failed");
    expect(await handle.db.select().from(users)).toHaveLength(0);
  });
  it("migrates legacy keys without changing wallet identity and can be rerun", async () => {
    vi.stubEnv("WALLET_KEY_PROTECTION", "local");
    const { user } = await signup(handle, input);
    vi.stubEnv("WALLET_KEY_PROTECTION", "kms");
    expect(await migrateWalletKeys(handle)).toEqual({ migrated: 1, alreadyEncrypted: 0 });
    expect(await migrateWalletKeys(handle)).toEqual({ migrated: 0, alreadyEncrypted: 1 });
    const [row] = await handle.db.select().from(users).where(eq(users.id, user.id));
    expect(row!.walletAddress).toBe(user.walletAddress);
    expect(await unlockWalletKey(row!.custodialPrivateKey, row!.id, row!.walletAddress)).toBe(user.custodialPrivateKey);
  });
  it("keeps the old row intact if migration verification fails", async () => {
    vi.stubEnv("WALLET_KEY_PROTECTION", "local");
    const { user } = await signup(handle, input);
    vi.stubEnv("WALLET_KEY_PROTECTION", "kms");
    vi.spyOn(KMSClient.prototype, "send").mockRejectedValue(new Error("AccessDenied"));
    await expect(migrateWalletKeys(handle)).rejects.toThrow();
    const [row] = await handle.db.select().from(users);
    expect(row!.custodialPrivateKey).toBe(user.custodialPrivateKey);
  });
});
