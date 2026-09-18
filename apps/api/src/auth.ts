import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { eq, and, gt } from "drizzle-orm";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { users, sessions, type DbHandle } from "@pg/db";
import type { Address } from "viem";
import { protectWalletKey } from "./kms.js";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: string,
  keylen: number
) => Promise<Buffer>;

export const SESSION_COOKIE = "pg_session";
const SESSION_DAYS = 30;

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 401 | 403 | 409 = 400
  ) {
    super(message);
  }
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: "OWNER" | "TENANT";
  walletAddress: Address;
  /** Stored ciphertext in KMS mode; decrypted only at transaction signing. */
  custodialPrivateKey: string;
  avatarUrl: string | null;
  /** Set when the account arrived through an OAuth provider. */
  supabaseId: string | null;
}

/** Safe to send to the browser. The key never leaves the server. */
export function publicUser(u: SessionUser) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    walletAddress: u.walletAddress,
    avatarUrl: u.avatarUrl,
    signsInWithGoogle: Boolean(u.supabaseId),
  };
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const derived = await scrypt(password, salt, 64);
  return derived.toString("hex");
}

async function verifyPassword(password: string, salt: string, expected: string): Promise<boolean> {
  const actual = Buffer.from(await hashPassword(password, salt), "hex");
  const wanted = Buffer.from(expected, "hex");
  // Constant-time so a wrong password cannot be narrowed down by timing.
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function assertEmail(email: string) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new AuthError("That does not look like an email address");
  }
}

function assertPassword(password: string) {
  if (password.length < 8) {
    throw new AuthError("Use at least 8 characters");
  }
}

export interface SignupInput {
  email: string;
  password: string;
  name: string;
  role: "OWNER" | "TENANT";
}

/**
 * Creates an account and the wallet it will transact with.
 *
 * The wallet is generated here rather than asked for, because requiring a
 * browser extension before someone can even look at a room would stop most
 * people at the door. The trade is custody — see the note on the users table.
 */
export async function signup(
  handle: DbHandle,
  input: SignupInput
): Promise<{ user: SessionUser; token: string }> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();

  assertEmail(email);
  assertPassword(input.password);
  if (!name) throw new AuthError("Tell us your name");
  if (input.role !== "OWNER" && input.role !== "TENANT") {
    throw new AuthError("Pick whether you are listing a property or looking for one");
  }

  const [existing] = await handle.db.select().from(users).where(eq(users.email, email));
  if (existing) throw new AuthError("An account with that email already exists", 409);

  const salt = randomBytes(16).toString("hex");
  const passwordHash = await hashPassword(input.password, salt);

  const privateKey = generatePrivateKey();
  const walletAddress = privateKeyToAccount(privateKey).address;

  const user: SessionUser = {
    id: `usr-${randomBytes(6).toString("hex")}`,
    email,
    name,
    role: input.role,
    walletAddress,
    custodialPrivateKey: privateKey,
    avatarUrl: null,
    supabaseId: null,
  };

  user.custodialPrivateKey = await protectWalletKey(privateKey, user.id);

  await handle.db.insert(users).values({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    passwordHash,
    passwordSalt: salt,
    walletAddress: user.walletAddress,
    custodialPrivateKey: user.custodialPrivateKey,
    createdAt: new Date(),
  });

  const token = await createSession(handle, user.id);
  return { user, token };
}

// ---------------------------------------------------------------- Google

export interface SupabaseIdentity {
  supabaseId: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

/**
 * Verifies a Supabase access token by asking Supabase who it belongs to.
 *
 * Deliberately not decoding the JWT locally: that would mean handling the
 * signing key, the algorithm and expiry myself, and getting any of those subtly
 * wrong turns "signed in" into "sent a plausible string". Supabase already
 * answers the question authoritatively.
 */
export async function verifySupabaseToken(accessToken: string): Promise<SupabaseIdentity> {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new AuthError("Google sign-in is not configured on this server", 400);
  }

  const res = await fetch(`${url.replace(/\/$/, "")}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${accessToken}`, apikey: anonKey },
  });
  if (!res.ok) throw new AuthError("That Google sign-in could not be verified", 401);

  const body = (await res.json()) as {
    id?: string;
    email?: string;
    user_metadata?: { full_name?: string; name?: string; avatar_url?: string; picture?: string };
  };

  if (!body.id || !body.email) throw new AuthError("Google did not return an email address", 400);

  const meta = body.user_metadata ?? {};
  return {
    supabaseId: body.id,
    email: body.email.toLowerCase(),
    name: meta.full_name ?? meta.name ?? body.email.split("@")[0]!,
    avatarUrl: meta.avatar_url ?? meta.picture ?? null,
  };
}

/**
 * Signs in a Google identity, creating the account on first use.
 *
 * Google says who someone is but not which side of the market they are on, so a
 * brand-new identity has no role and cannot be given one by guessing. Rather
 * than defaulting to something and hoping, this reports `needsRole` and the UI
 * asks once.
 */
export async function loginWithGoogle(
  handle: DbHandle,
  identity: SupabaseIdentity,
  requestedRole?: "OWNER" | "TENANT"
): Promise<{ user: SessionUser; token: string; created: boolean } | { needsRole: true }> {
  const [bySupabase] = await handle.db
    .select()
    .from(users)
    .where(eq(users.supabaseId, identity.supabaseId));

  if (bySupabase) {
    return { user: toSessionUser(bySupabase), token: await createSession(handle, bySupabase.id), created: false };
  }

  // Same person, previously registered with a password. Link rather than
  // creating a second account that owns a different wallet.
  const [byEmail] = await handle.db.select().from(users).where(eq(users.email, identity.email));
  if (byEmail) {
    await handle.db
      .update(users)
      .set({ supabaseId: identity.supabaseId, avatarUrl: identity.avatarUrl ?? byEmail.avatarUrl })
      .where(eq(users.id, byEmail.id));
    const linked = { ...byEmail, supabaseId: identity.supabaseId, avatarUrl: identity.avatarUrl };
    return { user: toSessionUser(linked), token: await createSession(handle, byEmail.id), created: false };
  }

  if (requestedRole !== "OWNER" && requestedRole !== "TENANT") {
    return { needsRole: true };
  }

  const privateKey = generatePrivateKey();
  const user: SessionUser = {
    id: `usr-${randomBytes(6).toString("hex")}`,
    email: identity.email,
    name: identity.name,
    role: requestedRole,
    walletAddress: privateKeyToAccount(privateKey).address,
    custodialPrivateKey: privateKey,
    avatarUrl: identity.avatarUrl,
    supabaseId: identity.supabaseId,
  };

  user.custodialPrivateKey = await protectWalletKey(privateKey, user.id);

  await handle.db.insert(users).values({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    passwordHash: null,
    passwordSalt: null,
    supabaseId: user.supabaseId,
    avatarUrl: user.avatarUrl,
    walletAddress: user.walletAddress,
    custodialPrivateKey: user.custodialPrivateKey,
    createdAt: new Date(),
  });

  return { user, token: await createSession(handle, user.id), created: true };
}

export function googleConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
}

export async function login(
  handle: DbHandle,
  email: string,
  password: string
): Promise<{ user: SessionUser; token: string }> {
  const [row] = await handle.db
    .select()
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()));

  // Same message either way, so this cannot be used to discover which emails
  // have accounts.
  const wrong = new AuthError("Email or password is incorrect", 401);
  if (!row) throw wrong;

  // A Google account has no password. Saying so is safe — they already know the
  // address exists because they signed in with it — and the alternative is a
  // baffling "incorrect password" for a password they never set.
  if (!row.passwordHash || !row.passwordSalt) {
    throw new AuthError("That account signs in with Google. Use the Google button.", 401);
  }
  if (!(await verifyPassword(password, row.passwordSalt, row.passwordHash))) throw wrong;

  const user = toSessionUser(row);
  const token = await createSession(handle, user.id);
  return { user, token };
}

function toSessionUser(row: typeof users.$inferSelect): SessionUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    walletAddress: row.walletAddress as Address,
    custodialPrivateKey: row.custodialPrivateKey,
    avatarUrl: row.avatarUrl,
    supabaseId: row.supabaseId,
  };
}

async function createSession(handle: DbHandle, userId: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  await handle.db.insert(sessions).values({
    token,
    userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000),
  });
  return token;
}

export async function logout(handle: DbHandle, token: string): Promise<void> {
  await handle.db.delete(sessions).where(eq(sessions.token, token));
}

/** Resolves the session cookie to a user, or null. Expired tokens do not count. */
export async function userFromRequest(
  handle: DbHandle,
  c: Context
): Promise<SessionUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;

  const [session] = await handle.db
    .select()
    .from(sessions)
    .where(and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())));
  if (!session) return null;

  const [row] = await handle.db.select().from(users).where(eq(users.id, session.userId));
  return row ? toSessionUser(row) : null;
}

export async function requireUser(handle: DbHandle, c: Context): Promise<SessionUser> {
  const user = await userFromRequest(handle, c);
  if (!user) throw new AuthError("Sign in to do that", 401);
  return user;
}

export async function requireRole(
  handle: DbHandle,
  c: Context,
  role: "OWNER" | "TENANT"
): Promise<SessionUser> {
  const user = await requireUser(handle, c);
  if (user.role !== role) {
    throw new AuthError(
      role === "OWNER"
        ? "Only a property owner can do that"
        : "Only a tenant can do that",
      403
    );
  }
  return user;
}

export function setSessionCookie(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
