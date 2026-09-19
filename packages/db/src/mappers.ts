import type {
  AgreementTerms,
  Condition,
  InventoryItem,
  ItemCategory,
  LedgerEntry,
  TenancyFacts,
} from "@pg/core";
import type { CapturePose, EvidencePhoto } from "@pg/evidence";

type AgreementRow = {
  id: string;
  rentPaise: string;
  depositPaise: string;
  noticeDays: number;
  lateFeeRateBps: number;
  startAt: Date | null;
  noticeGivenAt: Date | null;
  moveOutAt: Date | null;
};

type ItemRow = {
  id: string;
  category: string;
  label: string;
  ageMonths: number;
  replacementCostPaise: string;
  conditionAtMoveIn: string;
  photoSlots: string;
};

type LedgerRow = {
  cycleIndex: number;
  dueAt: Date;
  amountPaise: string;
  paidAt: Date | null;
};

type PhotoRow = {
  id: string;
  itemId: string;
  slot: string;
  stage: "MOVE_IN" | "MOVE_OUT";
  sha256: string;
  capturedAt: Date;
  capturedBy: string;
  pose: string;
  storageKey: string;
};

const MS_PER_MONTH = 30 * 24 * 60 * 60 * 1000;

export function toItem(row: ItemRow): InventoryItem {
  return {
    id: row.id,
    category: row.category as ItemCategory,
    label: row.label,
    ageMonths: row.ageMonths,
    replacementCostPaise: BigInt(row.replacementCostPaise),
    conditionAtMoveIn: row.conditionAtMoveIn as Condition,
    photoSlots: JSON.parse(row.photoSlots) as string[],
  };
}

export function toLedgerEntry(row: LedgerRow): LedgerEntry {
  return {
    cycleIndex: row.cycleIndex,
    dueAt: row.dueAt,
    amountPaise: BigInt(row.amountPaise),
    paidAt: row.paidAt,
  };
}

export function toTerms(row: AgreementRow): AgreementTerms {
  return {
    id: row.id,
    rentPaise: BigInt(row.rentPaise),
    depositPaise: BigInt(row.depositPaise),
    noticeDays: row.noticeDays,
    lateFeeRate: row.lateFeeRateBps / 10_000,
    startAt: row.startAt ?? new Date(0),
  };
}

export function toPhoto(row: PhotoRow): EvidencePhoto {
  return {
    id: row.id,
    itemId: row.itemId,
    slot: row.slot,
    stage: row.stage,
    sha256: row.sha256,
    capturedAt: row.capturedAt,
    capturedBy: row.capturedBy,
    pose: JSON.parse(row.pose) as CapturePose,
    storageKey: row.storageKey,
  };
}

/**
 * Assembles the input the rules engine needs.
 *
 * `occupiedMonths` is derived from the actual dates rather than stored, so it
 * cannot drift out of step with the tenancy it describes — and it is what every
 * depreciation ceiling is computed from.
 */
export function toTenancyFacts(input: {
  agreement: AgreementRow;
  items: ItemRow[];
  ledger: LedgerRow[];
}): TenancyFacts {
  const { agreement } = input;
  const moveOutAt = agreement.moveOutAt ?? new Date();
  const startAt = agreement.startAt ?? moveOutAt;

  return {
    terms: toTerms(agreement),
    ledger: input.ledger.map(toLedgerEntry),
    items: input.items.map(toItem),
    noticeGivenAt: agreement.noticeGivenAt,
    moveOutAt,
    occupiedMonths: Math.max(
      0,
      Math.round((moveOutAt.getTime() - startAt.getTime()) / MS_PER_MONTH)
    ),
  };
}
