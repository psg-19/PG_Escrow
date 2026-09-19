import { describe, it, expect } from "vitest";
import { nextRentCycle, RENT_CYCLE_DAYS, RENT_GRACE_DAYS } from "../src/writes.js";

const DAY = 24 * 60 * 60 * 1000;
const RENT = "1500000"; // Rs 15,000

function paidAt(offsetDays: number, cycleIndex: number) {
  const at = new Date(Date.UTC(2026, 0, 1) + offsetDays * DAY);
  return { cycleIndex, paidAt: at, dueAt: at };
}

const NOW = (offsetDays: number) => new Date(Date.UTC(2026, 0, 1) + offsetDays * DAY);

describe("rent cycles", () => {
  it("lets a brand-new tenancy pay immediately", () => {
    const c = nextRentCycle([], RENT, NOW(0));
    expect(c.index).toBe(1);
    expect(c.payable).toBe(true);
  });

  it("refuses a second payment on the same day", () => {
    const c = nextRentCycle([paidAt(0, 1)], RENT, NOW(0));
    expect(c.payable).toBe(false);
    expect(c.index).toBe(2);
    expect(c.reason).toMatch(/paid up to/i);
  });

  // The bug: the button stayed live, so rent could be paid repeatedly for the
  // same month and the money went into escrow with nothing to show for it.
  it("stays refused right through the paid period", () => {
    const ledger = [paidAt(0, 1)];
    for (const day of [1, 5, 14, 20, 27]) {
      const c = nextRentCycle(ledger, RENT, NOW(day));
      expect(c.payable, `day ${day} should not be payable`).toBe(false);
    }
  });

  it("opens the next cycle two days before cover runs out", () => {
    const ledger = [paidAt(0, 1)];
    const opensOn = RENT_CYCLE_DAYS - RENT_GRACE_DAYS; // day 28

    expect(nextRentCycle(ledger, RENT, NOW(opensOn - 1)).payable).toBe(false);
    expect(nextRentCycle(ledger, RENT, NOW(opensOn)).payable).toBe(true);
    expect(nextRentCycle(ledger, RENT, NOW(opensOn + 5)).payable).toBe(true);
  });

  it("counts down the days remaining", () => {
    const ledger = [paidAt(0, 1)];
    expect(nextRentCycle(ledger, RENT, NOW(0)).daysUntilDue).toBe(28);
    expect(nextRentCycle(ledger, RENT, NOW(20)).daysUntilDue).toBe(8);
    expect(nextRentCycle(ledger, RENT, NOW(28)).daysUntilDue).toBe(0);
  });

  it("advances the cycle index with each payment", () => {
    const ledger = [paidAt(0, 1), paidAt(30, 2), paidAt(60, 3)];
    const c = nextRentCycle(ledger, RENT, NOW(88));
    expect(c.index).toBe(4);
    expect(c.payable).toBe(true);
  });

  it("measures from the latest payment, not the first", () => {
    // Out of order on purpose: the rule must sort, not trust insertion order.
    const ledger = [paidAt(30, 2), paidAt(0, 1)];
    const c = nextRentCycle(ledger, RENT, NOW(45));
    expect(c.index).toBe(3);
    expect(c.payable).toBe(false);
  });

  it("ignores unpaid rows when working out cover", () => {
    const ledger = [
      paidAt(0, 1),
      { cycleIndex: 2, paidAt: null, dueAt: NOW(30) },
    ];
    const c = nextRentCycle(ledger, RENT, NOW(10));
    expect(c.payable).toBe(false);
    expect(c.index).toBe(2);
  });

  it("reports a cover window exactly one cycle long", () => {
    const c = nextRentCycle([paidAt(0, 1)], RENT, NOW(29));
    const span = (c.coversUntil.getTime() - c.dueAt.getTime()) / DAY;
    expect(span).toBe(RENT_CYCLE_DAYS);
  });
});
