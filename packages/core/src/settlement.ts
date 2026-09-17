import { applyFraction, sum, type Paise } from "./money.js";
import { depreciatedCeiling, SEVERITY_CAP } from "./depreciation.js";
import type {
  AdjudicatedLineItem,
  ClaimAssessment,
  DeductionClaim,
  DeterministicLineItem,
  Settlement,
  TenancyFacts,
} from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Everything computable without a model: arrears, late fees, notice shortfall.
 * Run first, so the adjudicator is never asked to do arithmetic.
 */
export function computeDeterministicDeductions(facts: TenancyFacts): DeterministicLineItem[] {
  const out: DeterministicLineItem[] = [];
  const { terms, ledger } = facts;

  const unpaid = ledger.filter((e) => e.paidAt === null);
  if (unpaid.length > 0) {
    out.push({
      kind: "RENT_ARREARS",
      description: `${unpaid.length} unpaid rent cycle(s)`,
      amountPaise: sum(unpaid.map((e) => e.amountPaise)),
    });
  }

  // Late fee accrues per started month of lateness, on cycles that were paid late
  // as well as those never paid.
  let lateFee = 0n;
  for (const entry of ledger) {
    const settledAt = entry.paidAt ?? facts.moveOutAt;
    const lateDays = Math.floor((settledAt.getTime() - entry.dueAt.getTime()) / MS_PER_DAY);
    if (lateDays <= 0) continue;
    const monthsLate = Math.ceil(lateDays / 30);
    lateFee += applyFraction(entry.amountPaise, terms.lateFeeRate * monthsLate);
  }
  if (lateFee > 0n) {
    out.push({
      kind: "LATE_FEE",
      description: `Late payment fee at ${(terms.lateFeeRate * 100).toFixed(1)}% per month`,
      amountPaise: lateFee,
    });
  }

  // Short notice costs the owner re-letting time, pro-rated on the days missed.
  if (facts.noticeGivenAt) {
    const noticeDays = Math.floor(
      (facts.moveOutAt.getTime() - facts.noticeGivenAt.getTime()) / MS_PER_DAY
    );
    const shortfall = terms.noticeDays - noticeDays;
    if (shortfall > 0) {
      out.push({
        kind: "NOTICE_SHORTFALL",
        description: `Notice ${shortfall} day(s) short of the agreed ${terms.noticeDays}`,
        amountPaise: applyFraction(terms.rentPaise, shortfall / 30),
      });
    }
  }

  return out;
}

/**
 * Turns the adjudicator's per-claim assessments into exact paise.
 *
 * Four independent bounds apply, and the tightest wins. Each one alone is enough
 * to stop a runaway award; together they mean no model output — hallucinated,
 * injected, or merely wrong — can produce a deduction the evidence and the
 * depreciation schedule don't already permit:
 *
 *   1. The item's depreciated ceiling (a dead item yields zero).
 *   2. The severity cap (a scuff cannot bill a whole wall).
 *   3. Hard overrides: fair wear and tear, or damage not attributable to the
 *      tenant, or damage not confirmed at all -> zero.
 *   4. The deposit itself, clamped at the end.
 */
export function applyAssessments(
  facts: TenancyFacts,
  claims: readonly DeductionClaim[],
  assessments: readonly ClaimAssessment[]
): AdjudicatedLineItem[] {
  const byClaim = new Map(assessments.map((a) => [a.claimId, a]));
  const itemsById = new Map(facts.items.map((i) => [i.id, i]));

  return claims.map((claim) => {
    const item = itemsById.get(claim.itemId);
    if (!item) throw new Error(`Claim ${claim.id} references unknown item ${claim.itemId}`);

    const assessment = byClaim.get(claim.id);
    const adjustments: string[] = [];

    const ceilingPaise = depreciatedCeiling({
      category: item.category,
      ageMonthsAtMoveIn: item.ageMonths,
      occupiedMonths: facts.occupiedMonths,
      replacementCostPaise: item.replacementCostPaise,
      conditionAtMoveIn: item.conditionAtMoveIn,
    });

    if (ceilingPaise === 0n) {
      adjustments.push("Item is at or past end of useful life; ceiling is zero.");
    }

    // A claim the adjudicator never ruled on cannot be charged.
    if (!assessment) {
      return {
        claimId: claim.id,
        itemId: item.id,
        label: item.label,
        ceilingPaise,
        appliedFraction: 0,
        allowedPaise: 0n,
        adjustments: [...adjustments, "No assessment returned for this claim; disallowed."],
        reasoning: "",
      };
    }

    let fraction = Number.isFinite(assessment.recommendedFraction)
      ? Math.min(1, Math.max(0, assessment.recommendedFraction))
      : 0;

    if (fraction !== assessment.recommendedFraction) {
      adjustments.push(
        `Recommended fraction ${assessment.recommendedFraction} clamped to ${fraction}.`
      );
    }

    if (!assessment.damageConfirmed) {
      fraction = 0;
      adjustments.push("Damage not confirmed against the move-in baseline.");
    }
    if (assessment.fairWearAndTear) {
      fraction = 0;
      adjustments.push("Assessed as fair wear and tear, which is not deductible.");
    }
    if (!assessment.attributableToTenant) {
      fraction = 0;
      adjustments.push("Damage not attributable to the tenant.");
    }

    const cap = SEVERITY_CAP[assessment.severity];
    if (fraction > cap) {
      adjustments.push(`Severity "${assessment.severity}" caps the award at ${cap * 100}%.`);
      fraction = cap;
    }

    return {
      claimId: claim.id,
      itemId: item.id,
      label: item.label,
      ceilingPaise,
      appliedFraction: fraction,
      allowedPaise: applyFraction(ceilingPaise, fraction),
      adjustments,
      reasoning: assessment.reasoning,
    };
  });
}

/**
 * Final assembly. Guarantees `toOwner + toTenant === deposit` exactly, which is
 * the same invariant the contract re-checks on-chain before moving anything.
 */
export function buildSettlement(
  facts: TenancyFacts,
  deterministic: DeterministicLineItem[],
  adjudicated: AdjudicatedLineItem[]
): Settlement {
  const deposit = facts.terms.depositPaise;

  const gross =
    sum(deterministic.map((d) => d.amountPaise)) + sum(adjudicated.map((a) => a.allowedPaise));

  const toOwner = gross > deposit ? deposit : gross;
  const toTenant = deposit - toOwner;

  return {
    depositPaise: deposit,
    deterministic,
    adjudicated,
    grossDeductionPaise: gross,
    toOwnerPaise: toOwner,
    toTenantPaise: toTenant,
    clamped: gross > deposit,
  };
}

/** Convenience: the whole deposit pipeline in one call. */
export function settleDeposit(
  facts: TenancyFacts,
  claims: readonly DeductionClaim[],
  assessments: readonly ClaimAssessment[]
): Settlement {
  return buildSettlement(
    facts,
    computeDeterministicDeductions(facts),
    applyAssessments(facts, claims, assessments)
  );
}
