/** Where a photo sits in the inventory, and how it was framed. */
export interface CapturePose {
  /** Device orientation in degrees at capture time. */
  alpha: number;
  beta: number;
  gamma: number;
  /** Normalised framing box the capture UI guided the user to fill. */
  frame: { x: number; y: number; w: number; h: number };
}

export type CaptureStage = "MOVE_IN" | "MOVE_OUT";

export interface EvidencePhoto {
  id: string;
  itemId: string;
  slot: string;
  stage: CaptureStage;
  /** sha256 of the image bytes, lowercase hex, no prefix. */
  sha256: string;
  /** Server clock, not the device's — devices lie. */
  capturedAt: Date;
  capturedBy: string;
  pose: CapturePose;
  storageKey: string;
}

export interface EvidenceManifest {
  agreementId: string;
  stage: CaptureStage;
  photos: EvidencePhoto[];
  /** Merkle root over the sorted leaf hashes, 0x-prefixed. */
  root: `0x${string}`;
}

/** Result of checking a move-out shot against its move-in counterpart. */
export interface FramingCheck {
  slot: string;
  itemId: string;
  /** 0 = identical framing, 1 = completely different. */
  delta: number;
  acceptable: boolean;
  reason: string;
}
