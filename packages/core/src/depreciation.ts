import { type Paise } from "./money.js";
import type { Condition, ItemCategory, Severity } from "./types.js";

/**
 * Straight-line useful life by category, in months.
 *
 * These are the numbers the whole fairness argument rests on, so they are
 * published, versioned, and visible to the owner *before* they file a claim.
 * An owner who can see that a 6-year-old mattress yields a zero ceiling mostly
 * doesn't bother filing.
 */
export const USEFUL_LIFE_MONTHS: Record<ItemCategory, number> = {
  WALL: 36, // repaint cycle
  MATTRESS: 60,
  GEYSER: 84,
  AC: 120,
  DOOR: 180,
  WINDOW: 180,
  FURNITURE: 96,
  BATHROOM_FITTING: 120,
  FLOORING: 180,
};

/**
 * Severity ceiling: how much of an item's remaining value a given severity can
 * justify. A scuff cannot bill a whole wall no matter how the claim is worded.
 */
export const SEVERITY_CAP: Record<Severity, number> = {
  none: 0,
  minor: 0.15,
  moderate: 0.5,
  severe: 1.0,
};

/**
 * Items already worn at move-in start with less recoverable value — the tenant
 * did not receive a pristine item and cannot be billed as if they had.
 */
export const CONDITION_MULTIPLIER: Record<Condition, number> = {
  NEW: 1.0,
  GOOD: 0.9,
  FAIR: 0.7,
  WORN: 0.4,
};

export const DEPRECIATION_SCHEDULE_VERSION = "2026-09-v1";

/**
 * The most this item could justify, given its age at move-out and its condition
 * when the tenant received it. An item at or past end-of-life yields zero: its
 * replacement was already due, so the tenant is not funding it.
 */
export function depreciatedCeiling(input: {
  category: ItemCategory;
  ageMonthsAtMoveIn: number;
  occupiedMonths: number;
  replacementCostPaise: Paise;
  conditionAtMoveIn: Condition;
}): Paise {
  const life = USEFUL_LIFE_MONTHS[input.category];
  const ageAtMoveOut = input.ageMonthsAtMoveIn + input.occupiedMonths;

  if (ageAtMoveOut >= life) return 0n;

  // The remaining-life ratio is exactly rational, so compute it in integers
  // rather than round-tripping through a float. Going via a fraction costs real
  // paise: 30/36 of Rs 12,000 came out as Rs 9,999.60 instead of Rs 10,000.
  // Only the condition multiplier is a decimal, and it is exact in basis points.
  const remainingMonths = BigInt(life - ageAtMoveOut);
  const lifeMonths = BigInt(life);
  const conditionBps = BigInt(Math.round(CONDITION_MULTIPLIER[input.conditionAtMoveIn] * 10_000));

  return (input.replacementCostPaise * remainingMonths * conditionBps) / (lifeMonths * 10_000n);
}
