import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";

/** S3 with SSE-KMS for AWS deployments; legacy Supabase/disk remains readable.
 * New S3 rows carry an s3: prefix, so changing backends never misroutes old rows.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const UPLOADS = resolve(REPO_ROOT, "uploads");

const EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export interface StoredImage {
  storageKey: string;
  sha256: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  bytes: number;
}

export class UnsupportedImageError extends Error {}

function bucket(): string | null {
  const name = process.env.SUPABASE_STORAGE_BUCKET;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return name && url && key ? name : null;
}

function awsStorage() {
  const name = process.env.AWS_S3_BUCKET;
  if (!name) return null;
  const region = process.env.AWS_REGION;
  const keyId = process.env.AWS_S3_KMS_KEY_ID || process.env.AWS_KMS_KEY_ID;
  if (!region || !keyId) throw new Error("S3 requires AWS_REGION and a KMS key ID");
  return { name, region, keyId };
}

export function storageBackend(): "s3" | "supabase" | "disk" {
  return awsStorage() ? "s3" : bucket() ? "supabase" : "disk";
}

export function describeStorage(): string {
  const aws = awsStorage();
  if (aws) return `Photo storage: private S3 bucket "${aws.name}" with SSE-KMS`;
  return bucket()
    ? `Photo storage: Supabase bucket "${bucket()}"`
    : `Photo storage: local disk (${UPLOADS}) — ephemeral, do not deploy like this`;
}

/** Decodes and validates an upload, independent of where it will be written. */
function decode(dataUrl: string): { bytes: Buffer; mediaType: string; sha256: string } {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) throw new UnsupportedImageError("Expected a base64 data URL");

  const mediaType = match[1]!;
  if (!(mediaType in EXT)) {
    throw new UnsupportedImageError(`Unsupported image type ${mediaType}. Use JPEG, PNG or WebP.`);
  }

  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length === 0) throw new UnsupportedImageError("Empty image");
  if (bytes.length > 8 * 1024 * 1024) {
    throw new UnsupportedImageError("Image is larger than 8MB");
  }

  // Hashed as received, before anything else touches the bytes — this is what
  // the Merkle root commits to, so it has to be the actual file.
  return { bytes, mediaType, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function storeDataUrl(dataUrl: string): Promise<StoredImage> {
  const { bytes, mediaType, sha256 } = decode(dataUrl);
  const storageKey = `${randomUUID()}${EXT[mediaType]}`;

  const aws = awsStorage();
  if (aws) {
    const client = new S3Client({ region: aws.region, maxAttempts: 3 });
    try {
      await client.send(new PutObjectCommand({
        Bucket: aws.name,
        Key: `evidence/${storageKey}`,
        Body: bytes,
        ContentType: mediaType,
        ServerSideEncryption: "aws:kms",
        SSEKMSKeyId: aws.keyId,
        BucketKeyEnabled: true,
        Metadata: { sha256 },
      }));
    } catch { throw new Error("Could not store photograph in S3. Check AWS configuration and permissions."); }
    finally { client.destroy(); }
    return { storageKey: `s3:${storageKey}`, sha256, mediaType: mediaType as StoredImage["mediaType"], bytes: bytes.length };
  }
  const name = bucket();
  if (name) {
    const res = await fetch(
      `${process.env.SUPABASE_URL!.replace(/\/$/, "")}/storage/v1/object/${name}/${storageKey}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": mediaType,
          "x-upsert": "false",
        },
        body: new Uint8Array(bytes),
      }
    );
    if (!res.ok) {
      throw new Error(`Could not store the photograph: ${res.status} ${await res.text()}`);
    }
  } else {
    mkdirSync(UPLOADS, { recursive: true });
    writeFileSync(resolve(UPLOADS, storageKey), bytes);
  }

  return { storageKey, sha256, mediaType: mediaType as StoredImage["mediaType"], bytes: bytes.length };
}

function safeKey(storageKey: string): boolean {
  return !(
    storageKey.includes("/") ||
    storageKey.includes("\\") ||
    storageKey.includes("..")
  );
}

export async function readStored(storageKey: string): Promise<Buffer | null> {
  if (storageKey.startsWith("s3:")) {
    const key = storageKey.slice(3);
    if (!safeKey(key) || !/^[0-9a-f-]+\.(jpg|png|webp)$/.test(key)) return null;
    const aws = awsStorage();
    if (!aws) throw new Error("S3 is required to read this photograph");
    const client = new S3Client({ region: aws.region, maxAttempts: 3 });
    try {
      const result = await client.send(new GetObjectCommand({ Bucket: aws.name, Key: `evidence/${key}` }));
      if (!result.Body) throw new Error("Empty S3 response");
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if (error instanceof Error && error.name === "NoSuchKey") return null;
      throw new Error("Could not read photograph from S3. Check AWS configuration and permissions.");
    } finally { client.destroy(); }
  }
  if (!safeKey(storageKey)) return null;

  const name = bucket();
  if (name) {
    const res = await fetch(
      `${process.env.SUPABASE_URL!.replace(/\/$/, "")}/storage/v1/object/${name}/${storageKey}`,
      { headers: { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }

  const path = resolve(UPLOADS, storageKey);
  if (!path.startsWith(UPLOADS) || !existsSync(path)) return null;
  return readFileSync(path);
}

export function mediaTypeOf(storageKey: string): string {
  const ext = extname(storageKey);
  return Object.entries(EXT).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
}

/** For handing a photograph to the vision model. */
export async function readAsBase64(
  storageKey: string
): Promise<{ data: string; mediaType: string } | null> {
  const bytes = await readStored(storageKey);
  if (!bytes) return null;
  return { data: bytes.toString("base64"), mediaType: mediaTypeOf(storageKey) };
}
