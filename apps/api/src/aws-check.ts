import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadEnv } from "./env.js";
import { protectWalletKey, unlockWalletKey, walletProtection } from "./kms.js";
import { readStored, storeDataUrl } from "./storage.js";

loadEnv();
try {
  if (walletProtection() !== "kms") throw new Error("Configure KMS before running this check");
  const key = generatePrivateKey();
  const encrypted = await protectWalletKey(key, "aws-setup-check");
  const recovered = await unlockWalletKey(encrypted, "aws-setup-check", privateKeyToAccount(key).address);
  if (recovered !== key) throw new Error("KMS round-trip mismatch");
  console.log("PASS: KMS Encrypt/Decrypt with wallet encryption context");
  if (process.env.AWS_S3_BUCKET) {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
    const stored = await storeDataUrl(`data:image/png;base64,${png}`);
    const read = await readStored(stored.storageKey);
    if (!read?.equals(Buffer.from(png, "base64"))) throw new Error("S3 round-trip mismatch");
    console.log("PASS: S3 SSE-KMS upload/read");
    console.log(`Remove the tiny test object in S3 when finished: evidence/${stored.storageKey.slice(3)}`);
  } else console.log("SKIP: S3 (AWS_S3_BUCKET is not set)");
} catch (error) {
  console.error(error instanceof Error ? error.message : "AWS check failed");
  process.exitCode = 1;
}
