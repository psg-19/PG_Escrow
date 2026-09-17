import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox-viem";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// The repo-root .env holds the deploy key and RPC URL. Hardhat only reads its
// own directory, so load it explicitly or every network config comes out empty.
const rootEnv = resolve(__dirname, "../../.env");
if (existsSync(rootEnv)) {
  try {
    process.loadEnvFile(rootEnv);
  } catch {
    /* malformed .env should not break compilation */
  }
}

const deployKey = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = deployKey ? [deployKey] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // OpenZeppelin 5.x emits mcopy, which needs Cancun.
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      // Deterministic timestamps make the 48h rent-hold tests readable.
      allowBlocksWithSameTimestamp: false,
    },

    /** A node you started yourself with `npm run chain`. */
    localhost: {
      url: "http://127.0.0.1:8545",
    },

    /**
     * Base Sepolia — the default testnet target.
     *
     * Cheap, fast, and its faucets do not demand mainnet history. Test ether
     * has no value, which matters here: the escrow holds a mock rupee token, so
     * nothing on this chain is worth stealing even though the server holds
     * every user's key.
     */
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
      chainId: 84532,
      accounts,
    },

    /** Polygon Amoy, if you would rather not be on Base. */
    polygonAmoy: {
      url: process.env.POLYGON_AMOY_RPC_URL ?? "https://rpc-amoy.polygon.technology",
      chainId: 80002,
      accounts,
    },
  },
};

export default config;
