// Must run before anything reads process.env.
import { env } from "./load-env.js";
import { describeJudgeConfig, describeGoogleConfig } from "./env.js";

import { serve } from "@hono/node-server";
import { createDb, migrate, describeDatabase } from "@pg/db";
import { createApp } from "./app.js";
import { describeStorage } from "./storage.js";
import { CHAIN, RPC_URL } from "./chain.js";

import { walletProtection } from "./kms.js";

// Validate before accepting requests. No silent plaintext fallback in production.
const protection = walletProtection();
const storage = describeStorage();
const handle = createDb();
await migrate(handle);

const port = Number(process.env.PORT ?? 4000);
serve({ fetch: createApp(handle).fetch, port });

console.log(`API listening on http://127.0.0.1:${port}`);
console.log(env.loaded ? `  env: ${env.path}` : `  env: no .env found at ${env.path}`);
console.log(`  ${describeJudgeConfig()}`);
console.log(`  ${describeGoogleConfig()}`);
console.log(`  ${describeDatabase()}`);
console.log(`  ${storage}`);
console.log(`  Wallet key protection: ${protection}`);
console.log(`  Chain: ${CHAIN.name} (${CHAIN.id}) via ${RPC_URL}`);
