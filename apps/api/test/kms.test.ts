import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KMSClient, EncryptCommand, DecryptCommand } from "@aws-sdk/client-kms";
import { privateKeyToAccount } from "viem/accounts";
import { protectWalletKey, unlockWalletKey, walletProtection } from "../src/kms.js";

const key = `0x${"11".repeat(32)}` as const;
const address = privateKeyToAccount(key).address;

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("CHAIN", "localhost");
  vi.stubEnv("WALLET_KEY_PROTECTION", "kms");
  vi.stubEnv("AWS_REGION", "ap-south-1");
  vi.stubEnv("AWS_KMS_KEY_ID", "test-key");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("KMS wallet protection", () => {
  it("binds encryption and decryption to the user and purpose", async () => {
    const send = vi.spyOn(KMSClient.prototype, "send");
    send.mockImplementation(async (cmd: any) => {
      expect(cmd.input.KeyId).toBe("test-key");
      expect(cmd.input.EncryptionContext).toEqual({ application: "pg-escrow", purpose: "custodial-wallet", userId: "usr-1" });
      if (cmd instanceof EncryptCommand) {
        expect(Buffer.from(cmd.input.Plaintext!).toString()).toBe(key);
        return { CiphertextBlob: Buffer.from("opaque-ciphertext") };
      }
      expect(cmd).toBeInstanceOf(DecryptCommand);
      return { Plaintext: Buffer.from(key) };
    });
    const stored = await protectWalletKey(key, "usr-1");
    expect(stored).toMatch(/^kms:v1:/);
    expect(stored).not.toContain(key);
    expect(await unlockWalletKey(stored, "usr-1", address)).toBe(key);
  });
  it("fails closed when KMS denies encryption", async () => {
    vi.spyOn(KMSClient.prototype, "send").mockRejectedValue(new Error("AccessDenied"));
    await expect(protectWalletKey(key, "usr-1")).rejects.toThrow("encryption failed");
  });
  it("rejects tampered ciphertext or a changed encryption context", async () => {
    vi.spyOn(KMSClient.prototype, "send").mockRejectedValue(new Error("InvalidCiphertextException"));
    await expect(unlockWalletKey("kms:v1:YWJj", "other-user", address)).rejects.toThrow("decryption failed");
  });
  it("rejects an otherwise valid key for a different wallet", async () => {
    vi.spyOn(KMSClient.prototype, "send").mockResolvedValue({ Plaintext: Buffer.from(key) } as never);
    await expect(unlockWalletKey("kms:v1:YWJj", "usr-1", "0x0000000000000000000000000000000000000000")).rejects.toThrow("does not match");
  });
  it("requires migration of legacy plaintext in KMS mode", async () => {
    await expect(unlockWalletKey(key, "usr-1", address)).rejects.toThrow("migration");
  });
  it("requires the region and key, without silently changing modes", () => {
    vi.stubEnv("AWS_REGION", "");
    expect(walletProtection).toThrow("AWS_REGION");
  });
  it("permits plaintext only for local development", async () => {
    vi.stubEnv("WALLET_KEY_PROTECTION", "local");
    expect(await protectWalletKey(key, "usr-1")).toBe(key);
    expect(await unlockWalletKey(key, "usr-1", address)).toBe(key);
    vi.stubEnv("CHAIN", "baseSepolia");
    expect(walletProtection).toThrow("required outside");
    vi.stubEnv("CHAIN", "localhost");
    vi.stubEnv("NODE_ENV", "production");
    expect(walletProtection).toThrow("required outside");
  });
  it("does not treat unknown ciphertext versions as private keys", async () => {
    vi.stubEnv("WALLET_KEY_PROTECTION", "local");
    await expect(unlockWalletKey("kms:v2:abc", "usr-1", address)).rejects.toThrow("format");
  });
});
