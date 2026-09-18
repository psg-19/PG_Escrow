import { Hono } from "hono";
import { cors } from "hono/cors";
import { eq, desc, inArray } from "drizzle-orm";
import {
  agreements,
  users,
  claims as claimsTable,
  disputes,
  inventoryItems,
  ledgerEntries,
  listings,
  photos,
  rebuttals as rebuttalsTable,
  rentalRequests,
  rooms,
  verdicts,
  toTenancyFacts,
  type DbHandle,
} from "@pg/db";
import {
  AuthError,
  signup,
  login,
  logout,
  userFromRequest,
  requireUser,
  publicUser,
  setSessionCookie,
  clearSessionCookie,
  googleConfigured,
  verifySupabaseToken,
  loginWithGoogle,
  SESSION_COOKIE,
} from "./auth.js";
import { getCookie } from "hono/cookie";
import {
  loadDeployment,
  isChainUp,
  tokenBalance,
  fundWallet,
  CHAIN,
  IS_LOCAL_CHAIN,
} from "./chain.js";
import { walletProtection, isProtectedKey } from "./kms.js";
import { storageBackend } from "./storage.js";
import { KeyProtectionError } from "./kms.js";
import { readStored, mediaTypeOf } from "./storage.js";
import { buildTopupQuote, TOPUP_PRESETS_RUPEES } from "./topup.js";
import { nextRentCycle, RENT_CYCLE_DAYS } from "./writes.js";
import { mountWrites } from "./writes.js";
import {
  depreciatedCeiling,
  formatPaise,
  DEPRECIATION_SCHEDULE_VERSION,
  SEVERITY_CAP,
  USEFUL_LIFE_MONTHS,
  CONDITION_MULTIPLIER,
} from "@pg/core";
import { RUBRIC, RUBRIC_VERSION, createJudgeClient, resolveProvider } from "@pg/judge";

/**
 * Read-mostly API over the escrow record.
 *
 * Hono's own RPC types give the web app end-to-end inference without a codegen
 * step, so there is no tRPC layer here — one less moving part for the same
 * type safety.
 *
 * Money crosses this boundary as decimal strings, never numbers. A JSON number
 * is a float, and the one rule this codebase does not bend is that floats do
 * not touch money.
 */
/**
 * Which models would decide a dispute right now. Constructing the client can
 * throw on a missing key, so this degrades to a label rather than a 500 — the
 * rules page should render whether or not a key is configured.
 */
function describeModels(): { adjudication: string; screening: string } {
  try {
    return createJudgeClient().models;
  } catch {
    return { adjudication: "unavailable", screening: "unavailable" };
  }
}

export function createApp(handle: DbHandle) {
  const { db } = handle;

  const app = new Hono()
    .use(
      "*",
      cors({
        origin: (process.env.WEB_ORIGIN ?? "http://localhost:3000,http://127.0.0.1:3000").split(
          ","
        ),
        credentials: true,
      })
    )

    .get("/api/health", (c) => c.json({ ok: true }))

    /**
     * The published rubric and depreciation schedule.
     *
     * Served openly and on purpose. An owner who can see that a 6-year-old
     * mattress yields a zero ceiling mostly does not file the claim, so
     * publishing the rules suppresses bad claims at source rather than
     * adjudicating them after the fact.
     */
    .get("/api/rubric", (c) =>
      c.json({
        rubricVersion: RUBRIC_VERSION,
        rubric: RUBRIC,
        depreciationScheduleVersion: DEPRECIATION_SCHEDULE_VERSION,
        usefulLifeMonths: USEFUL_LIFE_MONTHS,
        severityCap: SEVERITY_CAP,
        conditionMultiplier: CONDITION_MULTIPLIER,
        provider: resolveProvider(),
        models: describeModels(),
      })
    )

    .get("/api/agreements", async (c) => {
      const all = await db.select().from(agreements);
      const user = await userFromRequest(handle, c);

      // Scoped to whoever is signed in, so a tenant's dashboard shows their
      // tenancies rather than everyone's.
      const rows = user
        ? all.filter((a) => {
            const me = user.walletAddress.toLowerCase();
            return (
              a.tenantAddress.toLowerCase() === me || a.ownerAddress.toLowerCase() === me
            );
          })
        : [];

      return c.json(
        rows.map((a) => ({
          id: a.id,
          tenantAddress: a.tenantAddress,
          ownerAddress: a.ownerAddress,
          propertyLabel: a.propertyLabel,
          tenantName: a.tenantName,
          ownerName: a.ownerName,
          state: a.state,
          rentPaise: a.rentPaise,
          depositPaise: a.depositPaise,
          rentDisplay: formatPaise(BigInt(a.rentPaise)),
          depositDisplay: formatPaise(BigInt(a.depositPaise)),
        }))
      );
    })

    .get("/api/agreements/:id", async (c) => {
      const id = c.req.param("id");
      const [agreement] = await db.select().from(agreements).where(eq(agreements.id, id));
      if (!agreement) return c.json({ error: "not found" }, 404);

      const [items, ledger, photoRows, claimRows, disputeRows] = await Promise.all([
        db.select().from(inventoryItems).where(eq(inventoryItems.agreementId, id)),
        db.select().from(ledgerEntries).where(eq(ledgerEntries.agreementId, id)),
        db.select().from(photos).where(eq(photos.agreementId, id)),
        db.select().from(claimsTable).where(eq(claimsTable.agreementId, id)),
        db.select().from(disputes).where(eq(disputes.agreementId, id)),
      ]);

      const rebuttalRows = claimRows.length
        ? await db
            .select()
            .from(rebuttalsTable)
            .where(inArray(rebuttalsTable.claimId, claimRows.map((r) => r.id)))
        : [];

      const facts = toTenancyFacts({ agreement, items, ledger });

      // The ceiling is computed here rather than stored, so it always reflects
      // the current schedule and the tenancy's real length.
      const itemsWithCeiling = facts.items.map((item) => {
        const ceiling = depreciatedCeiling({
          category: item.category,
          ageMonthsAtMoveIn: item.ageMonths,
          occupiedMonths: facts.occupiedMonths,
          replacementCostPaise: item.replacementCostPaise,
          conditionAtMoveIn: item.conditionAtMoveIn,
        });
        return {
          id: item.id,
          label: item.label,
          category: item.category,
          ageMonths: item.ageMonths,
          conditionAtMoveIn: item.conditionAtMoveIn,
          replacementCostPaise: item.replacementCostPaise.toString(),
          replacementCostDisplay: formatPaise(item.replacementCostPaise),
          ceilingPaise: ceiling.toString(),
          ceilingDisplay: formatPaise(ceiling),
          atEndOfLife: ceiling === 0n,
          photoSlots: item.photoSlots,
        };
      });

      return c.json({
        id: agreement.id,
        chainId: agreement.chainId,
        propertyLabel: agreement.propertyLabel,
        tenantName: agreement.tenantName,
        ownerName: agreement.ownerName,
        tenantAddress: agreement.tenantAddress,
        ownerAddress: agreement.ownerAddress,
        state: agreement.state,
        rentPaise: agreement.rentPaise,
        depositPaise: agreement.depositPaise,
        rentDisplay: formatPaise(BigInt(agreement.rentPaise)),
        depositDisplay: formatPaise(BigInt(agreement.depositPaise)),
        noticeDays: agreement.noticeDays,
        moveInRoot: agreement.moveInRoot,
        moveOutRoot: agreement.moveOutRoot,
        startAt: agreement.startAt,
        noticeGivenAt: agreement.noticeGivenAt,
        moveOutAt: agreement.moveOutAt,
        occupiedMonths: facts.occupiedMonths,
        items: itemsWithCeiling,
        ledger: ledger
          .slice()
          .sort((x, y) => x.cycleIndex - y.cycleIndex)
          .map((l) => ({
            cycleIndex: l.cycleIndex,
            dueAt: l.dueAt,
            paidAt: l.paidAt,
            releasedAt: l.releasedAt,
            amountDisplay: formatPaise(BigInt(l.amountPaise)),
            // What this payment bought, which is the thing a tenant actually
            // wants to know: am I covered, and until when?
            coversUntil: l.paidAt
              ? new Date(l.paidAt.getTime() + RENT_CYCLE_DAYS * 24 * 60 * 60 * 1000)
              : null,
          })),
        rentCycle: (() => {
          const c = nextRentCycle(ledger, agreement.rentPaise);
          return {
            index: c.index,
            payable: c.payable,
            reason: c.reason,
            daysUntilDue: c.daysUntilDue,
            dueAt: c.dueAt,
            coversUntil: c.coversUntil,
            cycleDays: RENT_CYCLE_DAYS,
          };
        })(),
        photos: photoRows.map((p) => ({
          id: p.id,
          itemId: p.itemId,
          slot: p.slot,
          stage: p.stage,
          sha256: p.sha256,
          capturedAt: p.capturedAt,
          capturedBy: p.capturedBy,
        })),
        claims: claimRows.map((r) => ({
          id: r.id,
          itemId: r.itemId,
          // Still sealed if the reveal window has not opened.
          claimText: r.revealedAt ? r.claimText : null,
          sealed: !r.revealedAt,
          commitment: r.commitment,
          hasRebuttal: rebuttalRows.some((b) => b.claimId === r.id),
          rebuttalText:
            r.revealedAt
              ? rebuttalRows.find((b) => b.claimId === r.id)?.rebuttalText ?? null
              : null,
        })),
        dispute: disputeRows[0]
          ? {
              id: disputeRows[0].id,
              chainDisputeId: disputeRows[0].chainDisputeId,
              resolvedAt: disputeRows[0].resolvedAt,
            }
          : null,
      });
    })

    .get("/api/agreements/:id/claims", async (c) => {
      const rows = await db
        .select()
        .from(claimsTable)
        .where(eq(claimsTable.agreementId, c.req.param("id")));
      return c.json(
        rows.map((r) => ({
          id: r.id,
          itemId: r.itemId,
          // Sealed until the reveal window opens — the commitment proves it
          // existed without letting the other side read and tailor a response.
          claimText: r.revealedAt ? r.claimText : null,
          sealed: !r.revealedAt,
          commitment: r.commitment,
          committedAt: r.committedAt,
        }))
      );
    })

    .get("/api/disputes", async (c) => {
      const rows = await db.select().from(disputes);
      return c.json(
        rows.map((d) => ({
          id: d.id,
          agreementId: d.agreementId,
          chainDisputeId: d.chainDisputeId,
          kind: d.kind,
          poolDisplay: formatPaise(BigInt(d.poolPaise)),
          evidenceRoot: d.evidenceRoot,
          openedAt: d.openedAt,
          resolvedAt: d.resolvedAt,
        }))
      );
    })

    /** The public audit list. Every verdict this system has ever issued. */
    .get("/api/verdicts", async (c) => {
      const rows = await db.select().from(verdicts);
      return c.json(
        rows.map((v) => ({
          id: v.id,
          disputeId: v.disputeId,
          toOwnerDisplay: formatPaise(BigInt(v.toOwnerPaise)),
          toTenantDisplay: formatPaise(BigInt(v.toTenantPaise)),
          adjudicationModel: v.adjudicationModel,
          rubricVersion: v.rubricVersion,
          rationaleHash: v.rationaleHash,
          txHash: v.txHash,
          decidedAt: v.decidedAt,
        }))
      );
    })

    /**
     * The full record behind one verdict: every panelist's raw output, both
     * screens, the model and rubric versions, the evidence root and the
     * transaction. Nothing is withheld — an autonomous decision that cannot be
     * inspected afterwards is not one anyone should be asked to accept.
     */
    .get("/api/verdicts/:id", async (c) => {
      const [v] = await db.select().from(verdicts).where(eq(verdicts.id, c.req.param("id")));
      if (!v) return c.json({ error: "not found" }, 404);

      const [dispute] = await db.select().from(disputes).where(eq(disputes.id, v.disputeId));

      return c.json({
        id: v.id,
        disputeId: v.disputeId,
        agreementId: dispute?.agreementId ?? null,
        toOwnerPaise: v.toOwnerPaise,
        toTenantPaise: v.toTenantPaise,
        toOwnerDisplay: formatPaise(BigInt(v.toOwnerPaise)),
        toTenantDisplay: formatPaise(BigInt(v.toTenantPaise)),
        poolDisplay: dispute ? formatPaise(BigInt(dispute.poolPaise)) : null,
        rationale: v.rationale,
        rationaleHash: v.rationaleHash,
        evidenceRoot: v.evidenceRoot,
        audit: JSON.parse(v.auditJson),
        adjudicationModel: v.adjudicationModel,
        rubricVersion: v.rubricVersion,
        depreciationScheduleVersion: v.depreciationScheduleVersion,
        signature: v.signature,
        nonce: v.nonce,
        txHash: v.txHash,
        decidedAt: v.decidedAt,
      });
    })

    // ------------------------------------------------------------------- auth

    /**
     * Creates the account and its wallet, then tops the wallet up with demo
     * currency so a new tenant can actually fund a deposit. Signing up logs you
     * straight in — an extra login step here buys nothing.
     */
    .post("/api/auth/signup", async (c) => {
      const body = await c.req.json();
      const { user, token } = await signup(handle, {
        email: String(body.email ?? ""),
        password: String(body.password ?? ""),
        name: String(body.name ?? ""),
        role: body.role === "OWNER" ? "OWNER" : "TENANT",
      });

      // Needs gas and demo currency before it can do anything. Reported rather
      // than swallowed: an account that cannot transact looks fine right up
      // until the first action fails for reasons the user cannot interpret.
      const deployment = await loadDeployment(handle);
      let funded = false;
      let fundingError: string | null = null;
      if (deployment) {
        try {
          await fundWallet(deployment.tokenAddress, user.walletAddress);
          funded = true;
        } catch (err) {
          fundingError = (err as Error).message;
        }
      } else {
        fundingError = "No contracts deployed yet, so the wallet has no balance.";
      }

      setSessionCookie(c, token);
      return c.json({ user: publicUser(user), funded, fundingError }, 201);
    })

    .post("/api/auth/login", async (c) => {
      const body = await c.req.json();
      const { user, token } = await login(
        handle,
        String(body.email ?? ""),
        String(body.password ?? "")
      );
      setSessionCookie(c, token);
      return c.json({ user: publicUser(user) });
    })

    /**
     * Exchanges a Supabase access token for one of our sessions.
     *
     * The app keeps its own session rather than carrying Supabase's around:
     * every route already authorises off `pg_session`, and one session model
     * means one place where "who is this" is decided.
     */
    .post("/api/auth/google", async (c) => {
      const body = await c.req.json();
      const identity = await verifySupabaseToken(String(body.accessToken ?? ""));

      const role = body.role === "OWNER" || body.role === "TENANT" ? body.role : undefined;
      const result = await loginWithGoogle(handle, identity, role);

      // First time through and nobody has said which side they are on.
      if ("needsRole" in result) {
        return c.json({ needsRole: true, email: identity.email, name: identity.name });
      }

      if (result.created) {
        const deployment = await loadDeployment(handle);
        if (deployment) {
          await fundWallet(deployment.tokenAddress, result.user.walletAddress).catch(() => {});
        }
      }

      setSessionCookie(c, result.token);
      return c.json({ user: publicUser(result.user), created: result.created });
    })

    /** Lets the sign-in page know whether to render the Google button at all. */
    .get("/api/auth/providers", (c) =>
      c.json({
        google: googleConfigured(),
        supabaseUrl: process.env.SUPABASE_URL ?? null,
        supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? null,
      })
    )

    .post("/api/auth/logout", async (c) => {
      const token = getCookie(c, SESSION_COOKIE);
      if (token) await logout(handle, token);
      clearSessionCookie(c);
      return c.json({ ok: true });
    })

    /** Who is signed in, plus their escrow-currency balance. */
    .get("/api/auth/me", async (c) => {
      const user = await userFromRequest(handle, c);
      if (!user) return c.json({ user: null });

      const deployment = await loadDeployment(handle);
      const balanceDisplay = deployment
        ? formatPaise(await tokenBalance(deployment.tokenAddress, user.walletAddress))
        : null;

      return c.json({ user: { ...publicUser(user), balanceDisplay } });
    })

    // --------------------------------------------------------------- top-up

    /**
     * A UPI payment request for topping up the wallet.
     *
     * Mock — see topup.ts. The response carries `isMock` and a plain-language
     * notice so the client cannot render this as a working payment by accident.
     */
    .get("/api/topup/quote", async (c) => {
      await requireUser(handle, c);
      const amount = Number(c.req.query("amount") ?? 15_000);
      const quote = await buildTopupQuote(Number.isFinite(amount) ? amount : 15_000);
      return c.json({ ...quote, presets: TOPUP_PRESETS_RUPEES });
    })

    /**
     * What this instance is actually wired to.
     *
     * Every one of these has a local fallback that works fine in development
     * and is wrong in production, and the difference is invisible from the app
     * itself — plaintext keys behave exactly like encrypted ones until someone
     * copies the database. Surfacing it means "is KMS on?" is a question the
     * running system answers, not one you answer from memory.
     */
    .get("/api/system", async (c) => {
      const deployment = await loadDeployment(handle);
      const chainUp = await isChainUp();

      let keyProtection: string;
      let keyProtectionError: string | null = null;
      try {
        keyProtection = walletProtection();
      } catch (err) {
        keyProtection = "misconfigured";
        keyProtectionError = (err as Error).message;
      }

      // Counted from the data rather than the config: a key is only protected
      // if the stored value actually is ciphertext.
      const allUsers = await db.select().from(users);
      const protectedCount = allUsers.filter((u) => isProtectedKey(u.custodialPrivateKey)).length;

      const dbUrl = process.env.DATABASE_URL ?? "";
      const storage = storageBackend();

      return c.json({
        wallets: {
          mode: keyProtection,
          error: keyProtectionError,
          total: allUsers.length,
          encrypted: protectedCount,
          plaintext: allUsers.length - protectedCount,
          kmsKeyConfigured: Boolean(process.env.AWS_KMS_KEY_ID),
          region: process.env.AWS_REGION ?? null,
          healthy: keyProtection === "kms" && protectedCount === allUsers.length,
        },
        storage: {
          backend: storage,
          bucket:
            storage === "s3"
              ? process.env.AWS_S3_BUCKET ?? null
              : process.env.SUPABASE_STORAGE_BUCKET ?? null,
          durable: storage !== "disk",
        },
        database: {
          kind: dbUrl.startsWith("libsql") ? "turso" : "local file",
          durable: dbUrl.startsWith("libsql"),
        },
        chain: {
          up: chainUp,
          name: CHAIN.name,
          id: CHAIN.id,
          deployed: Boolean(deployment),
          escrowAddress: deployment?.escrowAddress ?? null,
          isLocal: IS_LOCAL_CHAIN,
        },
        adjudicator: {
          provider: resolveProvider(),
          models: describeModels(),
          live: resolveProvider() !== "scripted",
        },
        google: { enabled: googleConfigured() },
      });
    })

    /** Whether the chain is up and which contracts we are pointed at. */
    .get("/api/chain", async (c) => {
      const up = await isChainUp();
      const deployment = up ? await loadDeployment(handle) : null;
      return c.json({
        chainUp: up,
        deployed: Boolean(deployment),
        escrowAddress: deployment?.escrowAddress ?? null,
        tokenAddress: deployment?.tokenAddress ?? null,
        oracleAddress: deployment?.oracleAddress ?? null,
      });
    })

    // ------------------------------------------------------------------ listings

    .get("/api/listings", async (c) => {
      const all = await db.select().from(listings).orderBy(desc(listings.createdAt));
      const allRooms = await db.select().from(rooms);
      const user = await userFromRequest(handle, c);

      return c.json(
        all.map((l) => {
          const mine = allRooms.filter((r) => r.listingId === l.id);
          const vacant = mine.filter((r) => r.status === "VACANT");
          const cheapest = vacant
            .map((r) => BigInt(r.rentPaise))
            .reduce<bigint | null>((min, v) => (min === null || v < min ? v : min), null);

          return {
            id: l.id,
            title: l.title,
            locality: l.locality,
            city: l.city,
            ownerName: l.ownerName,
            isMine:
              user?.walletAddress.toLowerCase() === l.ownerAddress.toLowerCase(),
            genderPolicy: l.genderPolicy,
            amenities: JSON.parse(l.amenities) as string[],
            roomCount: mine.length,
            vacantCount: vacant.length,
            fromDisplay: cheapest === null ? null : formatPaise(cheapest),
          };
        })
      );
    })

    .get("/api/listings/:id", async (c) => {
      const [l] = await db.select().from(listings).where(eq(listings.id, c.req.param("id")));
      if (!l) return c.json({ error: "not found" }, 404);

      const mine = await db.select().from(rooms).where(eq(rooms.listingId, l.id));
      const requests = mine.length
        ? await db
            .select()
            .from(rentalRequests)
            .where(inArray(rentalRequests.roomId, mine.map((r) => r.id)))
        : [];

      return c.json({
        id: l.id,
        title: l.title,
        locality: l.locality,
        city: l.city,
        description: l.description,
        ownerName: l.ownerName,
        ownerAddress: l.ownerAddress,
        genderPolicy: l.genderPolicy,
        noticeDays: l.noticeDays,
        amenities: JSON.parse(l.amenities) as string[],
        rooms: mine.map((r) => ({
          id: r.id,
          label: r.label,
          occupancy: r.occupancy,
          status: r.status,
          rentDisplay: formatPaise(BigInt(r.rentPaise)),
          depositDisplay: formatPaise(BigInt(r.depositPaise)),
          inventoryCount: (JSON.parse(r.inventoryTemplate) as unknown[]).length,
          pendingRequests: requests.filter(
            (q) => q.roomId === r.id && q.status === "PENDING"
          ).length,
        })),
      });
    })

    // ------------------------------------------------------------------ requests

    /** Requests visible to one persona: their own if a tenant, inbound if an owner. */
    .get("/api/requests", async (c) => {
      const user = await userFromRequest(handle, c);
      if (!user) return c.json([]);

      const all = await db.select().from(rentalRequests).orderBy(desc(rentalRequests.createdAt));
      const allRooms = await db.select().from(rooms);
      const allListings = await db.select().from(listings);

      const me = user.walletAddress.toLowerCase();
      const visible = all.filter((q) => {
        if (user.role === "TENANT") return q.tenantAddress.toLowerCase() === me;
        const room = allRooms.find((r) => r.id === q.roomId);
        const listing = allListings.find((l) => l.id === room?.listingId);
        return listing?.ownerAddress.toLowerCase() === me;
      });

      return c.json(
        visible.map((q) => {
          const room = allRooms.find((r) => r.id === q.roomId);
          const listing = allListings.find((l) => l.id === room?.listingId);
          return {
            id: q.id,
            roomId: q.roomId,
            roomLabel: room?.label ?? "—",
            listingTitle: listing?.title ?? "—",
            listingId: listing?.id ?? null,
            tenantName: q.tenantName,
            message: q.message,
            status: q.status,
            agreementId: q.agreementId,
            rentDisplay: room ? formatPaise(BigInt(room.rentPaise)) : "—",
            depositDisplay: room ? formatPaise(BigInt(room.depositPaise)) : "—",
            createdAt: q.createdAt,
          };
        })
      );
    })

    // -------------------------------------------------------------------- photos

    .get("/api/photos/:id/file", async (c) => {
      const user = await requireUser(handle, c);
      const [p] = await db.select().from(photos).where(eq(photos.id, c.req.param("id")));
      if (!p) return c.json({ error: "not found" }, 404);
      const [agreement] = await db.select().from(agreements).where(eq(agreements.id, p.agreementId));
      const address = user.walletAddress.toLowerCase();
      if (!agreement || ![agreement.tenantAddress.toLowerCase(), agreement.ownerAddress.toLowerCase()].includes(address)) {
        return c.json({ error: "You cannot view this photograph" }, 403);
      }
      const bytes = await readStored(p.storageKey);
      if (!bytes) return c.json({ error: "file missing" }, 404);
      // Copy into a plain ArrayBuffer-backed view: Node's Buffer may sit on a
      // SharedArrayBuffer, which the Response body type does not accept.
      const body = new Uint8Array(bytes);
      return c.body(body, 200, {
        "Content-Type": mediaTypeOf(p.storageKey),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
    });

  app.onError((err, c) => {
    if (err instanceof KeyProtectionError) return c.json({ error: err.message }, 503);
    if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
    return c.json({ error: err.message ?? "Something went wrong" }, 500);
  });

  mountWrites(app as unknown as Hono, handle);

  return app;
}

export type AppType = ReturnType<typeof createApp>;
