import { describe, it, expect } from "vitest";
import {
  applyFraction,
  formatPaise,
  rupees,
  depreciatedCeiling,
  computeDeterministicDeductions,
  applyAssessments,
  settleDeposit,
  type ClaimAssessment,
  type DeductionClaim,
  type InventoryItem,
  type TenancyFacts,
  type Severity,
} from "../src/index.js";

const DAY = 24 * 60 * 60 * 1000;

function item(over: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: "item-wall",
    category: "WALL",
    label: "Bedroom wall",
    ageMonths: 0,
    replacementCostPaise: rupees(12_000),
    conditionAtMoveIn: "NEW",
    photoSlots: ["wide", "detail"],
    ...over,
  };
}

function facts(over: Partial<TenancyFacts> = {}): TenancyFacts {
  const start = new Date("2025-01-01T00:00:00Z");
  return {
    terms: {
      id: "ag-1",
      rentPaise: rupees(15_000),
      depositPaise: rupees(45_000),
      noticeDays: 30,
      lateFeeRate: 0.02,
      startAt: start,
    },
    ledger: [],
    items: [item()],
    noticeGivenAt: null,
    moveOutAt: new Date("2025-07-01T00:00:00Z"),
    occupiedMonths: 6,
    ...over,
  };
}

function claim(over: Partial<DeductionClaim> = {}): DeductionClaim {
  return {
    id: "claim-1",
    itemId: "item-wall",
    claimText: "Large gouge in the plaster near the window.",
    moveInPhotoIds: ["p1"],
    moveOutPhotoIds: ["p2"],
    ...over,
  };
}

function assessment(over: Partial<ClaimAssessment> = {}): ClaimAssessment {
  return {
    claimId: "claim-1",
    damageConfirmed: true,
    fairWearAndTear: false,
    attributableToTenant: true,
    severity: "severe",
    recommendedFraction: 1,
    evidenceRefs: ["p1", "p2"],
    reasoning: "Gouge absent at move-in, present at move-out.",
    injectionSuspected: false,
    ...over,
  };
}

describe("money", () => {
  it("formats paise with Indian digit grouping", () => {
    expect(formatPaise(4_500_000n)).toBe("Rs 45,000.00");
    expect(formatPaise(100n)).toBe("Rs 1.00");
    expect(formatPaise(123_456_789n)).toBe("Rs 12,34,567.89");
    expect(formatPaise(0n)).toBe("Rs 0.00");
  });

  it("floors when applying a fraction, so it can never invent paise", () => {
    expect(applyFraction(999n, 0.5)).toBe(499n);
    expect(applyFraction(100n, 1)).toBe(100n);
    expect(applyFraction(100n, 0)).toBe(0n);
  });

  it("clamps out-of-range fractions rather than trusting them", () => {
    expect(applyFraction(1000n, 5)).toBe(1000n);
    expect(applyFraction(1000n, -3)).toBe(0n);
  });
});

describe("depreciation", () => {
  it("yields zero for an item at or past end of life", () => {
    // Wall repaint cycle is 36 months; 30 + 6 occupied = 36.
    expect(
      depreciatedCeiling({
        category: "WALL",
        ageMonthsAtMoveIn: 30,
        occupiedMonths: 6,
        replacementCostPaise: rupees(12_000),
        conditionAtMoveIn: "NEW",
      })
    ).toBe(0n);
  });

  it("scales with remaining life", () => {
    // 18 of 36 months consumed -> half the value left.
    expect(
      depreciatedCeiling({
        category: "WALL",
        ageMonthsAtMoveIn: 12,
        occupiedMonths: 6,
        replacementCostPaise: rupees(12_000),
        conditionAtMoveIn: "NEW",
      })
    ).toBe(rupees(6_000));
  });

  it("discounts items the tenant received already worn", () => {
    const asNew = depreciatedCeiling({
      category: "MATTRESS",
      ageMonthsAtMoveIn: 0,
      occupiedMonths: 12,
      replacementCostPaise: rupees(10_000),
      conditionAtMoveIn: "NEW",
    });
    const asWorn = depreciatedCeiling({
      category: "MATTRESS",
      ageMonthsAtMoveIn: 0,
      occupiedMonths: 12,
      replacementCostPaise: rupees(10_000),
      conditionAtMoveIn: "WORN",
    });
    expect(asWorn).toBeLessThan(asNew);
    expect(asWorn).toBe(applyFraction(asNew, 0.4));
  });
});

describe("deterministic deductions", () => {
  it("bills unpaid cycles as arrears", () => {
    const f = facts({
      ledger: [
        { cycleIndex: 1, dueAt: new Date("2025-01-01"), amountPaise: rupees(15_000), paidAt: new Date("2025-01-01") },
        { cycleIndex: 2, dueAt: new Date("2025-02-01"), amountPaise: rupees(15_000), paidAt: null },
      ],
    });
    const out = computeDeterministicDeductions(f);
    const arrears = out.find((d) => d.kind === "RENT_ARREARS");
    expect(arrears?.amountPaise).toBe(rupees(15_000));
  });

  it("charges notice shortfall pro-rata, and nothing when notice was adequate", () => {
    const short = computeDeterministicDeductions(
      facts({
        noticeGivenAt: new Date("2025-06-21T00:00:00Z"), // 10 days before move-out
        moveOutAt: new Date("2025-07-01T00:00:00Z"),
      })
    );
    const item = short.find((d) => d.kind === "NOTICE_SHORTFALL");
    expect(item).toBeDefined();
    // 20 days short of 30 -> 20/30 of a month's rent.
    expect(item!.amountPaise).toBe(applyFraction(rupees(15_000), 20 / 30));

    const adequate = computeDeterministicDeductions(
      facts({
        noticeGivenAt: new Date("2025-05-01T00:00:00Z"),
        moveOutAt: new Date("2025-07-01T00:00:00Z"),
      })
    );
    expect(adequate.find((d) => d.kind === "NOTICE_SHORTFALL")).toBeUndefined();
  });

  it("reports nothing for a clean tenancy", () => {
    expect(computeDeterministicDeductions(facts())).toEqual([]);
  });
});

describe("bounding the adjudicator", () => {
  it("zeroes a claim assessed as fair wear and tear", () => {
    const [line] = applyAssessments(facts(), [claim()], [assessment({ fairWearAndTear: true })]);
    expect(line!.allowedPaise).toBe(0n);
    expect(line!.adjustments.join(" ")).toContain("fair wear and tear");
  });

  it("zeroes a claim not attributable to the tenant", () => {
    const [line] = applyAssessments(
      facts(),
      [claim()],
      [assessment({ attributableToTenant: false })]
    );
    expect(line!.allowedPaise).toBe(0n);
  });

  it("zeroes a claim where damage was never confirmed", () => {
    const [line] = applyAssessments(facts(), [claim()], [assessment({ damageConfirmed: false })]);
    expect(line!.allowedPaise).toBe(0n);
  });

  it("caps a minor finding at 15% however confident the model was", () => {
    const [line] = applyAssessments(
      facts(),
      [claim()],
      [assessment({ severity: "minor", recommendedFraction: 1 })]
    );
    expect(line!.appliedFraction).toBe(0.15);
    // Wall: 6 of 36 months consumed -> exactly 30/36 of Rs 12,000 remains.
    expect(line!.ceilingPaise).toBe(rupees(10_000));
    expect(line!.allowedPaise).toBe(applyFraction(rupees(10_000), 0.15));
  });

  it("awards nothing on a dead item even at maximum severity", () => {
    const f = facts({ items: [item({ ageMonths: 40 })] });
    const [line] = applyAssessments(f, [claim()], [assessment()]);
    expect(line!.ceilingPaise).toBe(0n);
    expect(line!.allowedPaise).toBe(0n);
  });

  it("disallows a claim the adjudicator never returned an assessment for", () => {
    const [line] = applyAssessments(facts(), [claim()], []);
    expect(line!.allowedPaise).toBe(0n);
    expect(line!.adjustments.join(" ")).toContain("No assessment returned");
  });

  it("ignores an out-of-range fraction instead of trusting it", () => {
    const [line] = applyAssessments(
      facts(),
      [claim()],
      [assessment({ recommendedFraction: 99 })]
    );
    expect(line!.appliedFraction).toBe(1);
    expect(line!.allowedPaise).toBeLessThanOrEqual(line!.ceilingPaise);
  });

  it("throws on a claim pointing at an item that does not exist", () => {
    expect(() =>
      applyAssessments(facts(), [claim({ itemId: "ghost" })], [assessment()])
    ).toThrow(/unknown item/);
  });
});

describe("settlement conservation", () => {
  it("clamps deductions to the deposit and never exceeds it", () => {
    const f = facts({
      items: [item({ replacementCostPaise: rupees(500_000) })],
      terms: { ...facts().terms, depositPaise: rupees(45_000) },
    });
    const s = settleDeposit(f, [claim()], [assessment()]);
    expect(s.clamped).toBe(true);
    expect(s.toOwnerPaise).toBe(rupees(45_000));
    expect(s.toTenantPaise).toBe(0n);
  });

  it("returns the whole deposit when every claim fails", () => {
    const s = settleDeposit(facts(), [claim()], [assessment({ fairWearAndTear: true })]);
    expect(s.toOwnerPaise).toBe(0n);
    expect(s.toTenantPaise).toBe(rupees(45_000));
  });

  // The property the on-chain invariant mirrors: whatever the model says, the
  // two sides of the split always add back up to exactly the deposit.
  it("conserves the deposit exactly across 2000 randomised assessments", () => {
    const severities: Severity[] = ["none", "minor", "moderate", "severe"];
    let seed = 20260920;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let i = 0; i < 2000; i++) {
      const nItems = 1 + Math.floor(rand() * 4);
      const items: InventoryItem[] = [];
      const claims: DeductionClaim[] = [];
      const assessments: ClaimAssessment[] = [];

      for (let k = 0; k < nItems; k++) {
        const id = `i${k}`;
        items.push(
          item({
            id,
            ageMonths: Math.floor(rand() * 60),
            replacementCostPaise: BigInt(Math.floor(rand() * 5_000_00)),
          })
        );
        claims.push(claim({ id: `c${k}`, itemId: id }));
        assessments.push(
          assessment({
            claimId: `c${k}`,
            severity: severities[Math.floor(rand() * 4)]!,
            // Deliberately includes out-of-range and non-finite values.
            recommendedFraction: rand() < 0.1 ? (rand() < 0.5 ? -2 : 7) : rand(),
            damageConfirmed: rand() > 0.2,
            fairWearAndTear: rand() < 0.2,
            attributableToTenant: rand() > 0.2,
          })
        );
      }

      const deposit = BigInt(Math.floor(rand() * 10_000_00));
      const f = facts({ items, terms: { ...facts().terms, depositPaise: deposit } });
      const s = settleDeposit(f, claims, assessments);

      expect(s.toOwnerPaise + s.toTenantPaise).toBe(deposit);
      expect(s.toOwnerPaise).toBeGreaterThanOrEqual(0n);
      expect(s.toTenantPaise).toBeGreaterThanOrEqual(0n);
      expect(s.toOwnerPaise).toBeLessThanOrEqual(deposit);
      for (const line of s.adjudicated) {
        expect(line.allowedPaise).toBeLessThanOrEqual(line.ceilingPaise);
      }
    }
  });
});
