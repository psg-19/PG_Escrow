import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rupees } from "@pg/core";
import {
  agreements,
  createDb,
  migrate,
  reset,
  toTenancyFacts,
  toItem,
  toPhoto,
  defaultDbUrl,
  type DbHandle,
} from "../src/index.js";

let handle: DbHandle;

beforeEach(async () => {
  handle = createDb("file::memory:");
  await migrate(handle);
});

afterEach(() => {
  handle.close();
});

const ROW = {
  id: "ag-1",
  chainId: "0xabc",
  tenantAddress: "0x1",
  ownerAddress: "0x2",
  tenantName: "Ananya",
  ownerName: "Suresh",
  propertyLabel: "Room 3B",
  roomId: null,
  rentPaise: rupees(15_000).toString(),
  depositPaise: rupees(45_000).toString(),
  noticeDays: 30,
  lateFeeRateBps: 200,
  state: "ACTIVE" as const,
  moveInRoot: null,
  moveOutRoot: null,
  startAt: new Date("2025-04-01T00:00:00Z"),
  noticeGivenAt: null,
  moveOutAt: new Date("2025-07-01T00:00:00Z"),
  createdAt: new Date("2025-04-01T00:00:00Z"),
};

describe("schema", () => {
  it("creates every table the app reads", async () => {
    const res = await handle.client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    );
    const names = res.rows.map((r) => String(r.name)).filter((n) => !n.startsWith("sqlite_"));
    expect(names).toEqual([
      "agreements",
      "claims",
      "deployments",
      "disputes",
      "inventory_items",
      "ledger_entries",
      "listings",
      "photos",
      "rebuttals",
      "rental_requests",
      "rooms",
      "sessions",
      "users",
      "verdicts",
    ]);
  });

  it("is idempotent, so a second startup does not fail", async () => {
    await expect(migrate(handle)).resolves.toBeUndefined();
  });

  it("drops and recreates on reset", async () => {
    await handle.db.insert(agreements).values(ROW);
    await reset(handle);
    const rows = await handle.db.select().from(agreements);
    expect(rows).toEqual([]);
  });
});

describe("money storage", () => {
  // Money is stored as TEXT precisely so it can round-trip through BigInt. A
  // JS number would silently lose precision above 2^53, and the whole codebase
  // depends on this boundary not doing that.
  it("round-trips paise through text without loss", async () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1 — unrepresentable as a double
    await handle.db.insert(agreements).values({ ...ROW, depositPaise: huge.toString() });

    const [back] = await handle.db.select().from(agreements);

    // Exact through BigInt...
    expect(BigInt(back!.depositPaise)).toBe(huge);
    // ...and demonstrably lossy through a double, which is why the column is TEXT.
    expect(BigInt(Number(back!.depositPaise))).not.toBe(huge);
    expect(BigInt(Number(back!.depositPaise))).toBe(huge - 1n);
  });

  it("keeps ordinary amounts exact", async () => {
    await handle.db.insert(agreements).values(ROW);
    const [back] = await handle.db.select().from(agreements);
    expect(BigInt(back!.rentPaise)).toBe(rupees(15_000));
    expect(BigInt(back!.depositPaise)).toBe(rupees(45_000));
  });
});

describe("mappers", () => {
  it("derives occupied months from the real dates", () => {
    const facts = toTenancyFacts({
      agreement: {
        id: "ag-1",
        rentPaise: rupees(15_000).toString(),
        depositPaise: rupees(45_000).toString(),
        noticeDays: 30,
        lateFeeRateBps: 200,
        startAt: new Date("2025-01-01T00:00:00Z"),
        noticeGivenAt: null,
        moveOutAt: new Date("2025-07-01T00:00:00Z"),
      },
      items: [],
      ledger: [],
    });
    // Six calendar months; the mapper uses 30-day months, so it rounds to 6.
    expect(facts.occupiedMonths).toBe(6);
    expect(facts.terms.depositPaise).toBe(rupees(45_000));
    expect(facts.terms.lateFeeRate).toBe(0.02);
  });

  it("never reports negative occupancy", () => {
    const facts = toTenancyFacts({
      agreement: {
        id: "ag-1",
        rentPaise: "0",
        depositPaise: "0",
        noticeDays: 30,
        lateFeeRateBps: 0,
        startAt: new Date("2025-07-01T00:00:00Z"),
        noticeGivenAt: null,
        moveOutAt: new Date("2025-01-01T00:00:00Z"), // before it started
      },
      items: [],
      ledger: [],
    });
    expect(facts.occupiedMonths).toBe(0);
  });

  it("parses JSON columns back into domain shapes", () => {
    const item = toItem({
      id: "i1",
      category: "MATTRESS",
      label: "Single mattress",
      ageMonths: 12,
      replacementCostPaise: rupees(10_000).toString(),
      conditionAtMoveIn: "GOOD",
      photoSlots: JSON.stringify(["top", "side"]),
    });
    expect(item.photoSlots).toEqual(["top", "side"]);
    expect(item.replacementCostPaise).toBe(rupees(10_000));

    const photo = toPhoto({
      id: "p1",
      itemId: "i1",
      slot: "top",
      stage: "MOVE_IN",
      sha256: "a".repeat(64),
      capturedAt: new Date("2025-04-01T00:00:00Z"),
      capturedBy: "tenant",
      pose: JSON.stringify({ alpha: 90, beta: 0, gamma: 0, frame: { x: 0, y: 0, w: 1, h: 1 } }),
      storageKey: "s3://x",
    });
    expect(photo.pose.alpha).toBe(90);
    expect(photo.pose.frame.w).toBe(1);
  });
});

describe("default database location", () => {
  it("resolves to an absolute path, not one relative to cwd", () => {
    const url = defaultDbUrl();
    expect(url.startsWith("file:/")).toBe(true);
    expect(url).toContain("pg-escrow.db");
  });
});
