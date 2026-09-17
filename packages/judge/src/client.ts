import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  ClaimAssessmentSchema,
  InjectionScreenSchema,
  type InjectionScreen,
  type PanelAssessment,
} from "./schema.js";
import {
  INJECTION_SCREEN_PROMPT,
  ROLE_BRIEFS,
  RUBRIC,
  wrapUntrusted,
  type PanelRole,
} from "./prompts.js";

export const ADJUDICATION_MODEL = "claude-opus-5";
export const SCREENING_MODEL = "claude-haiku-4-5";

export type ImageMedia =
  | { kind: "base64"; mediaType: "image/jpeg" | "image/png" | "image/webp"; data: string }
  | { kind: "url"; url: string };

export interface PhotoRef {
  id: string;
  slot: string;
  media: ImageMedia;
}

export interface PanelInput {
  claimId: string;
  item: {
    label: string;
    category: string;
    ageMonthsAtMoveIn: number;
    occupiedMonths: number;
    conditionAtMoveIn: string;
  };
  /** Untrusted: the owner's words. */
  claimText: string;
  /** Untrusted: the tenant's words. */
  rebuttalText: string;
  moveInPhotos: PhotoRef[];
  moveOutPhotos: PhotoRef[];
  /**
   * A written description of what the photographs show, used in place of the
   * images themselves by the text-pathway eval suite. In production this stays
   * unset — the images are the evidence. It is platform-generated, not party
   * text, so it is not wrapped as untrusted.
   */
  photoDescription?: string;
}

export interface JudgeModels {
  adjudication: string;
  screening: string;
}

/**
 * Seam between the pipeline and whichever model is behind it.
 *
 * `models` is part of the contract rather than a constant, because the audit
 * record has to name the model that actually decided. A verdict attributed to
 * the wrong model is worse than one with no attribution at all.
 */
export interface JudgeClient {
  readonly models: JudgeModels;
  assessClaim(input: PanelInput, role: PanelRole): Promise<PanelAssessment>;
  screenInjection(text: string): Promise<InjectionScreen>;
}

function imageBlock(media: ImageMedia): Anthropic.ImageBlockParam {
  return media.kind === "base64"
    ? { type: "image", source: { type: "base64", media_type: media.mediaType, data: media.data } }
    : { type: "image", source: { type: "url", url: media.url } };
}

/**
 * Lays out one claim for a panelist: metadata, then the before/after photos
 * each announced by id and slot, then the two parties' statements sealed in
 * tags. Photos are labelled individually so `evidenceRefs` can cite something
 * real rather than a vague "the second image".
 */
export function buildClaimContent(input: PanelInput): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];

  blocks.push({
    type: "text",
    text: [
      `Claim id: ${input.claimId}`,
      `Item: ${input.item.label} (category ${input.item.category})`,
      `Condition recorded at move-in: ${input.item.conditionAtMoveIn}`,
      `Item age at move-in: ${input.item.ageMonthsAtMoveIn} months`,
      `Tenancy length: ${input.item.occupiedMonths} months`,
    ].join("\n"),
  });

  if (input.photoDescription) {
    blocks.push({
      type: "text",
      text: `## Evidence record\n\n${input.photoDescription}`,
    });
  }

  if (input.moveInPhotos.length > 0 || input.moveOutPhotos.length > 0) {
    blocks.push({ type: "text", text: "## Move-in photographs (the baseline)" });
    for (const p of input.moveInPhotos) {
      blocks.push({ type: "text", text: `Photo id ${p.id} — slot "${p.slot}" — MOVE-IN` });
      blocks.push(imageBlock(p.media));
    }

    blocks.push({ type: "text", text: "## Move-out photographs (the same slots)" });
    for (const p of input.moveOutPhotos) {
      blocks.push({ type: "text", text: `Photo id ${p.id} — slot "${p.slot}" — MOVE-OUT` });
      blocks.push(imageBlock(p.media));
    }
  }

  blocks.push({
    type: "text",
    text: `## The owner's claim\n\n${wrapUntrusted("claim", input.claimText)}`,
  });
  blocks.push({
    type: "text",
    text: `## The tenant's response\n\n${wrapUntrusted("rebuttal", input.rebuttalText)}`,
  });

  blocks.push({
    type: "text",
    text: "Assess this claim now, following your role brief and the rubric.",
  });

  return blocks;
}

export class AnthropicJudgeClient implements JudgeClient {
  readonly models: JudgeModels = {
    adjudication: ADJUDICATION_MODEL,
    screening: SCREENING_MODEL,
  };

  constructor(private readonly client: Anthropic = new Anthropic()) {}

  async assessClaim(input: PanelInput, role: PanelRole): Promise<PanelAssessment> {
    const response = await this.client.messages.parse({
      model: ADJUDICATION_MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: [
        // Byte-stable prefix, shared by all three panelists and every claim in
        // this dispute. The breakpoint goes here, not after the role brief.
        { type: "text", text: RUBRIC, cache_control: { type: "ephemeral" } },
        { type: "text", text: ROLE_BRIEFS[role] },
      ],
      messages: [{ role: "user", content: buildClaimContent(input) }],
      output_config: { format: zodOutputFormat(ClaimAssessmentSchema) },
    });

    if (response.stop_reason === "refusal") {
      throw new RefusedError(`Panelist ${role} declined to assess claim ${input.claimId}`);
    }
    if (!response.parsed_output) {
      throw new Error(`Panelist ${role} returned no parseable assessment`);
    }

    // The model is asked to echo the id; trust our own value over its copy.
    return { ...response.parsed_output, claimId: input.claimId };
  }

  async screenInjection(text: string): Promise<InjectionScreen> {
    const response = await this.client.messages.parse({
      model: SCREENING_MODEL,
      max_tokens: 1024,
      system: INJECTION_SCREEN_PROMPT,
      messages: [{ role: "user", content: wrapUntrusted("submission", text) }],
      output_config: { format: zodOutputFormat(InjectionScreenSchema) },
    });

    // A screen that fails is treated as suspicious: the conservative direction.
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      return { suspicious: true, technique: "screen-unavailable", quote: "" };
    }
    return response.parsed_output;
  }
}

export class RefusedError extends Error {}
