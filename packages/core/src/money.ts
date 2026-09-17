/**
 * All money in this system is a bigint count of paise. No floats, ever.
 *
 * The one place a non-integer enters the pipeline is the adjudicator's
 * `recommendedFraction`. It is converted to basis points and applied with
 * integer division, which floors — so rounding always loses in the claimant's
 * favour-of-the-tenant direction rather than inventing paise.
 */
export type Paise = bigint;

export const RUPEE = 100n;

export function rupees(n: number): Paise {
  if (!Number.isFinite(n)) throw new Error(`rupees() needs a finite number, got ${n}`);
  return BigInt(Math.round(n * 100));
}

/** Formats paise as an Indian-grouped rupee string: 4500000n -> "Rs 45,000.00". */
export function formatPaise(p: Paise): string {
  const neg = p < 0n;
  const abs = neg ? -p : p;
  const whole = abs / RUPEE;
  const frac = abs % RUPEE;

  // Indian grouping: last 3 digits, then pairs.
  const s = whole.toString();
  let grouped: string;
  if (s.length <= 3) {
    grouped = s;
  } else {
    const head = s.slice(0, -3);
    const tail = s.slice(-3);
    grouped = head.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + tail;
  }
  return `${neg ? "-" : ""}Rs ${grouped}.${frac.toString().padStart(2, "0")}`;
}

/**
 * Applies a [0,1] fraction to a paise amount using integer math.
 * Floors, so the result can never exceed `amount`.
 */
export function applyFraction(amount: Paise, fraction: number): Paise {
  if (!Number.isFinite(fraction)) throw new Error(`fraction must be finite, got ${fraction}`);
  const clamped = Math.min(1, Math.max(0, fraction));
  const bps = BigInt(Math.round(clamped * 10_000));
  return (amount * bps) / 10_000n;
}

export function clamp(value: Paise, min: Paise, max: Paise): Paise {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function sum(values: readonly Paise[]): Paise {
  return values.reduce((a, b) => a + b, 0n);
}
