import type { Paise } from "./money.js";

/**
 * The seam between business logic and whoever is actually holding the money.
 *
 * Only ChainEscrowProvider is built today, but keeping this interface means the
 * ledger and the state machine never learn what rails they are on. Swapping to a
 * regulated INR escrow partner later is a new file, not a rewrite.
 */
export type PartyId = string;

export interface EscrowTerms {
  tenant: PartyId;
  owner: PartyId;
  rentPaise: Paise;
  depositPaise: Paise;
  noticeDays: number;
}

export interface EscrowRef {
  provider: string;
  externalId: string;
}

export interface TxRef {
  provider: string;
  reference: string;
  at: Date;
}

export interface Split {
  party: PartyId;
  amountPaise: Paise;
}

export interface EscrowProvider {
  readonly name: string;
  createEscrow(agreementId: string, terms: EscrowTerms): Promise<EscrowRef>;
  fund(ref: EscrowRef, amountPaise: Paise, payer: PartyId): Promise<TxRef>;
  release(ref: EscrowRef, splits: readonly Split[]): Promise<TxRef>;
  balance(ref: EscrowRef): Promise<Paise>;
}

/** Rejects any release that does not conserve the escrowed amount. */
export function assertConserves(splits: readonly Split[], expected: Paise): void {
  const total = splits.reduce((a, s) => a + s.amountPaise, 0n);
  if (total !== expected) {
    throw new Error(`Release splits sum to ${total} paise but escrow holds ${expected}`);
  }
}
