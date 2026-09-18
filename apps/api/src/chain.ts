import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { eq } from "drizzle-orm";
import { deployments, type DbHandle } from "@pg/db";
import { chainProfile, platformKey } from "./chains.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = resolve(HERE, "../../../packages/contracts");

const profile = chainProfile();
export const CHAIN = profile.chain;
export const RPC_URL = profile.rpcUrl;
export const IS_LOCAL_CHAIN = profile.isLocal;
export const explorerTxUrl = profile.explorerTxUrl;

export function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const path = resolve(CONTRACTS, `artifacts/contracts/${name}.sol/${name}.json`);
  const json = JSON.parse(readFileSync(path, "utf8"));
  return { abi: json.abi as Abi, bytecode: json.bytecode as Hex };
}

export const publicClient = createPublicClient({ chain: CHAIN, transport: http(RPC_URL) });

export function walletFor(key: Hex) {
  return createWalletClient({
    account: privateKeyToAccount(key),
    chain: CHAIN,
    transport: http(RPC_URL),
  });
}

export interface Deployment {
  chainId: number;
  escrowAddress: Address;
  tokenAddress: Address;
  oracleAddress: Address;
}

/**
 * Where the contracts live.
 *
 * Read from the database rather than an environment variable so the API and the
 * deploy step cannot disagree about which escrow they are talking to — pointing
 * a running API at a stale address would mean reading one contract's state while
 * writing to another.
 */
export async function loadDeployment(handle: DbHandle): Promise<Deployment | null> {
  const [row] = await handle.db.select().from(deployments).where(eq(deployments.id, "current"));
  if (!row) return null;
  return {
    chainId: row.chainId,
    escrowAddress: row.escrowAddress as Address,
    tokenAddress: row.tokenAddress as Address,
    oracleAddress: row.oracleAddress as Address,
  };
}

export class ChainUnavailableError extends Error {}

export async function requireDeployment(handle: DbHandle): Promise<Deployment> {
  const d = await loadDeployment(handle);
  if (!d) {
    throw new ChainUnavailableError(
      "No contracts deployed. Start a chain with `npm run chain`, then `npm run deploy`."
    );
  }
  return d;
}

/**
 * Sends a transaction on behalf of a key holder.
 *
 * For a signed-in user that key is custodial — see the note on the users table.
 * Simulates first so a contract revert surfaces as a readable reason instead of
 * a failed transaction nobody can interpret.
 */
export async function sendAs(
  holder: { privateKey: Hex },
  address: Address,
  abi: Abi,
  functionName: string,
  args: unknown[]
) {
  const wallet = walletFor(holder.privateKey);

  const { request } = await publicClient.simulateContract({
    address,
    abi,
    functionName,
    args,
    account: wallet.account!,
  });

  const hash = await wallet.writeContract(request);
  return publicClient.waitForTransactionReceipt({ hash });
}

export async function readContract<T>(
  address: Address,
  abi: Abi,
  functionName: string,
  args: unknown[] = []
): Promise<T> {
  return (await publicClient.readContract({ address, abi, functionName, args })) as T;
}

export async function tokenBalance(token: Address, who: Address): Promise<bigint> {
  const { abi } = artifact("MockINRC");
  return readContract<bigint>(token, abi, "balanceOf", [who]);
}

export const platformWallet = () => walletFor(platformKey());

/**
 * Native currency handed to a new account, sized for the chain.
 *
 * A flat 1 ETH is fine on a local node and ruinous on a testnet, where the
 * platform wallet is refilled by hand from a faucet.
 */
const GAS_GRANT_WEI = profile.gasGrantWei;

/**
 * Makes a newly created wallet usable.
 *
 * Two separate things are needed and it is easy to remember only one: the
 * rupee-denominated token the escrow moves, *and* native currency to pay gas
 * with. A freshly generated key has neither, so without the gas transfer every
 * write from a new account fails at the node with an error that says nothing
 * about the actual cause.
 */
export async function fundWallet(
  token: Address,
  to: Address,
  amountPaise = 50_000_000n
): Promise<void> {
  const wallet = walletFor(platformKey());

  const gasHash = await wallet.sendTransaction({
    to,
    value: GAS_GRANT_WEI,
    account: wallet.account!,
    chain: CHAIN,
  });
  await publicClient.waitForTransactionReceipt({ hash: gasHash });

  const { abi } = artifact("MockINRC");
  const mintHash = await wallet.writeContract({
    address: token,
    abi,
    functionName: "mint",
    args: [to, amountPaise],
    account: wallet.account!,
    chain: CHAIN,
  });
  await publicClient.waitForTransactionReceipt({ hash: mintHash });
}

/** Chain time, which the verdict deadline must be measured against. */
export async function chainNowSeconds(): Promise<bigint> {
  const block = await publicClient.getBlock();
  return block.timestamp;
}

/**
 * Fast-forwards the local chain.
 *
 * A tenancy takes months and a demo takes minutes, so the UI needs a way to skip
 * the 48-hour rent hold and the 72-hour claims window. Only works on a dev node;
 * the route that exposes it says so.
 */
export async function advanceTime(seconds: number): Promise<void> {
  if (!IS_LOCAL_CHAIN) {
    // Real chains have real clocks. Pretending otherwise would silently do
    // nothing and leave someone waiting 48 hours wondering why.
    throw new Error(
      `Time cannot be skipped on ${profile.name}. The rent hold and claims window are real hours here.`
    );
  }
  await publicClient.request({ method: "evm_increaseTime" as never, params: [seconds] as never });
  await publicClient.request({ method: "evm_mine" as never, params: [] as never });
}

export async function isChainUp(): Promise<boolean> {
  try {
    await publicClient.getBlockNumber();
    return true;
  } catch {
    return false;
  }
}
