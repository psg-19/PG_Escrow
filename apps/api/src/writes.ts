import { Hono } from "hono";
import { randomUUID, createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { keccak256, toHex, type Address } from "viem";
import {
  agreements,
  claims as claimsTable,
  disputes,
  inventoryItems,
  ledgerEntries,
  listings,
  photos,
  rebuttals as rebuttalsTable,
  rentalRequests,
  rooms,
  toTenancyFacts,
  verdicts,
  type DbHandle,
} from "@pg/db";
import { rupees, formatPaise, type DeductionClaim, type Rebuttal } from "@pg/core";
import { merkleRoot, commit, checkFraming, type EvidencePhoto } from "@pg/evidence";
import { adjudicate, createJudgeClient, signVerdict, type PhotoRef } from "@pg/judge";
import {
  artifact,
  requireDeployment,
  sendAs,
  chainNowSeconds,
  advanceTime,
  tokenBalance,
  fundWallet,
  publicClient,
} from "./chain.js";
import { oracleKey, platformKey } from "./chains.js";
import {
  AuthError,
  requireUser,
  requireRole,
  type SessionUser,
} from "./auth.js";
import { storeDataUrl, readAsBase64, UnsupportedImageError } from "./storage.js";
import { unlockWalletKey, KeyProtectionError } from "./kms.js";
import { startJob, getJob } from "./jobs.js";

const escrowAbi = () => artifact("PGEscrow").abi;
const tokenAbi = () => artifact("MockINRC").abi;

class ActorError extends Error {}

/**
 * The signer for a user's custodial wallet.
 *
 * Every on-chain write goes through here, so there is exactly one place where
 * the server uses someone else's key — the thing a real deployment has to
 * remove, by having the user sign in their own browser instead.
 */
async function signer(user: SessionUser): Promise<{ privateKey: `0x${string}` }> {
  return { privateKey: await unlockWalletKey(user.custodialPrivateKey, user.id, user.walletAddress) };
}

function agreementChainId(id: string): `0x${string}` {
  return keccak256(toHex(id));
}

/**
 * The actual adjudication: screen, run the panel, bound, sign, execute.
 *
 * Extracted from the route so it can run detached in a background job — see
 * jobs.ts for why the HTTP request must not wait for it.
 */
async function runAdjudication(
  handle: DbHandle,
  deployment: Awaited<ReturnType<typeof requireDeployment>>,
  dispute: typeof disputes.$inferSelect,
  progress: (step: string) => void
): Promise<Record<string, unknown>> {
  const { db } = handle;
        const [a] = await db
          .select()
          .from(agreements)
          .where(eq(agreements.id, dispute.agreementId));
        if (!a) throw new Error("The agreement behind this dispute is missing");
        const [items, ledger, claimRows, photoRows] = await Promise.all([
          db.select().from(inventoryItems).where(eq(inventoryItems.agreementId, a.id)),
          db.select().from(ledgerEntries).where(eq(ledgerEntries.agreementId, a.id)),
          db.select().from(claimsTable).where(eq(claimsTable.agreementId, a.id)),
          db.select().from(photos).where(eq(photos.agreementId, a.id)),
        ]);
        progress("Reading the evidence");

  const rebuttalRows = claimRows.length
          ? await db
              .select()
              .from(rebuttalsTable)
              .where(inArray(rebuttalsTable.claimId, claimRows.map((r) => r.id)))
          : [];
        const now = new Date();
        await db
          .update(claimsTable)
          .set({ revealedAt: now })
          .where(eq(claimsTable.agreementId, a.id));
        const facts = toTenancyFacts({ agreement: a, items, ledger });
        const deductionClaims: DeductionClaim[] = claimRows.map((r) => ({
          id: r.id,
          itemId: r.itemId,
          claimText: r.claimText ?? "",
          moveInPhotoIds: photoRows
            .filter((p) => p.itemId === r.itemId && p.stage === "MOVE_IN")
            .map((p) => p.id),
          moveOutPhotoIds: photoRows
            .filter((p) => p.itemId === r.itemId && p.stage === "MOVE_OUT")
            .map((p) => p.id),
        }));
        const rebuttals: Rebuttal[] = rebuttalRows.map((r) => ({
          claimId: r.claimId,
          rebuttalText: r.rebuttalText ?? "",
        }));
        // Real photographs, fetched from storage and handed to the vision model.
        // Loaded once up front: the same photo often backs several claims, and
        // re-fetching it per claim would multiply object-store round trips.
        const mediaByKey = new Map<string, { data: string; mediaType: string }>();
        for (const p of photoRows) {
          if (mediaByKey.has(p.storageKey)) continue;
          const media = await readAsBase64(p.storageKey);
          if (media) mediaByKey.set(p.storageKey, media);
        }

        const photosByClaim: Record<string, { moveIn: PhotoRef[]; moveOut: PhotoRef[] }> = {};
        for (const claim of deductionClaims) {
          const forItem = photoRows.filter((p) => p.itemId === claim.itemId);
          const toRef = (stage: "MOVE_IN" | "MOVE_OUT"): PhotoRef[] =>
            forItem
              .filter((p) => p.stage === stage)
              .flatMap((p) => {
                const media = mediaByKey.get(p.storageKey);
                if (!media) return [];
                return [
                  {
                    id: p.id,
                    slot: p.slot,
                    media: {
                      kind: "base64" as const,
                      mediaType: media.mediaType as "image/jpeg",
                      data: media.data,
                    },
                  },
                ];
              });
          photosByClaim[claim.id] = { moveIn: toRef("MOVE_IN"), moveOut: toRef("MOVE_OUT") };
        }
        // Gemini when a key is present, otherwise a scripted stub that names
        // itself in the audit record so a rehearsal is never mistaken for a
        // real verdict.
        progress(`Running the panel on ${deductionClaims.length} claim(s)`);
        const judge = createJudgeClient();
        const result = await adjudicate(judge, {
          disputeId: BigInt(dispute.chainDisputeId ?? "1"),
          facts,
          claims: deductionClaims,
          rebuttals,
          photosByClaim,
          evidenceRoot: dispute.evidenceRoot as `0x${string}`,
        });
        progress("Signing the verdict");
        const signed = await signVerdict({
          oraclePrivateKey: oracleKey(),
          chainId: deployment.chainId,
          escrowAddress: deployment.escrowAddress,
          disputeId: BigInt(dispute.chainDisputeId ?? "1"),
          toOwnerPaise: result.settlement.toOwnerPaise,
          toTenantPaise: result.settlement.toTenantPaise,
          rationaleHash: result.rationaleHash,
          evidenceRoot: dispute.evidenceRoot as `0x${string}`,
          nonce: BigInt(Date.now()),
          nowSeconds: await chainNowSeconds(),
        });
        progress("Executing on-chain");
        // The platform pays the gas; the signature is what carries authority.
        const receipt = await sendAs(
          { privateKey: platformKey() },
          deployment.escrowAddress,
          escrowAbi(),
          "submitVerdict",
          [
            {
              disputeId: signed.disputeId,
              toOwnerPaise: signed.toOwnerPaise,
              toTenantPaise: signed.toTenantPaise,
              rationaleHash: signed.rationaleHash,
              evidenceRoot: signed.evidenceRoot,
              nonce: signed.nonce,
              deadline: signed.deadline,
            },
            signed.signature,
          ]
        );
        const verdictId = `verdict-${dispute.chainDisputeId ?? "1"}`;
        await db.insert(verdicts).values({
          id: verdictId,
          disputeId: dispute.id,
          toOwnerPaise: result.settlement.toOwnerPaise.toString(),
          toTenantPaise: result.settlement.toTenantPaise.toString(),
          rationale: result.rationale,
          rationaleHash: result.rationaleHash,
          evidenceRoot: result.audit.evidenceRoot,
          auditJson: JSON.stringify(result.audit, (_k, v) =>
            typeof v === "bigint" ? v.toString() : v
          ),
          adjudicationModel: result.audit.adjudicationModel,
          rubricVersion: result.audit.rubricVersion,
          depreciationScheduleVersion: result.audit.depreciationScheduleVersion,
          signature: signed.signature,
          nonce: signed.nonce.toString(),
          txHash: receipt.transactionHash,
          decidedAt: now,
        });
        await db.update(disputes).set({ resolvedAt: now }).where(eq(disputes.id, dispute.id));
        await db.update(agreements).set({ state: "SETTLED" }).where(eq(agreements.id, a.id));
        if (a.roomId) {
          await db.update(rooms).set({ status: "VACANT" }).where(eq(rooms.id, a.roomId));
        }
        progress("Done");
        return {
          verdictId,
          toOwner: formatPaise(result.settlement.toOwnerPaise),
          toTenant: formatPaise(result.settlement.toTenantPaise),
          tx: receipt.transactionHash,
        };
}

/** One rent cycle is a month. */
export const RENT_CYCLE_DAYS = 30;

/**
 * How early a cycle can be paid.
 *
 * Rent covering 30 days opens two days before the previous cycle runs out, so
 * nobody is forced to pay on the exact hour — but not a fortnight early, which
 * is just prepaying into an escrow they cannot get back.
 */
export const RENT_GRACE_DAYS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RentCycleState {
  index: number;
  dueAt: Date;
  coversUntil: Date;
  payable: boolean;
  reason: string;
  daysUntilDue: number;
}

/**
 * Works out whether the next rent cycle can be paid yet.
 *
 * Derived from the ledger rather than stored, so it cannot drift out of step
 * with the payments it describes.
 */
export function nextRentCycle(
  ledger: { cycleIndex: number; paidAt: Date | null; dueAt: Date }[],
  rentPaise: string,
  now: Date = new Date()
): RentCycleState {
  const paid = ledger
    .filter((l) => l.paidAt)
    .sort((x, y) => x.cycleIndex - y.cycleIndex);

  const last = paid[paid.length - 1];

  // Nothing paid yet: the first cycle is due now.
  if (!last || !last.paidAt) {
    return {
      index: 1,
      dueAt: now,
      coversUntil: new Date(now.getTime() + RENT_CYCLE_DAYS * DAY_MS),
      payable: true,
      reason: "",
      daysUntilDue: 0,
    };
  }

  const coveredUntil = new Date(last.paidAt.getTime() + RENT_CYCLE_DAYS * DAY_MS);
  const opensAt = new Date(coveredUntil.getTime() - RENT_GRACE_DAYS * DAY_MS);
  const payable = now >= opensAt;
  const daysUntilDue = Math.max(0, Math.ceil((opensAt.getTime() - now.getTime()) / DAY_MS));

  return {
    index: last.cycleIndex + 1,
    dueAt: coveredUntil,
    coversUntil: new Date(coveredUntil.getTime() + RENT_CYCLE_DAYS * DAY_MS),
    payable,
    reason: payable
      ? ""
      : `Rent is paid up to ${coveredUntil.toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
        })}. The next cycle opens in ${daysUntilDue} day${daysUntilDue === 1 ? "" : "s"}.`,
    daysUntilDue,
  };
}

export function mountWrites(app: Hono, handle: DbHandle) {
  const { db } = handle;

  return (
    app

      // ------------------------------------------------------------- listings

      .post("/api/listings", async (c) => {
        const owner = await requireRole(handle, c, "OWNER");
        const body = await c.req.json();

        const listingId = `lst-${randomUUID().slice(0, 8)}`;
        await db.insert(listings).values({
          id: listingId,
          ownerAddress: owner.walletAddress,
          ownerName: owner.name,
          title: String(body.title),
          locality: String(body.locality),
          city: String(body.city),
          description: String(body.description ?? ""),
          amenities: JSON.stringify(body.amenities ?? []),
          genderPolicy: body.genderPolicy ?? "ANY",
          noticeDays: Number(body.noticeDays ?? 30),
          lateFeeRateBps: Number(body.lateFeeRateBps ?? 200),
          createdAt: new Date(),
        });

        const incoming = Array.isArray(body.rooms) ? body.rooms : [];
        if (incoming.length === 0) throw new ActorError("A listing needs at least one room");

        await db.insert(rooms).values(
          incoming.map((r: Record<string, unknown>) => ({
            id: `rm-${randomUUID().slice(0, 8)}`,
            listingId,
            label: String(r.label),
            occupancy: (r.occupancy as "SINGLE") ?? "SINGLE",
            rentPaise: rupees(Number(r.rentRupees)).toString(),
            depositPaise: rupees(Number(r.depositRupees)).toString(),
            status: "VACANT" as const,
            // The inventory the adjudicator will later reason about. Captured
            // here once so the owner isn't re-entering it for every tenancy.
            inventoryTemplate: JSON.stringify(r.inventory ?? []),
          }))
        );

        return c.json({ id: listingId }, 201);
      })

      // ------------------------------------------------------- rental request

      .post("/api/rooms/:roomId/requests", async (c) => {
        const tenant = await requireRole(handle, c, "TENANT");
        const body = await c.req.json();

        const roomId = c.req.param("roomId");
        const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId));
        if (!room) return c.json({ error: "room not found" }, 404);
        if (room.status !== "VACANT") return c.json({ error: "room is not vacant" }, 409);

        const id = `req-${randomUUID().slice(0, 8)}`;
        await db.insert(rentalRequests).values({
          id,
          roomId,
          tenantAddress: tenant.walletAddress,
          tenantName: tenant.name,
          message: String(body.message ?? ""),
          status: "PENDING",
          createdAt: new Date(),
        });
        return c.json({ id }, 201);
      })

      /**
       * The owner accepts, and the tenancy becomes real: an agreement row, its
       * inventory copied from the room template, and the matching agreement
       * created on-chain. The room is reserved rather than occupied — it is not
       * occupied until the deposit is actually in escrow.
       */
      .post("/api/requests/:id/accept", async (c) => {
        const owner = await requireRole(handle, c, "OWNER");
        const deployment = await requireDeployment(handle);

        const [req] = await db
          .select()
          .from(rentalRequests)
          .where(eq(rentalRequests.id, c.req.param("id")));
        if (!req) return c.json({ error: "request not found" }, 404);
        if (req.status !== "PENDING") return c.json({ error: "already decided" }, 409);

        const [room] = await db.select().from(rooms).where(eq(rooms.id, req.roomId));
        if (!room) return c.json({ error: "room not found" }, 404);
        const [listing] = await db.select().from(listings).where(eq(listings.id, room.listingId));
        if (!listing) return c.json({ error: "listing not found" }, 404);

        if (listing.ownerAddress.toLowerCase() !== owner.walletAddress.toLowerCase()) {
          throw new ActorError("Only the owner of this listing can accept");
        }

        const agreementId = `ag-${randomUUID().slice(0, 8)}`;
        const chainId = agreementChainId(agreementId);

        await sendAs(await signer(owner), deployment.escrowAddress, escrowAbi(), "createAgreement", [
          chainId,
          req.tenantAddress as Address,
          listing.ownerAddress as Address,
          BigInt(room.rentPaise),
          BigInt(room.depositPaise),
          listing.noticeDays,
        ]);

        await db.insert(agreements).values({
          id: agreementId,
          chainId,
          roomId: room.id,
          tenantAddress: req.tenantAddress,
          ownerAddress: listing.ownerAddress,
          tenantName: req.tenantName,
          ownerName: listing.ownerName,
          propertyLabel: `${room.label}, ${listing.title}, ${listing.locality}`,
          rentPaise: room.rentPaise,
          depositPaise: room.depositPaise,
          noticeDays: listing.noticeDays,
          lateFeeRateBps: listing.lateFeeRateBps,
          state: "DRAFT",
          createdAt: new Date(),
        });

        const template = JSON.parse(room.inventoryTemplate) as Record<string, unknown>[];
        if (template.length > 0) {
          await db.insert(inventoryItems).values(
            template.map((t) => ({
              id: `itm-${randomUUID().slice(0, 8)}`,
              agreementId,
              category: String(t.category),
              label: String(t.label),
              ageMonths: Number(t.ageMonths ?? 0),
              replacementCostPaise: rupees(Number(t.replacementCostRupees ?? 0)).toString(),
              conditionAtMoveIn: String(t.conditionAtMoveIn ?? "GOOD"),
              photoSlots: JSON.stringify(t.photoSlots ?? ["wide"]),
            }))
          );
        }

        await db
          .update(rentalRequests)
          .set({ status: "ACCEPTED", agreementId, decidedAt: new Date() })
          .where(eq(rentalRequests.id, req.id));
        await db.update(rooms).set({ status: "RESERVED" }).where(eq(rooms.id, room.id));

        // Every other pending request on this room is now moot.
        await db
          .update(rentalRequests)
          .set({ status: "DECLINED", decidedAt: new Date() })
          .where(and(eq(rentalRequests.roomId, room.id), eq(rentalRequests.status, "PENDING")));

        return c.json({ agreementId }, 201);
      })

      .post("/api/requests/:id/decline", async (c) => {
        await requireUser(handle, c);
        await db
          .update(rentalRequests)
          .set({ status: "DECLINED", decidedAt: new Date() })
          .where(eq(rentalRequests.id, c.req.param("id")));
        return c.json({ ok: true });
      })

      // --------------------------------------------------------------- escrow

      .post("/api/agreements/:id/fund", async (c) => {
        const tenant = await requireRole(handle, c, "TENANT");
        const deployment = await requireDeployment(handle);

        const [a] = await db.select().from(agreements).where(eq(agreements.id, c.req.param("id")));
        if (!a) return c.json({ error: "not found" }, 404);
        if (a.tenantAddress.toLowerCase() !== tenant.walletAddress.toLowerCase()) {
          throw new ActorError("Only the tenant on this agreement can fund it");
        }

        const total = BigInt(a.depositPaise) + BigInt(a.rentPaise);
        await sendAs(await signer(tenant), deployment.tokenAddress, tokenAbi(), "approve", [
          deployment.escrowAddress,
          total,
        ]);
        await sendAs(await signer(tenant), deployment.escrowAddress, escrowAbi(), "fund", [a.chainId]);

        const now = new Date();
        await db
          .update(agreements)
          .set({ state: "FUNDED", startAt: now })
          .where(eq(agreements.id, a.id));

        // fund() creates the first rent payment on-chain.
        await db.insert(ledgerEntries).values({
          id: `led-${randomUUID().slice(0, 8)}`,
          agreementId: a.id,
          cycleIndex: 1,
          dueAt: now,
          amountPaise: a.rentPaise,
          paidAt: now,
        });
        if (a.roomId) {
          await db.update(rooms).set({ status: "OCCUPIED" }).where(eq(rooms.id, a.roomId));
        }

        return c.json({ ok: true, fundedPaise: total.toString() });
      })

      /**
       * Pays one rent cycle.
       *
       * Refuses if the current cycle is not yet due. Rent covers a fixed period,
       * so paying twice in a day is not generosity — it is the tenant losing
       * money to a UI that let them.
       */
      .post("/api/agreements/:id/pay-rent", async (c) => {
        const tenant = await requireRole(handle, c, "TENANT");
        const deployment = await requireDeployment(handle);

        const [a] = await db.select().from(agreements).where(eq(agreements.id, c.req.param("id")));
        if (!a) return c.json({ error: "not found" }, 404);

        const existing = await db
          .select()
          .from(ledgerEntries)
          .where(eq(ledgerEntries.agreementId, a.id));

        const cycle = nextRentCycle(existing, a.rentPaise);
        if (!cycle.payable) {
          return c.json({ error: cycle.reason }, 409);
        }

        await sendAs(await signer(tenant), deployment.tokenAddress, tokenAbi(), "approve", [
          deployment.escrowAddress,
          BigInt(a.rentPaise),
        ]);
        await sendAs(await signer(tenant), deployment.escrowAddress, escrowAbi(), "payRent", [a.chainId]);

        await db.insert(ledgerEntries).values({
          id: `led-${randomUUID().slice(0, 8)}`,
          agreementId: a.id,
          cycleIndex: cycle.index,
          dueAt: cycle.dueAt,
          amountPaise: a.rentPaise,
          paidAt: new Date(),
        });

        return c.json({ ok: true, cycleIndex: cycle.index, coversUntil: cycle.coversUntil });
      })

      /**
       * Pushes held rent to the owner once its 48-hour window has passed.
       *
       * Permissionless on-chain, so the UI can offer it to either party — but
       * somebody has to ask, or the rent sits in escrow forever.
       */
      .post("/api/agreements/:id/release-rent", async (c) => {
        const who = await requireUser(handle, c);
        const deployment = await requireDeployment(handle);
        const agreementId = c.req.param("id");

        const rows = await db
          .select()
          .from(ledgerEntries)
          .where(eq(ledgerEntries.agreementId, agreementId));

        const nextPaymentId = await publicClient.readContract({
          address: deployment.escrowAddress,
          abi: escrowAbi(),
          functionName: "nextRentPaymentId",
          args: [],
        });

        let released = 0;
        // Payment ids are global across agreements, so walk this agreement's
        // own rows and match them by position within the escrow's counter.
        for (let id = 1n; id < (nextPaymentId as bigint); id++) {
          const p = (await publicClient.readContract({
            address: deployment.escrowAddress,
            abi: escrowAbi(),
            functionName: "getRentPayment",
            args: [id],
          })) as { agreementId: string; released: boolean; disputeId: bigint };

          const [a] = await db.select().from(agreements).where(eq(agreements.id, agreementId));
          if (!a || p.agreementId.toLowerCase() !== a.chainId.toLowerCase()) continue;
          if (p.released || p.disputeId !== 0n) continue;

          try {
            await sendAs(await signer(who), deployment.escrowAddress, escrowAbi(), "releaseRent", [id]);
            released += 1;
            const row = rows[Number(id) - 1];
            if (row) {
              await db
                .update(ledgerEntries)
                .set({ releasedAt: new Date(), chainPaymentId: id.toString() })
                .where(eq(ledgerEntries.id, row.id));
            }
          } catch {
            // Still inside its 48h hold. Leave it; the next call will get it.
          }
        }

        return c.json({ released });
      })

      // ------------------------------------------------------------- evidence

      /**
       * Upload one photograph against an inventory slot.
       *
       * The bytes are hashed on arrival and that hash is what the Merkle root
       * commits to. A move-out shot is also checked against its move-in
       * counterpart's framing: without a comparable baseline the later
       * adjudication is guesswork, so a badly framed retake is rejected here
       * rather than quietly weakening the evidence.
       */
      .post("/api/agreements/:id/photos", async (c) => {
        const who = await requireUser(handle, c);
        const body = await c.req.json();
        const agreementId = c.req.param("id");

        const [a] = await db.select().from(agreements).where(eq(agreements.id, agreementId));
        if (!a) return c.json({ error: "not found" }, 404);

        const stage = body.stage === "MOVE_OUT" ? "MOVE_OUT" : "MOVE_IN";
        const stored = await storeDataUrl(String(body.dataUrl));
        const pose = body.pose ?? {
          alpha: 90,
          beta: 0,
          gamma: 0,
          frame: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
        };

        if (stage === "MOVE_OUT") {
          const baseline = await db
            .select()
            .from(photos)
            .where(
              and(
                eq(photos.agreementId, agreementId),
                eq(photos.itemId, String(body.itemId)),
                eq(photos.slot, String(body.slot)),
                eq(photos.stage, "MOVE_IN")
              )
            );
          if (baseline.length === 0) {
            return c.json({ error: "No move-in baseline exists for this slot." }, 409);
          }
          const before: EvidencePhoto = {
            id: baseline[0]!.id,
            itemId: baseline[0]!.itemId,
            slot: baseline[0]!.slot,
            stage: "MOVE_IN",
            sha256: baseline[0]!.sha256,
            capturedAt: baseline[0]!.capturedAt,
            capturedBy: baseline[0]!.capturedBy,
            pose: JSON.parse(baseline[0]!.pose),
            storageKey: baseline[0]!.storageKey,
          };
          const after: EvidencePhoto = { ...before, id: "candidate", stage: "MOVE_OUT", pose };
          const [check] = checkFraming([before], [after]);
          if (check && !check.acceptable) {
            return c.json({ error: check.reason, delta: check.delta }, 422);
          }
        }

        const id = `pho-${randomUUID().slice(0, 8)}`;
        await db.insert(photos).values({
          id,
          agreementId,
          itemId: String(body.itemId),
          slot: String(body.slot),
          stage,
          sha256: stored.sha256,
          storageKey: stored.storageKey,
          mediaType: stored.mediaType,
          // Server clock. Devices lie about time.
          capturedAt: new Date(),
          capturedBy: who.id,
          pose: JSON.stringify(pose),
        });

        return c.json({ id, sha256: stored.sha256 }, 201);
      })

      /**
       * Attest to the evidence set. The contract only anchors once both parties
       * submit the same root, so neither side sets the baseline alone.
       */
      .post("/api/agreements/:id/attest", async (c) => {
        const who = await requireUser(handle, c);
        const body = await c.req.json();
        const deployment = await requireDeployment(handle);
        const agreementId = c.req.param("id");
        const stage = body.stage === "MOVE_OUT" ? "MOVE_OUT" : "MOVE_IN";

        const [a] = await db.select().from(agreements).where(eq(agreements.id, agreementId));
        if (!a) return c.json({ error: "not found" }, 404);

        const rows = await db
          .select()
          .from(photos)
          .where(and(eq(photos.agreementId, agreementId), eq(photos.stage, stage)));
        if (rows.length === 0) {
          return c.json({ error: "Nothing to attest to — capture the evidence first." }, 409);
        }

        const root = merkleRoot(
          rows.map((p) => ({
            id: p.id,
            itemId: p.itemId,
            slot: p.slot,
            stage: p.stage,
            sha256: p.sha256,
            capturedAt: p.capturedAt,
            capturedBy: p.capturedBy,
            pose: JSON.parse(p.pose),
            storageKey: p.storageKey,
          }))
        );

        await sendAs(
          await signer(who),
          deployment.escrowAddress,
          escrowAbi(),
          stage === "MOVE_IN" ? "attestMoveIn" : "attestMoveOut",
          [a.chainId, root]
        );

        // Read the contract back rather than assuming: it only transitions when
        // both attestations match, and the UI must reflect what actually happened.
        const onChain = await publicClient.readContract({
          address: deployment.escrowAddress,
          abi: escrowAbi(),
          functionName: "getAgreement",
          args: [a.chainId],
        });
        const state = Number((onChain as { state: number }).state);
        const STATES = ["NONE", "DRAFT", "FUNDED", "ACTIVE", "NOTICE", "MOVE_OUT", "SETTLED"];

        const anchored =
          stage === "MOVE_IN" ? STATES[state] === "ACTIVE" : STATES[state] === "MOVE_OUT";

        await db
          .update(agreements)
          .set(
            stage === "MOVE_IN"
              ? { state: STATES[state] as "ACTIVE", moveInRoot: anchored ? root : null }
              : {
                  state: STATES[state] as "MOVE_OUT",
                  moveOutRoot: anchored ? root : null,
                  moveOutAt: anchored ? new Date() : null,
                }
          )
          .where(eq(agreements.id, a.id));

        return c.json({ root, anchored, state: STATES[state] });
      })

      .post("/api/agreements/:id/notice", async (c) => {
        const who = await requireUser(handle, c);
        const deployment = await requireDeployment(handle);
        const [a] = await db.select().from(agreements).where(eq(agreements.id, c.req.param("id")));
        if (!a) return c.json({ error: "not found" }, 404);

        await sendAs(await signer(who), deployment.escrowAddress, escrowAbi(), "giveNotice", [a.chainId]);
        await db
          .update(agreements)
          .set({ state: "NOTICE", noticeGivenAt: new Date() })
          .where(eq(agreements.id, a.id));
        return c.json({ ok: true });
      })

      // --------------------------------------------------------------- claims

      /**
       * The owner files deductions. Text is sealed behind a commitment until the
       * tenant has responded, so neither side gets to write second and tailor
       * their story to the other's.
       */
      .post("/api/agreements/:id/claims", async (c) => {
        const owner = await requireRole(handle, c, "OWNER");
        const body = await c.req.json();
        const agreementId = c.req.param("id");

        const [a] = await db.select().from(agreements).where(eq(agreements.id, agreementId));
        if (!a) return c.json({ error: "not found" }, 404);
        if (a.ownerAddress.toLowerCase() !== owner.walletAddress.toLowerCase()) {
          throw new ActorError("Only the owner can file deductions");
        }

        const incoming = Array.isArray(body.claims) ? body.claims : [];
        if (incoming.length === 0) throw new ActorError("No claims supplied");

        const created: string[] = [];
        for (const raw of incoming) {
          const text = String(raw.claimText ?? "");
          const { commitment, salt } = commit(text);
          const id = `clm-${randomUUID().slice(0, 8)}`;
          await db.insert(claimsTable).values({
            id,
            agreementId,
            itemId: String(raw.itemId),
            claimText: text,
            commitment,
            salt,
            committedAt: new Date(),
          });
          created.push(id);
        }
        return c.json({ ids: created }, 201);
      })

      .post("/api/claims/:id/rebuttal", async (c) => {
        const tenant = await requireRole(handle, c, "TENANT");
        const body = await c.req.json();
        const claimId = c.req.param("id");

        const [claim] = await db.select().from(claimsTable).where(eq(claimsTable.id, claimId));
        if (!claim) return c.json({ error: "not found" }, 404);

        const [a] = await db.select().from(agreements).where(eq(agreements.id, claim.agreementId));
        if (!a || a.tenantAddress.toLowerCase() !== tenant.walletAddress.toLowerCase()) {
          throw new ActorError("Only the tenant can respond to a claim");
        }

        const text = String(body.rebuttalText ?? "");
        const { commitment, salt } = commit(text);
        await db.insert(rebuttalsTable).values({
          id: `reb-${randomUUID().slice(0, 8)}`,
          claimId,
          rebuttalText: text,
          commitment,
          salt,
          committedAt: new Date(),
        });
        return c.json({ ok: true }, 201);
      })

      // -------------------------------------------------------------- dispute

      .post("/api/agreements/:id/dispute", async (c) => {
        const who = await requireUser(handle, c);
        const deployment = await requireDeployment(handle);
        const agreementId = c.req.param("id");

        const [a] = await db.select().from(agreements).where(eq(agreements.id, agreementId));
        if (!a) return c.json({ error: "not found" }, 404);
        if (!a.moveOutRoot) return c.json({ error: "move-out evidence is not anchored" }, 409);

        const rows = await db
          .select()
          .from(claimsTable)
          .where(eq(claimsTable.agreementId, agreementId));
        const claimsRoot = keccak256(toHex(JSON.stringify(rows.map((r) => r.commitment))));

        const receipt = await sendAs(
          await signer(who),
          deployment.escrowAddress,
          escrowAbi(),
          "raiseDepositDispute",
          [a.chainId, claimsRoot]
        );

        const nextId = await publicClient.readContract({
          address: deployment.escrowAddress,
          abi: escrowAbi(),
          functionName: "nextDisputeId",
          args: [],
        });
        const chainDisputeId = (nextId as bigint) - 1n;

        const id = `dispute-${chainDisputeId}`;
        await db.insert(disputes).values({
          id,
          agreementId,
          chainDisputeId: chainDisputeId.toString(),
          kind: "DEPOSIT",
          poolPaise: a.depositPaise,
          claimsRoot,
          evidenceRoot: a.moveOutRoot,
          raisedBy: who.walletAddress,
          openedAt: new Date(),
        });

        return c.json({ id, chainDisputeId: chainDisputeId.toString(), tx: receipt.transactionHash }, 201);
      })

      /**
       * Runs the panel, signs the verdict and executes it on-chain.
       *
       * Claims and rebuttals are revealed at this point: both sides have
       * committed, so there is nothing left to tailor.
       */
      .post("/api/disputes/:id/adjudicate", async (c) => {
        await requireUser(handle, c);
        const deployment = await requireDeployment(handle);
        const disputeId = c.req.param("id");

        const [dispute] = await db.select().from(disputes).where(eq(disputes.id, disputeId));
        if (!dispute) return c.json({ error: "not found" }, 404);
        if (dispute.resolvedAt) return c.json({ error: "already resolved" }, 409);

        // Returns straight away; the UI polls /status. Holding the request open
        // for the length of a rate-limited panel is what made this look like a
        // server error.
        const job = startJob(`adjudicate:${disputeId}`, async (progress) =>
          runAdjudication(handle, deployment, dispute, progress)
        );
        return c.json({ status: job.status, step: job.step }, 202);
      })

      /** Progress for a running adjudication. */
      .get("/api/disputes/:id/status", async (c) => {
        const disputeId = c.req.param("id");
        const job = getJob(`adjudicate:${disputeId}`);

        const [dispute] = await db.select().from(disputes).where(eq(disputes.id, disputeId));
        // No job record but the dispute is resolved: the server restarted, or
        // someone else ran it. The outcome is what matters, not the job.
        if (!job && dispute?.resolvedAt) {
          return c.json({ status: "done", verdictId: `verdict-${dispute.chainDisputeId}` });
        }
        if (!job) return c.json({ status: "idle" });

        return c.json({
          status: job.status,
          step: job.step,
          error: job.error,
          ...(job.result ?? {}),
        });
      })


      /**
       * Credits the wallet without any money changing hands.
       *
       * The real flow would confirm a UPI settlement first. There is no
       * settlement, so this mints directly and says so — it exists to keep a
       * demo moving when someone runs out of escrow currency mid-tenancy, not
       * to stand in for a payment.
       */
      .post("/api/topup/simulate", async (c) => {
        const user = await requireUser(handle, c);
        const deployment = await requireDeployment(handle);
        const body = await c.req.json().catch(() => ({}));

        const amountRupees = Math.min(500_000, Math.max(100, Number(body.amountRupees ?? 15_000)));
        await fundWallet(deployment.tokenAddress, user.walletAddress, rupees(amountRupees));

        const balance = await tokenBalance(deployment.tokenAddress, user.walletAddress);
        return c.json({
          simulated: true,
          creditedDisplay: formatPaise(rupees(amountRupees)),
          balanceDisplay: formatPaise(balance),
        });
      })

      /**
       * Skips a chain-clock wait. A tenancy runs for months and a demo runs for
       * minutes, so the 48-hour rent hold and 72-hour claims window need a way
       * past them. Local dev node only.
       */
      .post("/api/dev/advance-time", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        const days = Math.min(400, Math.max(1, Number(body.days ?? 3)));
        await advanceTime(days * 24 * 60 * 60);
        return c.json({ ok: true, days });
      })

      .onError((err, c) => {
        if (err instanceof KeyProtectionError) return c.json({ error: err.message }, 503);
        if (err instanceof AuthError) {
          return c.json({ error: err.message }, err.status);
        }
        if (err instanceof ActorError || err instanceof UnsupportedImageError) {
          return c.json({ error: err.message }, 400);
        }
        // Contract reverts arrive with a custom-error name that is genuinely the
        // most useful thing to show, e.g. "TooEarly" or "BadState".
        const message = err.message ?? "Something went wrong";
        const revert = /reverted with custom error '(\w+)\(\)'/.exec(message)?.[1];
        return c.json({ error: revert ? `Contract refused: ${revert}` : message }, 400);
      })
  );
}
