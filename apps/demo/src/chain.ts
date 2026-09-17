import { spawn, type ChildProcess } from "node:child_process";
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
import { hardhat } from "viem/chains";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACTS = resolve(HERE, "../../../packages/contracts");
const RPC = "http://127.0.0.1:8545";

/** Hardhat's deterministic accounts — dev only, publicly known keys. */
export const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex,
  tenant: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex,
  owner: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex,
  oracle: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" as Hex,
} as const;

export function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const path = resolve(CONTRACTS, `artifacts/contracts/${name}.sol/${name}.json`);
  const json = JSON.parse(readFileSync(path, "utf8"));
  return { abi: json.abi as Abi, bytecode: json.bytecode as Hex };
}

export type Chain = Awaited<ReturnType<typeof startChain>>;

/**
 * Starts a local node and waits for it to answer.
 *
 * Spawned rather than assumed to be running, so the whole demo is one command
 * with nothing to set up first — which is the point of a demo.
 */
export async function startChain() {
  // detached puts the node in its own process group. npx spawns hardhat as a
  // child, and signalling only npx leaves that child holding port 8545 — which
  // breaks the next run. Killing the group takes both down.
  const proc: ChildProcess = spawn("npx", ["hardhat", "node", "--port", "8545"], {
    cwd: CONTRACTS,
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });

  const publicClient = createPublicClient({ chain: hardhat, transport: http(RPC) });

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await publicClient.getBlockNumber();
      break;
    } catch {
      if (Date.now() > deadline) {
        if (proc.pid !== undefined) {
          try {
            process.kill(-proc.pid, "SIGTERM");
          } catch {
            /* already gone */
          }
        }
        throw new Error(
          "Local chain did not come up within 60s. Is port 8545 already in use?"
        );
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const wallet = (key: Hex) =>
    createWalletClient({ account: privateKeyToAccount(key), chain: hardhat, transport: http(RPC) });

  const wallets = {
    deployer: wallet(KEYS.deployer),
    tenant: wallet(KEYS.tenant),
    owner: wallet(KEYS.owner),
    oracle: wallet(KEYS.oracle),
  };

  const addresses: Record<keyof typeof KEYS, Address> = {
    deployer: privateKeyToAccount(KEYS.deployer).address,
    tenant: privateKeyToAccount(KEYS.tenant).address,
    owner: privateKeyToAccount(KEYS.owner).address,
    oracle: privateKeyToAccount(KEYS.oracle).address,
  };

  /** Moves the chain clock forward. Three months of tenancy in milliseconds. */
  async function advance(seconds: number) {
    await publicClient.request({ method: "evm_increaseTime" as never, params: [seconds] as never });
    await publicClient.request({ method: "evm_mine" as never, params: [] as never });
  }

  async function deploy(name: string, args: unknown[]): Promise<Address> {
    const { abi, bytecode } = artifact(name);
    const hash = await wallets.deployer.deployContract({
      abi,
      bytecode,
      args,
      account: wallets.deployer.account!,
      chain: hardhat,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error(`${name} deployment produced no address`);
    return receipt.contractAddress;
  }

  async function send(
    address: Address,
    abi: Abi,
    functionName: string,
    args: unknown[],
    as: keyof typeof KEYS
  ) {
    const wallet = wallets[as];
    const hash = await wallet.writeContract({
      address,
      abi,
      functionName,
      args,
      account: wallet.account!,
      chain: hardhat,
    });
    return publicClient.waitForTransactionReceipt({ hash });
  }

  return {
    proc,
    publicClient,
    wallets,
    addresses,
    advance,
    deploy,
    send,
    stop: () => {
      if (proc.pid === undefined) return;
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        // Already gone, or the group was never created. Nothing to clean up.
      }
    },
  };
}
