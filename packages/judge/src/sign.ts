import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";

/**
 * EIP-712 verdict signing — the last stage of the pipeline.
 *
 * The judge service signs but does not submit. Anyone can carry a signed verdict
 * on-chain, which decouples the gas payer from the signer and puts the full
 * payload in calldata where it stays auditable. The contract re-derives this
 * same digest and checks it recovers to the registered oracle address.
 */

export const VERDICT_TYPES = {
  Verdict: [
    { name: "disputeId", type: "uint256" },
    { name: "toOwnerPaise", type: "uint256" },
    { name: "toTenantPaise", type: "uint256" },
    { name: "rationaleHash", type: "bytes32" },
    { name: "evidenceRoot", type: "bytes32" },
    { name: "nonce", type: "uint64" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export interface SignedVerdict {
  disputeId: bigint;
  toOwnerPaise: bigint;
  toTenantPaise: bigint;
  rationaleHash: Hex;
  evidenceRoot: Hex;
  nonce: bigint;
  deadline: bigint;
  signature: Hex;
}

export interface SignVerdictParams {
  oraclePrivateKey: Hex;
  chainId: number;
  escrowAddress: Address;
  disputeId: bigint;
  toOwnerPaise: bigint;
  toTenantPaise: bigint;
  rationaleHash: Hex;
  evidenceRoot: Hex;
  nonce: bigint;
  /** Seconds the signature stays valid. Short, so a stale verdict cannot sit around. */
  ttlSeconds?: number;
  /**
   * Current *chain* time in seconds, for the deadline.
   *
   * The contract checks the deadline against `block.timestamp`, so deriving it
   * from the signer's wall clock is wrong whenever the two disagree — which is
   * routinely on test chains and can happen on L2s under load. Callers should
   * pass the latest block's timestamp. Defaults to wall clock for convenience.
   */
  nowSeconds?: bigint;
}

export async function signVerdict(params: SignVerdictParams): Promise<SignedVerdict> {
  const {
    oraclePrivateKey,
    chainId,
    escrowAddress,
    ttlSeconds = 3600,
    nowSeconds,
    ...verdict
  } = params;

  // Refuse to sign something the contract would reject anyway — catching it here
  // gives a readable error instead of an opaque on-chain revert.
  if (verdict.toOwnerPaise < 0n || verdict.toTenantPaise < 0n) {
    throw new Error("Verdict splits cannot be negative");
  }

  const account = privateKeyToAccount(oraclePrivateKey);
  const base = nowSeconds ?? BigInt(Math.floor(Date.now() / 1000));
  const deadline = base + BigInt(ttlSeconds);

  const message = { ...verdict, deadline };

  const signature = await account.signTypedData({
    domain: {
      name: "PGEscrow",
      version: "1",
      chainId,
      verifyingContract: escrowAddress,
    },
    types: VERDICT_TYPES,
    primaryType: "Verdict",
    message,
  });

  return { ...message, signature };
}

export function oracleAddress(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}
