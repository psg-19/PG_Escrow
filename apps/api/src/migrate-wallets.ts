import { loadEnv } from "./env.js";
import { createDb, migrate } from "@pg/db";
import { migrateWalletKeys } from "./wallet-migration.js";

loadEnv();
const handle = createDb();
try {
  await migrate(handle);
  console.log(await migrateWalletKeys(handle));
  console.log("Migration complete. Securely retire old plaintext database backups and WAL files.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Wallet migration failed");
  process.exitCode = 1;
} finally { handle.close(); }
