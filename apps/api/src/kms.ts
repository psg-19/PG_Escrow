import { DecryptCommand, EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { privateKeyToAccount } from "viem/accounts";
import { chainProfile } from "./chains.js";
import type { Hex } from "viem";

const PREFIX = "kms:v1:";
export class KeyProtectionError extends Error {}

export function walletProtection(): "kms" | "local" {
  const mode = process.env.WALLET_KEY_PROTECTION || (process.env.AWS_KMS_KEY_ID ? "kms" : "local");
  if (mode !== "kms" && mode !== "local") throw new KeyProtectionError("Invalid WALLET_KEY_PROTECTION");
  if (mode === "local" && (process.env.NODE_ENV === "production" ||
      !chainProfile().isLocal)) {
    throw new KeyProtectionError("KMS wallet protection is required outside local development");
  }
  if (mode === "kms" && (!process.env.AWS_REGION || !process.env.AWS_KMS_KEY_ID)) {
    throw new KeyProtectionError("Set AWS_REGION and AWS_KMS_KEY_ID for KMS wallet protection");
  }
  return mode;
}

export function isProtectedKey(value: string): boolean {
  return value.startsWith(PREFIX);
}

function context(userId: string) {
  // Context is logged by AWS. Use an opaque ID, never email or private material.
  return { application: "pg-escrow", purpose: "custodial-wallet", userId };
}

function validateKey(value: string): asserts value is Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new KeyProtectionError("Invalid wallet key format");
  try { privateKeyToAccount(value as Hex); }
  catch { throw new KeyProtectionError("Invalid wallet key"); }
}

export async function protectWalletKey(privateKey: string, userId: string): Promise<string> {
  validateKey(privateKey);
  if (walletProtection() === "local") return privateKey;
  const plaintext = Buffer.from(privateKey, "utf8");
  const client = new KMSClient({ region: process.env.AWS_REGION, maxAttempts: 3 });
  try {
    const result = await client.send(new EncryptCommand({
      KeyId: process.env.AWS_KMS_KEY_ID,
      EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
      EncryptionContext: context(userId),
      Plaintext: plaintext,
    }));
    if (!result.CiphertextBlob?.length) throw new Error("Empty KMS result");
    return PREFIX + Buffer.from(result.CiphertextBlob).toString("base64");
  } catch {
    // Never fall back to plaintext when AWS is unavailable or permission is denied.
    throw new KeyProtectionError("Wallet encryption failed. Check KMS configuration and permissions.");
  } finally {
    plaintext.fill(0);
    client.destroy();
  }
}

export async function unlockWalletKey(stored: string, userId: string, walletAddress: string): Promise<Hex> {
  const mode = walletProtection();
  let privateKey: string;
  if (!isProtectedKey(stored)) {
    if (mode === "kms") throw new KeyProtectionError("Legacy wallet needs migration: run npm run aws:migrate-wallets");
    privateKey = stored;
  } else {
    if (mode !== "kms") throw new KeyProtectionError("Encrypted wallets require KMS configuration");
    const encoded = stored.slice(PREFIX.length);
    if (!encoded || encoded.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new KeyProtectionError("Invalid encrypted wallet format");
    }
    const client = new KMSClient({ region: process.env.AWS_REGION, maxAttempts: 3 });
    try {
      const result = await client.send(new DecryptCommand({
        KeyId: process.env.AWS_KMS_KEY_ID,
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        EncryptionContext: context(userId),
        CiphertextBlob: Buffer.from(encoded, "base64"),
      }));
      if (!result.Plaintext?.length) throw new Error("Empty KMS result");
      try { privateKey = Buffer.from(result.Plaintext).toString("utf8"); }
      finally { result.Plaintext.fill(0); }
    } catch {
      throw new KeyProtectionError("Wallet decryption failed. Check KMS configuration and permissions.");
    } finally { client.destroy(); }
  }
  validateKey(privateKey);
  if (privateKeyToAccount(privateKey).address.toLowerCase() !== walletAddress.toLowerCase()) {
    throw new KeyProtectionError("Wallet key does not match the account address");
  }
  return privateKey;
}
