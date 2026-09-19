import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { schema } from "./schema.js";

export type Database = LibSQLDatabase<typeof schema>;

/**
 * DDL applied at startup.
 *
 * Kept as plain SQL rather than a drizzle-kit migration folder so the demo is a
 * single command with nothing to generate first. A real deployment wants proper
 * versioned migrations; this is the hackathon trade, made knowingly.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS agreements (
  id TEXT PRIMARY KEY,
  chain_id TEXT NOT NULL,
  tenant_address TEXT NOT NULL,
  owner_address TEXT NOT NULL,
  tenant_name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  property_label TEXT NOT NULL,
  room_id TEXT,
  rent_paise TEXT NOT NULL,
  deposit_paise TEXT NOT NULL,
  notice_days INTEGER NOT NULL,
  late_fee_rate_bps INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'DRAFT',
  move_in_root TEXT,
  move_out_root TEXT,
  start_at INTEGER,
  notice_given_at INTEGER,
  move_out_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agreements_tenant_idx ON agreements (tenant_address);
CREATE INDEX IF NOT EXISTS agreements_owner_idx ON agreements (owner_address);

CREATE TABLE IF NOT EXISTS inventory_items (
  id TEXT PRIMARY KEY,
  agreement_id TEXT NOT NULL,
  category TEXT NOT NULL,
  label TEXT NOT NULL,
  age_months INTEGER NOT NULL,
  replacement_cost_paise TEXT NOT NULL,
  condition_at_move_in TEXT NOT NULL,
  photo_slots TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_agreement_idx ON inventory_items (agreement_id);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  agreement_id TEXT NOT NULL,
  cycle_index INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  amount_paise TEXT NOT NULL,
  paid_at INTEGER,
  chain_payment_id TEXT,
  released_at INTEGER
);
CREATE INDEX IF NOT EXISTS ledger_agreement_idx ON ledger_entries (agreement_id);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  agreement_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  slot TEXT NOT NULL,
  stage TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  media_type TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  captured_by TEXT NOT NULL,
  pose TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_agreement_idx ON photos (agreement_id);
CREATE INDEX IF NOT EXISTS photos_slot_idx ON photos (item_id, slot, stage);

CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  agreement_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  claim_text TEXT,
  commitment TEXT NOT NULL,
  salt TEXT,
  committed_at INTEGER NOT NULL,
  revealed_at INTEGER
);
CREATE INDEX IF NOT EXISTS claims_agreement_idx ON claims (agreement_id);

CREATE TABLE IF NOT EXISTS rebuttals (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  rebuttal_text TEXT,
  commitment TEXT NOT NULL,
  salt TEXT,
  committed_at INTEGER NOT NULL,
  revealed_at INTEGER
);

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  agreement_id TEXT NOT NULL,
  chain_dispute_id TEXT,
  kind TEXT NOT NULL,
  pool_paise TEXT NOT NULL,
  claims_root TEXT NOT NULL,
  evidence_root TEXT NOT NULL,
  raised_by TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS disputes_agreement_idx ON disputes (agreement_id);

CREATE TABLE IF NOT EXISTS verdicts (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL,
  to_owner_paise TEXT NOT NULL,
  to_tenant_paise TEXT NOT NULL,
  rationale TEXT NOT NULL,
  rationale_hash TEXT NOT NULL,
  evidence_root TEXT NOT NULL,
  audit_json TEXT NOT NULL,
  adjudication_model TEXT NOT NULL,
  rubric_version TEXT NOT NULL,
  depreciation_schedule_version TEXT NOT NULL,
  signature TEXT,
  nonce TEXT,
  tx_hash TEXT,
  decided_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS verdicts_dispute_idx ON verdicts (dispute_id);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT,
  password_salt TEXT,
  supabase_id TEXT,
  avatar_url TEXT,
  wallet_address TEXT NOT NULL,
  custodial_private_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS users_email_idx ON users (email);
CREATE INDEX IF NOT EXISTS users_wallet_idx ON users (wallet_address);
CREATE INDEX IF NOT EXISTS users_supabase_idx ON users (supabase_id);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  owner_address TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  title TEXT NOT NULL,
  locality TEXT NOT NULL,
  city TEXT NOT NULL,
  description TEXT NOT NULL,
  amenities TEXT NOT NULL,
  gender_policy TEXT NOT NULL DEFAULT 'ANY',
  notice_days INTEGER NOT NULL,
  late_fee_rate_bps INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS listings_city_idx ON listings (city);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL,
  label TEXT NOT NULL,
  occupancy TEXT NOT NULL,
  rent_paise TEXT NOT NULL,
  deposit_paise TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'VACANT',
  inventory_template TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rooms_listing_idx ON rooms (listing_id);

CREATE TABLE IF NOT EXISTS rental_requests (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  tenant_address TEXT NOT NULL,
  tenant_name TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  agreement_id TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS requests_room_idx ON rental_requests (room_id);
CREATE INDEX IF NOT EXISTS requests_tenant_idx ON rental_requests (tenant_address);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  escrow_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  oracle_address TEXT NOT NULL,
  deployed_at INTEGER NOT NULL
);
`;

export interface DbHandle {
  db: Database;
  client: Client;
  close(): void;
}

/**
 * Absolute path to the shared database file.
 *
 * Resolved from this module's own location rather than from cwd, because npm
 * workspace scripts run each package from its own directory — a relative path
 * here silently resolves somewhere different for every caller, which is exactly
 * the bug that made the API open a database the demo had never written to.
 */
export function defaultDbUrl(): string {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  return `file:${resolve(repoRoot, "pg-escrow.db")}`;
}

/**
 * Opens the database.
 *
 * A `file:` URL is a local SQLite file; a `libsql://` URL is hosted Turso and
 * needs an auth token alongside it. Both go through the same client, so moving
 * from a laptop to a deployment is two environment variables rather than a
 * different driver.
 */
export function createDb(url = process.env.DATABASE_URL ?? defaultDbUrl()): DbHandle {
  const authToken = process.env.DATABASE_AUTH_TOKEN;
  const remote = !url.startsWith("file:");

  if (remote && !authToken) {
    throw new Error(
      `DATABASE_URL points at ${url.split("://")[0]}:// but DATABASE_AUTH_TOKEN is not set. ` +
        `A hosted database will refuse the connection without it.`
    );
  }

  const client = createClient(authToken ? { url, authToken } : { url });
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.close() };
}

/** For the startup banner: says where data is going without leaking the token. */
export function describeDatabase(url = process.env.DATABASE_URL ?? defaultDbUrl()): string {
  if (url.startsWith("file:")) {
    return `Database: local file (${url.replace("file:", "")}) — ephemeral on most hosts`;
  }
  return `Database: ${url.replace(/\?.*$/, "")}`;
}

export async function migrate(handle: DbHandle): Promise<void> {
  for (const stmt of DDL.split(";")) {
    const trimmed = stmt.trim();
    if (trimmed) await handle.client.execute(trimmed);
  }
}

export async function reset(handle: DbHandle): Promise<void> {
  const tables = [
    "sessions",
    "users",
    "deployments",
    "rental_requests",
    "rooms",
    "listings",
    "verdicts",
    "disputes",
    "rebuttals",
    "claims",
    "photos",
    "ledger_entries",
    "inventory_items",
    "agreements",
  ];
  for (const t of tables) {
    await handle.client.execute(`DROP TABLE IF EXISTS ${t}`);
  }
  await migrate(handle);
}
