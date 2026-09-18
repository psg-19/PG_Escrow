import { defineChain, type Chain } from "viem";
import { hardhat, baseSepolia, polygonAmoy } from "viem/chains";

/**
 * Which chain this instance talks to, and how much it hands out.
 *
 * Everything else in the API was written against a local node where ether is
 * free and infinite. On a testnet neither is true: the platform wallet holds a
 * finite balance from a faucet, and every signup spends some of it. Getting the
 * grant wrong is the difference between a wallet that lasts for months of
 * demos and one that empties after twenty signups.
 */

export type ChainName = "localhost" | "baseSepolia" | "polygonAmoy";

export interface ChainProfile {
  name: ChainName;
  chain: Chain;
  rpcUrl: string;
  /** Native currency handed to a new account so it can pay gas. */
  gasGrantWei: bigint;
  /** Block explorer, for linking a transaction somewhere useful. */
  explorerTxUrl: (hash: string) => string | null;
  isLocal: boolean;
}

const LOCAL_RPC = "http://127.0.0.1:8545";

function resolveName(): ChainName {
  const explicit = process.env.CHAIN as ChainName | undefined;
  if (explicit === "baseSepolia" || explicit === "polygonAmoy" || explicit === "localhost") {
    return explicit;
  }
  // Inferring from the RPC URL means a deployment that sets only RPC_URL still
  // lands on the right chain rather than silently assuming localhost.
  const rpc = process.env.RPC_URL ?? "";
  if (/base.*sepolia/i.test(rpc)) return "baseSepolia";
  if (/amoy|polygon/i.test(rpc)) return "polygonAmoy";
  return "localhost";
}

export function chainProfile(): ChainProfile {
  const name = resolveName();

  switch (name) {
    case "baseSepolia":
      return {
        name,
        chain: baseSepolia,
        rpcUrl: process.env.RPC_URL ?? "https://sepolia.base.org",
        // ~0.002 ETH: enough for well over a hundred escrow transactions at
        // Base's fees, and small enough that a 0.1 ETH faucet drip covers
        // fifty signups.
        gasGrantWei: 2_000_000_000_000_000n,
        explorerTxUrl: (h) => `https://sepolia.basescan.org/tx/${h}`,
        isLocal: false,
      };

    case "polygonAmoy":
      return {
        name,
        chain: polygonAmoy,
        rpcUrl: process.env.RPC_URL ?? "https://rpc-amoy.polygon.technology",
        gasGrantWei: 100_000_000_000_000_000n, // 0.1 POL — Amoy fees are higher
        explorerTxUrl: (h) => `https://amoy.polygonscan.com/tx/${h}`,
        isLocal: false,
      };

    default:
      return {
        name: "localhost",
        chain: defineChain({ ...hardhat, id: Number(process.env.CHAIN_ID ?? hardhat.id) }),
        rpcUrl: process.env.RPC_URL ?? LOCAL_RPC,
        // Free and meaningless locally, so be generous.
        gasGrantWei: 10n ** 18n,
        explorerTxUrl: () => null,
        isLocal: true,
      };
  }
}

/**
 * The key the platform signs with.
 *
 * On a local node this can stay the well-known Hardhat account. Anywhere else
 * that would be catastrophic — those keys are public — so a real deployment has
 * to supply its own and the code refuses to start without one.
 */
export function platformKey(): `0x${string}` {
  const profile = chainProfile();
  const supplied = process.env.PLATFORM_PRIVATE_KEY as `0x${string}` | undefined;

  if (supplied) return supplied;

  if (!profile.isLocal) {
    throw new Error(
      `PLATFORM_PRIVATE_KEY is required on ${profile.name}. The built-in key is a ` +
        `publicly known Hardhat development key and must never hold real funds.`
    );
  }

  return "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
}

/** The adjudicator's signing identity, registered on the escrow as its oracle. */
export function oracleKey(): `0x${string}` {
  const profile = chainProfile();
  const supplied = process.env.ORACLE_PRIVATE_KEY as `0x${string}` | undefined;

  if (supplied) return supplied;

  if (!profile.isLocal) {
    throw new Error(
      `ORACLE_PRIVATE_KEY is required on ${profile.name}. Whoever holds this key can ` +
        `sign verdicts that move deposits.`
    );
  }

  return "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
}
