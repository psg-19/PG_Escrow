import { createHash } from "node:crypto";
import {
  settleDeposit,
  formatPaise,
  type ClaimAssessment,
  type DeductionClaim,
  type Rebuttal,
  type Settlement,
  type TenancyFacts,
} from "@pg/core";
import type { JudgeClient, PanelInput, PhotoRef } from "./client.js";
import { runPanel, type PanelResult, type ScreenedText } from "./panel.js";
import { RUBRIC_VERSION } from "./prompts.js";
import { DEPRECIATION_SCHEDULE_VERSION } from "@pg/core";

export interface AdjudicationRequest {
  disputeId: bigint;
  facts: TenancyFacts;
  claims: DeductionClaim[];
  rebuttals: Rebuttal[];
  /** Photos keyed by claim id, already framing-checked and Merkle-anchored. */
  photosByClaim: Record<string, { moveIn: PhotoRef[]; moveOut: PhotoRef[] }>;
  evidenceRoot: `0x${string}`;
  /**
   * Written evidence records keyed by claim id, used by the text-pathway eval
   * suite in place of images. Unset in production, where photos are the evidence.
   */
  photoDescriptionByClaim?: Record<string, string>;
}

export interface AuditRecord {
  disputeId: string;
  adjudicationModel: string;
  screeningModel: string;
  rubricVersion: string;
  depreciationScheduleVersion: string;
  evidenceRoot: `0x${string}`;
  panels: PanelResult[];
  screens: Record<string, { claim: ScreenedText; rebuttal: ScreenedText }>;
  decidedAt: string;
}

export interface AdjudicationResult {
  settlement: Settlement;
  assessments: ClaimAssessment[];
  audit: AuditRecord;
  /** Plain-language document both parties receive. */
  rationale: string;
  /** sha256 of `rationale`, committed on-chain alongside the split. */
  rationaleHash: `0x${string}`;
}

/**
 * The full pipeline: screen, panel, bound, assemble.
 *
 * Failure is safe by construction at every stage. A claim whose panel errors
 * out gets no assessment, and @pg/core disallows unassessed claims — so a model
 * outage, a refusal, or a malformed response all resolve the same way the
 * burden of proof says they should: the deduction fails and the money stays
 * with the tenant. There is no path where a broken pipeline charges anyone.
 */
export async function adjudicate(
  client: JudgeClient,
  req: AdjudicationRequest
): Promise<AdjudicationResult> {
  const rebuttalByClaim = new Map(req.rebuttals.map((r) => [r.claimId, r.rebuttalText]));
  const itemsById = new Map(req.facts.items.map((i) => [i.id, i]));

  // Stage 0 — screen every party statement before any of it reaches the panel.
  const screens: AdjudicationResult["audit"]["screens"] = {};
  await Promise.all(
    req.claims.map(async (claim) => {
      const rebuttalText = rebuttalByClaim.get(claim.id) ?? "";
      const [claimScreen, rebuttalScreen] = await Promise.all([
        client.screenInjection(claim.claimText),
        rebuttalText ? client.screenInjection(rebuttalText) : Promise.resolve(null),
      ]);
      screens[claim.id] = {
        claim: {
          text: claim.claimText,
          suspicious: claimScreen.suspicious,
          technique: claimScreen.technique,
        },
        rebuttal: {
          text: rebuttalText,
          suspicious: rebuttalScreen?.suspicious ?? false,
          technique: rebuttalScreen?.technique ?? "none",
        },
      };
    })
  );

  // Stage 2/3 — the adversarial panel, one per claim.
  const panels: PanelResult[] = [];
  for (const claim of req.claims) {
    const item = itemsById.get(claim.itemId);
    if (!item) throw new Error(`Claim ${claim.id} references unknown item ${claim.itemId}`);

    const photos = req.photosByClaim[claim.id] ?? { moveIn: [], moveOut: [] };
    const input: PanelInput = {
      claimId: claim.id,
      item: {
        label: item.label,
        category: item.category,
        ageMonthsAtMoveIn: item.ageMonths,
        occupiedMonths: req.facts.occupiedMonths,
        conditionAtMoveIn: item.conditionAtMoveIn,
      },
      claimText: claim.claimText,
      rebuttalText: rebuttalByClaim.get(claim.id) ?? "(The tenant did not respond to this claim.)",
      moveInPhotos: photos.moveIn,
      moveOutPhotos: photos.moveOut,
      photoDescription: req.photoDescriptionByClaim?.[claim.id],
    };

    panels.push(await runPanel(client, input, screens[claim.id]!));
  }

  // Stages 1 & 4 — the rules engine bounds everything and computes the money.
  const assessments = panels.map((p) => p.verdict);
  const settlement = settleDeposit(req.facts, req.claims, assessments);

  const rationale = renderRationale(req, settlement, panels);
  const rationaleHash = `0x${createHash("sha256").update(rationale, "utf8").digest("hex")}` as const;

  return {
    settlement,
    assessments,
    rationale,
    rationaleHash,
    audit: {
      disputeId: req.disputeId.toString(),
      adjudicationModel: client.models.adjudication,
      screeningModel: client.models.screening,
      rubricVersion: RUBRIC_VERSION,
      depreciationScheduleVersion: DEPRECIATION_SCHEDULE_VERSION,
      evidenceRoot: req.evidenceRoot,
      panels,
      screens,
      decidedAt: new Date().toISOString(),
    },
  };
}

/**
 * The document both parties read. Every deduction traces to the item it came
 * from, the ceiling that bounded it, and the reason it was allowed or refused —
 * a tenant should be able to check the arithmetic themselves.
 */
export function renderRationale(
  req: AdjudicationRequest,
  settlement: Settlement,
  panels: PanelResult[]
): string {
  const lines: string[] = [];
  const panelByClaim = new Map(panels.map((p) => [p.claimId, p]));

  lines.push(`# Deposit settlement — dispute ${req.disputeId}`);
  lines.push("");
  lines.push(`Deposit held: ${formatPaise(settlement.depositPaise)}`);
  lines.push("");

  if (settlement.deterministic.length > 0) {
    lines.push("## Amounts owed under the agreement");
    lines.push("");
    lines.push("These come from the agreement and the payment record, not from any assessment of the photographs.");
    lines.push("");
    for (const d of settlement.deterministic) {
      lines.push(`- ${d.description}: ${formatPaise(d.amountPaise)}`);
    }
    lines.push("");
  }

  lines.push("## Claimed damage");
  lines.push("");
  if (settlement.adjudicated.length === 0) {
    lines.push("No deductions were claimed.");
    lines.push("");
  }

  for (const line of settlement.adjudicated) {
    const panel = panelByClaim.get(line.claimId);
    lines.push(`### ${line.label}`);
    lines.push("");
    lines.push(`- Most this item could justify after depreciation: ${formatPaise(line.ceilingPaise)}`);
    lines.push(`- Allowed: ${formatPaise(line.allowedPaise)}`);
    if (line.reasoning) lines.push(`- Finding: ${line.reasoning}`);
    for (const adj of line.adjustments) lines.push(`- ${adj}`);
    if (panel?.fallbackApplied) {
      lines.push(`- Resolved by fallback rule: ${panel.fallbackApplied}`);
    }
    lines.push("");
  }

  lines.push("## Outcome");
  lines.push("");
  lines.push(`- To the owner: ${formatPaise(settlement.toOwnerPaise)}`);
  lines.push(`- To the tenant: ${formatPaise(settlement.toTenantPaise)}`);
  if (settlement.clamped) {
    lines.push(
      `- Deductions totalled ${formatPaise(settlement.grossDeductionPaise)}, more than the deposit. They were capped at the deposit; the deposit is the limit of what can be recovered here.`
    );
  }
  lines.push("");
  lines.push(
    `Decided on the evidence anchored at ${req.evidenceRoot}, under rubric ${RUBRIC_VERSION} and depreciation schedule ${DEPRECIATION_SCHEDULE_VERSION}.`
  );

  return lines.join("\n");
}
