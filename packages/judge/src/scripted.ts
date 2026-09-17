import type { JudgeClient, JudgeModels, PanelInput } from "./client.js";
import type { InjectionScreen, PanelAssessment } from "./schema.js";
import type { PanelRole } from "./prompts.js";

export type RoleScript = Partial<Record<PanelRole, Partial<PanelAssessment> | { throw: string }>>;

export interface Script {
  /** Per-claim, per-role responses. */
  claims: Record<string, RoleScript>;
  /** Texts the screen should flag, matched by exact string. */
  flagged?: Record<string, InjectionScreen>;
}

const BASE: PanelAssessment = {
  claimId: "",
  damageConfirmed: true,
  fairWearAndTear: false,
  attributableToTenant: true,
  severity: "moderate",
  recommendedFraction: 0.5,
  evidenceRefs: [],
  reasoning: "scripted",
  injectionSuspected: false,
};

/**
 * A deterministic stand-in for the model.
 *
 * The pipeline's safety properties — the fallback rules, the bounding, the
 * behaviour when a panelist dies — are logic, not model quality, and they should
 * be testable without spending money or depending on the network. Model quality
 * is measured separately by the eval harness in evals/.
 */
export class ScriptedJudgeClient implements JudgeClient {
  /** Named so a scripted run can never be mistaken for a real adjudication. */
  readonly models: JudgeModels = {
    adjudication: "scripted (no model)",
    screening: "scripted (no model)",
  };

  public readonly calls: Array<{ claimId: string; role: PanelRole }> = [];

  constructor(private readonly script: Script) {}

  async assessClaim(input: PanelInput, role: PanelRole): Promise<PanelAssessment> {
    this.calls.push({ claimId: input.claimId, role });

    const entry = this.script.claims[input.claimId]?.[role];
    if (entry && "throw" in entry) throw new Error(entry.throw);

    return { ...BASE, ...entry, claimId: input.claimId };
  }

  async screenInjection(text: string): Promise<InjectionScreen> {
    return (
      this.script.flagged?.[text] ?? { suspicious: false, technique: "none", quote: "" }
    );
  }
}
