import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

/**
 * Loads the repo-root `.env` into `process.env`.
 *
 * Node does not do this on its own, so without it every `process.env.X` lookup
 * returns undefined and a perfectly good API key sits in a file nobody reads.
 * That failure is quiet in the worst way: the adjudicator just falls back to the
 * scripted stub and the app keeps working, so you find out only when a verdict
 * turns out to be a rehearsal.
 *
 * Resolved from this module's own location rather than cwd, because npm
 * workspace scripts each run from their own directory.
 *
 * Real environment variables win — `.env` never clobbers something the shell or
 * the deployment already set.
 */
export function loadEnv(): { loaded: boolean; path: string } {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const path = resolve(repoRoot, ".env");

  if (!existsSync(path)) return { loaded: false, path };

  try {
    process.loadEnvFile(path);
    return { loaded: true, path };
  } catch {
    // A malformed .env should not take the server down.
    return { loaded: false, path };
  }
}

/** Whether Google sign-in will work, said plainly at startup. */
export function describeGoogleConfig(): string {
  return process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY
    ? `Google sign-in: on (${process.env.SUPABASE_URL})`
    : "Google sign-in: off — set SUPABASE_URL and SUPABASE_ANON_KEY";
}

/** One line at startup saying which adjudicator is actually wired up. */
export function describeJudgeConfig(): string {
  if (process.env.JUDGE_PROVIDER === "scripted") {
    return "Adjudicator: scripted (forced by JUDGE_PROVIDER)";
  }
  if (process.env.GEMINI_API_KEY) {
    return `Adjudicator: Gemini (${process.env.GEMINI_MODEL ?? "gemini-2.5-pro"})`;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return "Adjudicator: Anthropic (claude-opus-5)";
  }
  return "Adjudicator: scripted stub — no GEMINI_API_KEY found, verdicts are rehearsals";
}
