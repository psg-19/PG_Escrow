import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { storeDataUrl, readStored, mediaTypeOf } from "../src/storage.js";

beforeEach(() => {
  vi.stubEnv("AWS_REGION", "ap-south-1");
  vi.stubEnv("AWS_S3_BUCKET", "test-private-bucket");
  vi.stubEnv("AWS_KMS_KEY_ID", "test-key");
  vi.stubEnv("AWS_S3_KMS_KEY_ID", "");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("S3 SSE-KMS photo storage", () => {
  it("preserves the evidence bytes and SHA256 across encrypted storage", async () => {
    const bytes = Buffer.from("photo-fixture");
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (cmd: any) => {
      expect(cmd.input.Bucket).toBe("test-private-bucket");
      expect(cmd.input.Key).toMatch(/^evidence\//);
      if (cmd instanceof PutObjectCommand) {
        expect(cmd.input.ServerSideEncryption).toBe("aws:kms");
        expect(cmd.input.SSEKMSKeyId).toBe("test-key");
        expect(cmd.input.BucketKeyEnabled).toBe(true);
        expect(cmd.input.Body).toEqual(bytes);
        return {};
      }
      expect(cmd).toBeInstanceOf(GetObjectCommand);
      return { Body: { transformToByteArray: async () => bytes } };
    });
    const stored = await storeDataUrl(`data:image/png;base64,${bytes.toString("base64")}`);
    expect(stored.storageKey).toMatch(/^s3:/);
    expect(stored.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(await readStored(stored.storageKey)).toEqual(bytes);
    expect(mediaTypeOf(stored.storageKey)).toBe("image/png");
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("does not fall back to another backend when S3 fails", async () => {
    vi.spyOn(S3Client.prototype, "send").mockRejectedValue(new Error("AccessDenied"));
    await expect(storeDataUrl("data:image/png;base64,YWJj")).rejects.toThrow("Could not store");
    await expect(readStored("s3:abc.png")).rejects.toThrow("Could not read");
  });
  it("distinguishes missing objects from permission failures", async () => {
    const error = new Error("missing"); error.name = "NoSuchKey";
    vi.spyOn(S3Client.prototype, "send").mockRejectedValue(error);
    expect(await readStored("s3:abc.png")).toBeNull();
  });
  it("blocks traversal before calling AWS", async () => {
    const send = vi.spyOn(S3Client.prototype, "send");
    expect(await readStored("s3:../secret.png")).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects missing KMS configuration", async () => {
    vi.stubEnv("AWS_KMS_KEY_ID", "");
    await expect(storeDataUrl("data:image/png;base64,YWJj")).rejects.toThrow("S3 requires");
  });
});
