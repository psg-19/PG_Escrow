import type { Paise } from "./money.js";

/** Fixed taxonomy. A closed set keeps the depreciation table total. */
export type ItemCategory =
  | "WALL"
  | "MATTRESS"
  | "GEYSER"
  | "AC"
  | "DOOR"
  | "WINDOW"
  | "FURNITURE"
  | "BATHROOM_FITTING"
  | "FLOORING";

export type Condition = "NEW" | "GOOD" | "FAIR" | "WORN";

export type Severity = "none" | "minor" | "moderate" | "severe";

export interface InventoryItem {
  id: string;
  category: ItemCategory;
  label: string;
  /** Age at move-in, in months. */
  ageMonths: number;
  /** What it would cost to replace today. */
  replacementCostPaise: Paise;
  conditionAtMoveIn: Condition;
  /** Evidence slots that must be photographed at both move-in and move-out. */
  photoSlots: string[];
}

export interface AgreementTerms {
  id: string;
  rentPaise: Paise;
  depositPaise: Paise;
  noticeDays: number;
  /** Monthly late fee as a fraction of rent, e.g. 0.02 for 2%. */
  lateFeeRate: number;
  startAt: Date;
}

export interface LedgerEntry {
  cycleIndex: number;
  dueAt: Date;
  amountPaise: Paise;
  paidAt: Date | null;
}

export interface TenancyFacts {
  terms: AgreementTerms;
  ledger: LedgerEntry[];
  items: InventoryItem[];
  noticeGivenAt: Date | null;
  moveOutAt: Date;
  /** Tenancy duration, used to age items at move-out. */
  occupiedMonths: number;
}

/** A deduction the owner is asking for. Text here is untrusted input. */
export interface DeductionClaim {
  id: string;
  itemId: string;
  /** Owner's words. Never placed in a system-prompt position. */
  claimText: string;
  moveInPhotoIds: string[];
  moveOutPhotoIds: string[];
}

export interface Rebuttal {
  claimId: string;
  /** Tenant's words. Equally untrusted. */
  rebuttalText: string;
}

/**
 * What the adjudicator is allowed to return, per claim.
 * Note there is no rupee figure anywhere: the model returns a fraction and the
 * rules engine decides what that fraction is a fraction *of*.
 */
export interface ClaimAssessment {
  claimId: string;
  damageConfirmed: boolean;
  fairWearAndTear: boolean;
  attributableToTenant: boolean;
  severity: Severity;
  recommendedFraction: number;
  evidenceRefs: string[];
  reasoning: string;
  injectionSuspected: boolean;
}

/** A deduction the rules engine computed with no model involvement. */
export interface DeterministicLineItem {
  kind: "RENT_ARREARS" | "LATE_FEE" | "NOTICE_SHORTFALL";
  description: string;
  amountPaise: Paise;
}

export interface AdjudicatedLineItem {
  claimId: string;
  itemId: string;
  label: string;
  /** Ceiling after depreciation — the most this item could ever justify. */
  ceilingPaise: Paise;
  /** Fraction actually applied after every cap and override. */
  appliedFraction: number;
  allowedPaise: Paise;
  /** Why the outcome differs from the model's raw recommendation, if it does. */
  adjustments: string[];
  reasoning: string;
}

export interface Settlement {
  depositPaise: Paise;
  deterministic: DeterministicLineItem[];
  adjudicated: AdjudicatedLineItem[];
  /** Sum of all deductions before clamping to the deposit. */
  grossDeductionPaise: Paise;
  toOwnerPaise: Paise;
  toTenantPaise: Paise;
  /** True when deductions exceeded the deposit and were capped. */
  clamped: boolean;
}
