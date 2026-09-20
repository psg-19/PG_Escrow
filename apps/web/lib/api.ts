import { cookies } from "next/headers";

const BASE = process.env.API_URL ?? "http://127.0.0.1:4000";

export const API_BASE = BASE;

/**
 * Server-side fetch against the escrow API.
 *
 * The session cookie is forwarded by hand. These requests originate on the Next
 * server rather than in the browser, so nothing attaches it automatically —
 * without this, every server-rendered page renders as if signed out even when
 * the visitor has a perfectly good session.
 *
 * `no-store` throughout: this is money and dispute state, and a stale deposit
 * balance is worse than a slow one.
 */
async function get<T>(path: string): Promise<T | null> {
  try {
    const store = await cookies();
    const header = store
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");

    const res = await fetch(`${BASE}${path}`, {
      cache: "no-store",
      headers: header ? { cookie: header } : {},
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface AgreementSummary {
  id: string;
  tenantAddress?: string;
  ownerAddress?: string;
  propertyLabel: string;
  tenantName: string;
  ownerName: string;
  state: string;
  rentDisplay: string;
  depositDisplay: string;
}

export interface ItemView {
  id: string;
  label: string;
  category: string;
  ageMonths: number;
  conditionAtMoveIn: string;
  replacementCostDisplay: string;
  ceilingDisplay: string;
  atEndOfLife: boolean;
  photoSlots: string[];
}

export interface AgreementDetail extends AgreementSummary {
  chainId: string;
  tenantAddress: string;
  ownerAddress: string;
  noticeDays: number;
  moveInRoot: string | null;
  moveOutRoot: string | null;
  startAt: string | null;
  noticeGivenAt: string | null;
  moveOutAt: string | null;
  occupiedMonths: number;
  items: ItemView[];
  ledger: {
    cycleIndex: number;
    dueAt: string;
    paidAt: string | null;
    releasedAt: string | null;
    amountDisplay: string;
    coversUntil: string | null;
  }[];
  claims: ClaimView[];
  dispute: { id: string; chainDisputeId: string | null; resolvedAt: string | null } | null;
  rentCycle: {
    index: number;
    payable: boolean;
    reason: string;
    daysUntilDue: number;
    dueAt: string;
    coversUntil: string;
    cycleDays: number;
  };
  photos: {
    id: string;
    itemId: string;
    slot: string;
    stage: "MOVE_IN" | "MOVE_OUT";
    sha256: string;
    capturedBy: string;
  }[];
}

export interface VerdictSummary {
  id: string;
  disputeId: string;
  toOwnerDisplay: string;
  toTenantDisplay: string;
  adjudicationModel: string;
  rubricVersion: string;
  rationaleHash: string;
  txHash: string | null;
  decidedAt: string;
}

export interface PanelistOut {
  claimId?: string;
  recommendedFraction?: number;
  severity?: string;
  damageConfirmed?: boolean;
  fairWearAndTear?: boolean;
  attributableToTenant?: boolean;
  injectionSuspected?: boolean;
  reasoning?: string;
  error?: string;
}

export interface VerdictDetail extends VerdictSummary {
  agreementId: string | null;
  poolDisplay: string | null;
  /** Decimal paise strings. Only ever parsed for display ratios, never arithmetic. */
  toOwnerPaise: string;
  toTenantPaise: string;
  rationale: string;
  evidenceRoot: string;
  depreciationScheduleVersion: string;
  signature: string | null;
  nonce: string | null;
  audit: {
    panels: {
      claimId: string;
      spread: number;
      fallbackApplied: string | null;
      verdict: PanelistOut;
      panelists: Record<string, PanelistOut>;
    }[];
    screens: Record<
      string,
      { claim: { suspicious: boolean; technique: string }; rebuttal: { suspicious: boolean; technique: string } }
    >;
    screeningModel: string;
  };
}

export interface RubricView {
  provider: string;
  rubricVersion: string;
  rubric: string;
  depreciationScheduleVersion: string;
  usefulLifeMonths: Record<string, number>;
  severityCap: Record<string, number>;
  conditionMultiplier: Record<string, number>;
  models: { adjudication: string; screening: string };
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: "OWNER" | "TENANT";
  walletAddress: string;
  balanceDisplay: string | null;
}

export interface ChainStatus {
  chainUp: boolean;
  deployed: boolean;
  escrowAddress: string | null;
  tokenAddress: string | null;
}

export interface ListingSummary {
  id: string;
  isMine: boolean;
  title: string;
  locality: string;
  city: string;
  ownerName: string;
  genderPolicy: string;
  amenities: string[];
  roomCount: number;
  vacantCount: number;
  fromDisplay: string | null;
}

export interface RoomView {
  id: string;
  label: string;
  occupancy: string;
  status: "VACANT" | "RESERVED" | "OCCUPIED";
  rentDisplay: string;
  depositDisplay: string;
  inventoryCount: number;
  pendingRequests: number;
}

export interface ListingDetail extends Omit<ListingSummary, "roomCount" | "vacantCount" | "fromDisplay"> {
  description: string;
  ownerAddress: string;
  noticeDays: number;
  rooms: RoomView[];
}

export interface RequestView {
  id: string;
  roomId: string;
  roomLabel: string;
  listingTitle: string;
  listingId: string | null;
  tenantName: string;
  message: string;
  status: "PENDING" | "ACCEPTED" | "DECLINED" | "WITHDRAWN";
  agreementId: string | null;
  rentDisplay: string;
  depositDisplay: string;
  createdAt: string;
}

export interface ClaimView {
  id: string;
  itemId: string;
  claimText: string | null;
  sealed: boolean;
  commitment: string;
  hasRebuttal: boolean;
  rebuttalText: string | null;
}

export const api = {
  me: async () => (await get<{ user: CurrentUser | null }>("/api/auth/me"))?.user ?? null,
  chain: () => get<ChainStatus>("/api/chain"),
  listings: () => get<ListingSummary[]>("/api/listings"),
  listing: (id: string) => get<ListingDetail>(`/api/listings/${id}`),
  requests: () => get<RequestView[]>("/api/requests"),
  agreements: () => get<AgreementSummary[]>("/api/agreements"),
  agreement: (id: string) => get<AgreementDetail>(`/api/agreements/${id}`),
  verdicts: () => get<VerdictSummary[]>("/api/verdicts"),
  verdict: (id: string) => get<VerdictDetail>(`/api/verdicts/${id}`),
  rubric: () => get<RubricView>("/api/rubric"),
};
