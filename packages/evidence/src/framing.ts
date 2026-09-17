import type { CapturePose, EvidencePhoto, FramingCheck } from "./types.js";

/**
 * How far apart two framings are, in [0,1].
 *
 * This is what makes the ghost-overlay capture enforceable. Two photos of "the
 * wall" taken from different corners of the room are not a before/after pair,
 * and asking a vision model to compare them produces confident nonsense. So the
 * move-out shot has to actually line up with the move-in shot before it is
 * accepted as evidence.
 */
export const MAX_ACCEPTABLE_DELTA = 0.25;

/** Intersection-over-union of the two normalised framing boxes. */
function frameIoU(a: CapturePose["frame"], b: CapturePose["frame"]): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);

  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - overlap;
  return union <= 0 ? 0 : overlap / union;
}

/** Shortest angular distance in degrees, handling wraparound. */
function angleDelta(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360;
  return raw > 180 ? 360 - raw : raw;
}

export function poseDelta(moveIn: CapturePose, moveOut: CapturePose): number {
  const iou = frameIoU(moveIn.frame, moveOut.frame);
  const framingPenalty = 1 - iou;

  // Beyond 45 degrees off, you are looking at a different surface.
  const orientationPenalty =
    (angleDelta(moveIn.alpha, moveOut.alpha) +
      angleDelta(moveIn.beta, moveOut.beta) +
      angleDelta(moveIn.gamma, moveOut.gamma)) /
    (3 * 45);

  return Math.min(1, 0.7 * framingPenalty + 0.3 * Math.min(1, orientationPenalty));
}

/**
 * Checks each move-out photo against its move-in counterpart. A slot with no
 * baseline is rejected outright: with nothing to compare against, any claim on
 * it is unfalsifiable, and unfalsifiable claims are exactly what this system
 * exists to stop.
 */
export function checkFraming(
  moveIn: readonly EvidencePhoto[],
  moveOut: readonly EvidencePhoto[]
): FramingCheck[] {
  const baseline = new Map(moveIn.map((p) => [`${p.itemId}:${p.slot}`, p]));

  return moveOut.map((shot) => {
    const key = `${shot.itemId}:${shot.slot}`;
    const before = baseline.get(key);

    if (!before) {
      return {
        slot: shot.slot,
        itemId: shot.itemId,
        delta: 1,
        acceptable: false,
        reason: "No move-in baseline exists for this slot; nothing to compare against.",
      };
    }

    const delta = poseDelta(before.pose, shot.pose);
    return {
      slot: shot.slot,
      itemId: shot.itemId,
      delta,
      acceptable: delta <= MAX_ACCEPTABLE_DELTA,
      reason:
        delta <= MAX_ACCEPTABLE_DELTA
          ? "Framing matches the move-in baseline."
          : `Framing differs too much from the baseline (delta ${delta.toFixed(2)}); retake needed.`,
    };
  });
}
