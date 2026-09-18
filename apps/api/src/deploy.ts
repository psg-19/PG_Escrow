import "./load-env.js";

import { privateKeyToAccount } from "viem/accounts";
import { rupees, formatPaise } from "@pg/core";
import { createDb, migrate, deployments } from "@pg/db";
import { artifact, publicClient, walletFor, isChainUp, CHAIN, RPC_URL } from "./chain.js";
import { oracleKey, platformKey } from "./chains.js";
import { eq } from "drizzle-orm";
import type { Address } from "viem";

/**
 * Deploys the contracts and records where they landed.
 *
 * Run after `npm run chain`. Accounts fund themselves at signup, so this only
 * has to put the contracts somewhere the API can find them.
 */
async function main() {
  if (!(await isChainUp())) {
    console.error("No chain at the RPC endpoint. Start one first:\n\n  npm run chain\n");
    process.exit(1);
  }

  const handle = createDb();
  await migrate(handle);

  const platform = walletFor(platformKey());
  const oracle = privateKeyToAccount(oracleKey()).address;

  async function deploy(name: string, args: unknown[]): Promise<Address> {
    const { abi, bytecode } = artifact(name);
    const hash = await platform.deployContract({
      abi,
      bytecode,
      args,
      account: platform.account!,
      chain: CHAIN,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error(`${name} deployment produced no address`);
    return receipt.contractAddress;
  }

  const token = await deploy("MockINRC", []);
  const escrow = await deploy("PGEscrow", [token, oracle, platform.account!.address]);

  console.log(`\n  chain      ${CHAIN.name} (${CHAIN.id}) via ${RPC_URL}`);
  console.log(`  MockINRC   ${token}`);
  console.log(`  PGEscrow   ${escrow}`);
  console.log(`  oracle     ${oracle}`);

  // Accounts are funded when they sign up, not here — there are no fixed
  // identities any more.

  const chainId = await publicClient.getChainId();
  await handle.db.delete(deployments).where(eq(deployments.id, "current"));
  await handle.db.insert(deployments).values({
    id: "current",
    chainId,
    escrowAddress: escrow,
    tokenAddress: token,
    oracleAddress: oracle,
    deployedAt: new Date(),
  });

  console.log(`\n  Recorded for chain ${chainId}. The API will pick this up.\n`);
  handle.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
