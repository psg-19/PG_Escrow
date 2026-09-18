import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, migrate, agreements, photos, type DbHandle } from "@pg/db";
import { signup } from "../src/auth.js";
import { createApp } from "../src/app.js";
import * as storage from "../src/storage.js";

let handle: DbHandle;
let ownerToken: string;
let tenantToken: string;
let outsiderToken: string;
beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("CHAIN", "localhost"); vi.stubEnv("WALLET_KEY_PROTECTION", "local");
  handle = createDb("file::memory:"); await migrate(handle);
  const owner = await signup(handle, { email: "owner@example.test", name: "Owner", password: "test-password", role: "OWNER" });
  const tenant = await signup(handle, { email: "tenant@example.test", name: "Tenant", password: "test-password", role: "TENANT" });
  const outsider = await signup(handle, { email: "other@example.test", name: "Other", password: "test-password", role: "TENANT" });
  ownerToken = owner.token; tenantToken = tenant.token; outsiderToken = outsider.token;
  await handle.db.insert(agreements).values({ id: "agreement-1", chainId: "0x01", ownerAddress: owner.user.walletAddress, tenantAddress: tenant.user.walletAddress, ownerName: "Owner", tenantName: "Tenant", propertyLabel: "Room", rentPaise: "100", depositPaise: "200", noticeDays: 30, lateFeeRateBps: 0, createdAt: new Date() });
  await handle.db.insert(photos).values({ id: "photo-1", agreementId: "agreement-1", itemId: "item-1", slot: "front", stage: "MOVE_IN", sha256: "abc", storageKey: "s3:abc.png", mediaType: "image/png", capturedAt: new Date(), capturedBy: tenant.user.walletAddress, pose: "{}" });
  vi.spyOn(storage, "readStored").mockResolvedValue(Buffer.from("photo"));
});
afterEach(() => { handle.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function request(token?: string) {
  return createApp(handle).request("/api/photos/photo-1/file", { headers: token ? { Cookie: `pg_session=${token}` } : {} });
}
describe("private evidence endpoint", () => {
  it("requires sign-in before accessing storage", async () => {
    expect((await request()).status).toBe(401);
    expect(storage.readStored).not.toHaveBeenCalled();
  });
  it("rejects authenticated users outside the tenancy", async () => {
    expect((await request(outsiderToken)).status).toBe(403);
    expect(storage.readStored).not.toHaveBeenCalled();
  });
  it("serves both parties without public caching", async () => {
    for (const token of [ownerToken, tenantToken]) {
      const response = await request(token);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).toBe("photo");
    }
  });
});
