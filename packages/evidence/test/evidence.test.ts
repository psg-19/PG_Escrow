import { describe, it, expect } from "vitest";
import {
  merkleRoot,
  merkleProof,
  verifyProof,
  leafHash,
  checkFraming,
  poseDelta,
  commit,
  verifyReveal,
  canReveal,
  MAX_ACCEPTABLE_DELTA,
  type EvidencePhoto,
  type CapturePose,
  type SealedSubmission,
} from "../src/index.js";

const POSE: CapturePose = {
  alpha: 90,
  beta: 10,
  gamma: 0,
  frame: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
};

function photo(over: Partial<EvidencePhoto> = {}): EvidencePhoto {
  return {
    id: "p1",
    itemId: "item-wall",
    slot: "wide",
    stage: "MOVE_IN",
    sha256: "a".repeat(64),
    capturedAt: new Date("2025-01-01T10:00:00Z"),
    capturedBy: "tenant",
    pose: POSE,
    storageKey: "s3://bucket/p1.jpg",
    ...over,
  };
}

describe("merkle anchoring", () => {
  it("is independent of upload order", () => {
    const a = photo({ id: "p1" });
    const b = photo({ id: "p2", sha256: "b".repeat(64) });
    const c = photo({ id: "p3", sha256: "c".repeat(64) });

    expect(merkleRoot([a, b, c])).toBe(merkleRoot([c, a, b]));
    expect(merkleRoot([a, b, c])).toBe(merkleRoot([b, c, a]));
  });

  it("changes if any photo's bytes change", () => {
    const before = merkleRoot([photo({ id: "p1" }), photo({ id: "p2", sha256: "b".repeat(64) })]);
    const after = merkleRoot([
      photo({ id: "p1", sha256: "f".repeat(64) }),
      photo({ id: "p2", sha256: "b".repeat(64) }),
    ]);
    expect(after).not.toBe(before);
  });

  it("changes if a photo is re-labelled to a different item", () => {
    const original = photo({ id: "p1", itemId: "item-bathroom" });
    const relabelled = photo({ id: "p1", itemId: "item-wall" });
    // Same bytes, same id — but the leaf commits to where it belongs.
    expect(leafHash(original).equals(leafHash(relabelled))).toBe(false);
  });

  it("produces verifiable inclusion proofs, including for odd counts", () => {
    const photos = Array.from({ length: 5 }, (_, i) =>
      photo({ id: `p${i}`, sha256: String(i).repeat(64) })
    );
    const root = merkleRoot(photos);

    for (const p of photos) {
      expect(verifyProof(p, merkleProof(photos, p.id), root)).toBe(true);
    }
  });

  it("rejects a proof for a photo that was not committed", () => {
    const photos = [photo({ id: "p1" }), photo({ id: "p2", sha256: "b".repeat(64) })];
    const root = merkleRoot(photos);
    const forged = photo({ id: "p1", sha256: "9".repeat(64) });

    expect(verifyProof(forged, merkleProof(photos, "p1"), root)).toBe(false);
    expect(() => merkleProof(photos, "nope")).toThrow(/not in this manifest/);
  });

  it("returns a zero root for an empty manifest", () => {
    expect(merkleRoot([])).toBe(`0x${"0".repeat(64)}`);
  });
});

describe("framing enforcement", () => {
  it("accepts a move-out shot that lines up with the baseline", () => {
    const before = photo({ stage: "MOVE_IN" });
    const after = photo({
      id: "p2",
      stage: "MOVE_OUT",
      pose: { ...POSE, alpha: 92, frame: { x: 0.11, y: 0.1, w: 0.79, h: 0.8 } },
    });

    const [check] = checkFraming([before], [after]);
    expect(check!.acceptable).toBe(true);
    expect(check!.delta).toBeLessThan(MAX_ACCEPTABLE_DELTA);
  });

  it("rejects a move-out shot framed from somewhere else entirely", () => {
    const before = photo({ stage: "MOVE_IN" });
    const after = photo({
      id: "p2",
      stage: "MOVE_OUT",
      pose: { alpha: 270, beta: 80, gamma: 60, frame: { x: 0.6, y: 0.6, w: 0.3, h: 0.3 } },
    });

    const [check] = checkFraming([before], [after]);
    expect(check!.acceptable).toBe(false);
    expect(check!.reason).toMatch(/retake/);
  });

  it("rejects a move-out slot with no move-in baseline", () => {
    const after = photo({ id: "p2", stage: "MOVE_OUT", slot: "ceiling" });
    const [check] = checkFraming([], [after]);
    expect(check!.acceptable).toBe(false);
    expect(check!.reason).toMatch(/No move-in baseline/);
  });

  it("treats identical poses as zero delta", () => {
    expect(poseDelta(POSE, POSE)).toBe(0);
  });

  it("handles angle wraparound rather than reporting a huge delta", () => {
    const near = poseDelta(POSE, { ...POSE, alpha: 359 });
    const alsoNear = poseDelta({ ...POSE, alpha: 1 }, { ...POSE, alpha: 359 });
    expect(alsoNear).toBeLessThan(near + 0.05);
  });
});

describe("sealed submissions", () => {
  it("verifies a correct reveal and rejects a changed one", () => {
    const text = "The wall was gouged near the window.";
    const { commitment, salt } = commit(text);

    expect(verifyReveal(commitment, text, salt)).toBe(true);
    expect(verifyReveal(commitment, "Actually it was the door.", salt)).toBe(false);
    expect(verifyReveal(commitment, text, "wrongsalt")).toBe(false);
  });

  it("opens the reveal once both parties have committed", () => {
    const now = new Date("2025-07-01T00:00:00Z");
    const subs: SealedSubmission[] = [
      { id: "s1", party: "owner", commitment: "x", committedAt: now, revealed: null },
      { id: "s2", party: "tenant", commitment: "y", committedAt: now, revealed: null },
    ];
    expect(canReveal(subs, ["owner", "tenant"], now)).toBe(true);
  });

  it("holds the reveal shut while one side is still outstanding", () => {
    const now = new Date("2025-07-01T00:00:00Z");
    const subs: SealedSubmission[] = [
      { id: "s1", party: "owner", commitment: "x", committedAt: now, revealed: null },
    ];
    expect(canReveal(subs, ["owner", "tenant"], now)).toBe(false);
  });

  it("opens anyway once the window expires, so a silent party cannot stall", () => {
    const committedAt = new Date("2025-07-01T00:00:00Z");
    const later = new Date("2025-07-04T01:00:00Z"); // >72h
    const subs: SealedSubmission[] = [
      { id: "s1", party: "owner", commitment: "x", committedAt, revealed: null },
    ];
    expect(canReveal(subs, ["owner", "tenant"], later)).toBe(true);
  });
});
