import { AnthropicJudgeClient } from "./client.js";
import { GeminiJudgeClient } from "./gemini.js";
import { ScriptedJudgeClient } from "./scripted.js";
import type { JudgeClient } from "./client.js";

export type JudgeProvider = "gemini" | "anthropic" | "scripted";

/**
 * Picks the adjudicator from whatever credentials are present.
 *
 * Gemini first, because it is what this deployment is configured for. Falling
 * back to a scripted stub rather than failing keeps the rest of the product
 * usable without a key — but the stub names itself in the audit record, so a
 * rehearsal can never be mistaken for a real verdict.
 */
export function resolveProvider(): JudgeProvider {
  const forced = process.env.JUDGE_PROVIDER as JudgeProvider | undefined;
  if (forced === "gemini" || forced === "anthropic" || forced === "scripted") return forced;
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "scripted";
}

export function createJudgeClient(provider: JudgeProvider = resolveProvider()): JudgeClient {
  switch (provider) {
    case "gemini":
      return new GeminiJudgeClient();
    case "anthropic":
      return new AnthropicJudgeClient();
    default:
      return new ScriptedJudgeClient({ claims: {} });
  }
}
