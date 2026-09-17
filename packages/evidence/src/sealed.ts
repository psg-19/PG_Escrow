import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Commit–reveal for claims and rebuttals.
 *
 * Without this, whoever writes second gets to tailor their story to the first
 * submission. Each side commits a hash, and the text is only revealed once both
 * have committed or the window closes. Cheap to build, and it removes an entire
 * category of gaming from the dispute.
 */

export interface SealedSubmission {
  id: string;
  party: string;
  commitment: string;
  committedAt: Date;
  revealed: { text: string; salt: string; revealedAt: Date } | null;
}

export function commit(text: string, salt: string = randomBytes(16).toString("hex")) {
  const commitment = createHash("sha256")
    .update(JSON.stringify([text, salt]), "utf8")
    .digest("hex");
  return { commitment, salt };
}

export function verifyReveal(commitment: string, text: string, salt: string): boolean {
  const expected = createHash("sha256")
    .update(JSON.stringify([text, salt]), "utf8")
    .digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(commitment, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export const REVEAL_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * Both sides committed, or the window ran out. A party that commits and then
 * refuses to reveal simply forfeits: their text never enters evidence.
 */
export function canReveal(
  submissions: readonly SealedSubmission[],
  expectedParties: readonly string[],
  now: Date
): boolean {
  const committed = new Set(submissions.map((s) => s.party));
  if (expectedParties.every((p) => committed.has(p))) return true;

  const earliest = submissions.reduce<Date | null>(
    (min, s) => (min === null || s.committedAt < min ? s.committedAt : min),
    null
  );
  if (!earliest) return false;
  return now.getTime() - earliest.getTime() >= REVEAL_WINDOW_MS;
}
