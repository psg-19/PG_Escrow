import { and, eq } from "drizzle-orm";
import { users, type DbHandle } from "@pg/db";
import { isProtectedKey, protectWalletKey, unlockWalletKey, walletProtection } from "./kms.js";

/** Resumable: verify each ciphertext before replacing the plaintext row. */
export async function migrateWalletKeys(handle: DbHandle) {
  if (walletProtection() !== "kms") throw new Error("Enable KMS before migrating wallets");
  let migrated = 0;
  let alreadyEncrypted = 0;
  const rows = await handle.db.select().from(users);
  for (const row of rows) {
    if (isProtectedKey(row.custodialPrivateKey)) {
      await unlockWalletKey(row.custodialPrivateKey, row.id, row.walletAddress);
      alreadyEncrypted++;
      continue;
    }
    const encrypted = await protectWalletKey(row.custodialPrivateKey, row.id);
    await unlockWalletKey(encrypted, row.id, row.walletAddress);
    const changed = await handle.db.update(users).set({ custodialPrivateKey: encrypted })
      .where(and(eq(users.id, row.id), eq(users.custodialPrivateKey, row.custodialPrivateKey)))
      .returning({ id: users.id });
    migrated += changed.length;
  }
  return { migrated, alreadyEncrypted };
}
