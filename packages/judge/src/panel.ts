import type { ClaimAssessment } from "@pg/core";
import type { JudgeClient, PanelInput } from "./client.js";
import type { PanelAssessment } from "./schema.js";
import type { PanelRole } from "./prompts.js";

/**
 * How far the two advocates may disagree before the panel is treated as
 * unable to settle the question. Tuned on the eval set — see evals/run.ts.
 */
export const DISAGREEMENT_THRESHOLD = 0.4;

export interface PanelResult {
  claimId: string;
  /** The assessment that decides the outcome. */
  verdict: ClaimAssessment;
  /** Every panelist's raw output, kept for the audit record. */
  panelists: Record<PanelRole, PanelAssessment | { error: string }>;
  spread: number;
  /** Set when a fallback rule overrode the neutral panelist. */
  fallbackApplied: string | null;
}

export interface ScreenedText {
  text: string;
  suspicious: boolean;
  technique: string;
}

function isAssessment(v: PanelAssessment | { error: string }): v is PanelAssessment {
  return !("error" in v);
}

/**
 * Runs the three-role panel over one claim and resolves it.
 *
 * The neutral panelist's assessment is the verdict. The two advocates exist to
 * measure disagreement: if the strongest honest case for each side lands far
 * apart, the evidence does not actually settle the question, whatever the
 * neutral panelist concluded.
 *
 * With no human reviewer to escalate to, unresolved questions need a rule, and
 * the rule is the conventional one: the party claiming a deduction bears the
 * burden of proof, so an unproven claim fails. That is predictable, it cannot be
 * gamed by filing deliberately ambiguous claims, and it fails in the direction
 * that is recoverable — a tenant wrongly refunded is a smaller injustice than a
 * tenant wrongly charged, because the owner can still pursue the claim.
 */
export async function runPanel(
  client: JudgeClient,
  input: PanelInput,
  screens: { claim: ScreenedText; rebuttal: ScreenedText }
): Promise<PanelResult> {
  const roles: PanelRole[] = ["TENANT_ADVOCATE", "OWNER_ADVOCATE", "NEUTRAL"];

  const settled = await Promise.allSettled(
    roles.map((role) => client.assessClaim(input, role))
  );

  const panelists = Object.fromEntries(
    roles.map((role, i) => {
      const r = settled[i]!;
      return [
        role,
        r.status === "fulfilled" ? r.value : { error: String(r.reason?.message ?? r.reason) },
      ];
    })
  ) as Record<PanelRole, PanelAssessment | { error: string }>;

  const neutral = panelists.NEUTRAL;
  const tenantSide = panelists.TENANT_ADVOCATE;
  const ownerSide = panelists.OWNER_ADVOCATE;

  // The neutral panelist failing is itself an unresolved question.
  if (!isAssessment(neutral)) {
    return {
      claimId: input.claimId,
      verdict: disallowed(input.claimId, "The deciding panelist did not return an assessment."),
      panelists,
      spread: 1,
      fallbackApplied: "neutral-panelist-unavailable",
    };
  }

  const spread =
    isAssessment(tenantSide) && isAssessment(ownerSide)
      ? Math.abs(ownerSide.recommendedFraction - tenantSide.recommendedFraction)
      : 1; // A missing advocate means no disagreement signal, so assume the worst.

  let verdict: ClaimAssessment = { ...neutral, claimId: input.claimId };
  let fallbackApplied: string | null = null;

  // An owner who tries to instruct the adjudicator does not get to win the claim
  // by doing so. The tenant's rebuttal is screened too, but an injection there
  // only discards the rebuttal — the claim is still judged on the photographs,
  // so the tenant gains nothing from trying it either.
  if (screens.claim.suspicious) {
    verdict = disallowed(
      input.claimId,
      `The claim text attempted to manipulate the adjudication (${screens.claim.technique}). A deduction cannot be awarded on a claim that does this, so it is disallowed and the amount returns to the tenant.`
    );
    fallbackApplied = "injection-in-claim";
  } else if (spread > DISAGREEMENT_THRESHOLD) {
    verdict = disallowed(
      input.claimId,
      `The strongest honest reading for each side differed by ${spread.toFixed(2)}, which means the photographs do not settle this claim. An unproven deduction fails, so the amount stays with the tenant.`
    );
    fallbackApplied = "advocate-disagreement";
  }

  return { claimId: input.claimId, verdict, panelists, spread, fallbackApplied };
}

function disallowed(claimId: string, reasoning: string): ClaimAssessment {
  return {
    claimId,
    damageConfirmed: false,
    fairWearAndTear: false,
    attributableToTenant: false,
    severity: "none",
    recommendedFraction: 0,
    evidenceRefs: [],
    reasoning,
    injectionSuspected: false,
  };
}
