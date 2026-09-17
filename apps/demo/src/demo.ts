// Picks up GEMINI_API_KEY from the repo-root .env before anything reads it.
import { loadEnv } from "../../api/src/env.js";
loadEnv();

import { keccak256, toHex, formatUnits, type Address, type Hex } from "viem";
import { formatPaise, settleDeposit, type LedgerEntry, type TenancyFacts } from "@pg/core";
import { merkleRoot, commit, checkFraming } from "@pg/evidence";
import {
  adjudicate,
  ScriptedJudgeClient,
  createJudgeClient,
  resolveProvider,
  signVerdict,
  oracleAddress,
  type JudgeClient,
} from "@pg/judge";
import { createDb, migrate, reset } from "@pg/db";
import { startChain, artifact, KEYS } from "./chain.js";
import {
  AGREEMENT,
  CLAIMS,
  ITEMS,
  MOVE_IN_PHOTOS,
  MOVE_OUT_PHOTOS,
  PHOTO_DESCRIPTIONS,
  REBUTTALS,
  SCRIPTED,
} from "./scenario.js";

const HOUR = 3600;
const DAY = 24 * HOUR;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

let step = 0;
function say(msg: string, detail?: string) {
  step += 1;
  console.log(`${cyan(String(step).padStart(2, "0"))}  ${msg}${detail ? dim(`  ${detail}`) : ""}`);
}
function rule(title?: string) {
  console.log(title ? `\n${bold(title)}\n${"-".repeat(72)}` : "-".repeat(72));
}

async function main() {
  console.log(bold("\nPG Escrow — end-to-end demo\n"));

  const provider = resolveProvider();
  // The scripted path keeps the demo's own rehearsed answers rather than the
  // empty stub, so the narration still makes sense without a key.
  const judge: JudgeClient =
    provider === "scripted" ? new ScriptedJudgeClient(SCRIPTED) : createJudgeClient(provider);

  console.log(
    provider === "scripted"
      ? `Adjudicator: ${bold("scripted")}. ${dim("Set GEMINI_API_KEY to run the real panel.")}`
      : green(`Adjudicator: ${judge.models.adjudication}, live.`)
  );
  console.log(
    dim(
      "Evidence is supplied as written records rather than photographs; see packages/judge/evals/fixtures/README.md.\n"
    )
  );

  const db = createDb();
  await reset(db);

  rule("Chain");
  const chain = await startChain();

  try {
    const escrowArt = artifact("PGEscrow");
    const tokenArt = artifact("MockINRC");

    const token = await chain.deploy("MockINRC", []);
    const oracle = oracleAddress(KEYS.oracle);
    const escrow = await chain.deploy("PGEscrow", [token, oracle, chain.addresses.deployer]);
    say("Deployed MockINRC and PGEscrow", `escrow ${escrow}`);
    say("Registered the adjudicator as verdict oracle", oracle);

    const agreementId = keccak256(toHex(AGREEMENT.id));
    const total = AGREEMENT.depositPaise + AGREEMENT.rentPaise;

    await chain.send(token, tokenArt.abi, "mint", [chain.addresses.tenant, total * 6n], "deployer");
    await chain.send(token, tokenArt.abi, "approve", [escrow, total * 6n], "tenant");

    // ---------------------------------------------------------------- tenancy
    rule("Tenancy");

    await chain.send(
      escrow,
      escrowArt.abi,
      "createAgreement",
      [
        agreementId,
        chain.addresses.tenant,
        chain.addresses.owner,
        AGREEMENT.rentPaise,
        AGREEMENT.depositPaise,
        AGREEMENT.noticeDays,
      ],
      "owner"
    );
    say(
      "Agreement created",
      `${AGREEMENT.propertyLabel} — rent ${formatPaise(AGREEMENT.rentPaise)}, deposit ${formatPaise(AGREEMENT.depositPaise)}`
    );

    await chain.send(escrow, escrowArt.abi, "fund", [agreementId], "tenant");
    say("Tenant funded escrow", `${formatPaise(total)} held by the contract, not the owner`);

    const moveInRoot = merkleRoot(MOVE_IN_PHOTOS);
    await chain.send(escrow, escrowArt.abi, "attestMoveIn", [agreementId, moveInRoot], "tenant");
    await chain.send(escrow, escrowArt.abi, "attestMoveIn", [agreementId, moveInRoot], "owner");
    say("Move-in evidence anchored", `${MOVE_IN_PHOTOS.length} photos, root ${moveInRoot.slice(0, 18)}...`);
    say("Both parties attested the same root", dim("neither side sets the baseline alone"));

    // Rent cycles: fund() created payment #1, then two more.
    const ledger: LedgerEntry[] = [];
    for (let cycle = 1; cycle <= 3; cycle++) {
      if (cycle > 1) {
        await chain.send(escrow, escrowArt.abi, "payRent", [agreementId], "tenant");
      }
      await chain.advance(2 * DAY + HOUR);
      await chain.send(escrow, escrowArt.abi, "releaseRent", [BigInt(cycle)], "deployer");
      ledger.push({
        cycleIndex: cycle,
        dueAt: new Date(`2025-0${3 + cycle}-01T00:00:00Z`),
        amountPaise: AGREEMENT.rentPaise,
        paidAt: new Date(`2025-0${3 + cycle}-01T00:00:00Z`),
      });
      await chain.advance(26 * DAY);
    }
    say("Three rent cycles paid and released", dim("48h hold each, no habitability complaint"));

    await chain.send(escrow, escrowArt.abi, "giveNotice", [agreementId], "tenant");
    say("Tenant gave notice");

    // ------------------------------------------------------------ move-out
    rule("Move-out");

    const framing = checkFraming(MOVE_IN_PHOTOS, MOVE_OUT_PHOTOS);
    const rejected = framing.filter((f) => !f.acceptable);
    say(
      "Move-out capture framing checked",
      rejected.length === 0
        ? `all ${framing.length} shots match their baseline`
        : `${rejected.length} rejected for retake`
    );

    const moveOutRoot = merkleRoot(MOVE_OUT_PHOTOS);
    await chain.send(escrow, escrowArt.abi, "attestMoveOut", [agreementId, moveOutRoot], "tenant");
    await chain.send(escrow, escrowArt.abi, "attestMoveOut", [agreementId, moveOutRoot], "owner");
    say(
      "Move-out evidence anchored",
      `root ${moveOutRoot.slice(0, 18)}... ${dim("— before anyone knew there would be a dispute")}`
    );

    // ------------------------------------------------------------- dispute
    rule("Dispute");

    const commitments = CLAIMS.map((c) => commit(c.claimText).commitment);
    const claimsRoot = keccak256(toHex(JSON.stringify(commitments)));
    say("Owner sealed 3 deduction claims", dim("commit-reveal: neither side writes second"));

    await chain.send(escrow, escrowArt.abi, "raiseDepositDispute", [agreementId, claimsRoot], "owner");
    const disputeId = 1n;
    say("Deposit dispute raised", `pool ${formatPaise(AGREEMENT.depositPaise)} frozen on-chain`);

    for (const c of CLAIMS) {
      const item = ITEMS.find((i) => i.id === c.itemId)!;
      console.log(dim(`      - ${item.label}`));
    }

    // ------------------------------------------------------------ adjudicate
    rule("Adjudication");
    console.log(dim("Three panelists per claim: tenant-advocate, owner-advocate, neutral.\n"));

    const facts: TenancyFacts = {
      terms: {
        id: AGREEMENT.id,
        rentPaise: AGREEMENT.rentPaise,
        depositPaise: AGREEMENT.depositPaise,
        noticeDays: AGREEMENT.noticeDays,
        lateFeeRate: AGREEMENT.lateFeeRateBps / 10_000,
        startAt: new Date("2025-04-01T00:00:00Z"),
      },
      ledger,
      items: ITEMS,
      noticeGivenAt: new Date("2025-06-01T00:00:00Z"),
      moveOutAt: new Date("2025-07-01T00:00:00Z"),
      occupiedMonths: AGREEMENT.occupiedMonths,
    };

    const started = Date.now();
    const result = await adjudicate(judge, {
      disputeId,
      facts,
      claims: CLAIMS,
      rebuttals: REBUTTALS,
      photosByClaim: {},
      photoDescriptionByClaim: PHOTO_DESCRIPTIONS,
      evidenceRoot: moveOutRoot,
    });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    for (const line of result.settlement.adjudicated) {
      const panel = result.audit.panels.find((p) => p.claimId === line.claimId);
      const screen = result.audit.screens[line.claimId];
      const outcome =
        line.allowedPaise > 0n
          ? green(`allowed ${formatPaise(line.allowedPaise)}`)
          : red("disallowed");

      console.log(`  ${bold(line.label)}`);
      console.log(`    ceiling after depreciation  ${formatPaise(line.ceilingPaise)}`);
      console.log(`    panel spread                ${panel?.spread.toFixed(2) ?? "-"}`);
      if (screen?.claim.suspicious) {
        console.log(`    ${red("injection detected")}          ${screen.claim.technique}`);
      }
      if (panel?.fallbackApplied) {
        console.log(`    fallback rule               ${panel.fallbackApplied}`);
      }
      console.log(`    outcome                     ${outcome}`);
      for (const adj of line.adjustments) console.log(dim(`      ${adj}`));
      console.log();
    }

    say(
      `Panel completed in ${elapsed}s`,
      `${result.audit.panels.length * 3} assessments via ${result.audit.adjudicationModel}`
    );

    // ---------------------------------------------------------------- verdict
    rule("Verdict");

    const chainId = await chain.publicClient.getChainId();
    // Deadline must be measured against chain time: the demo has advanced the
    // chain clock three months, so wall clock would already be in the past.
    const latestBlock = await chain.publicClient.getBlock();
    const signed = await signVerdict({
      nowSeconds: latestBlock.timestamp,
      oraclePrivateKey: KEYS.oracle,
      chainId,
      escrowAddress: escrow as Address,
      disputeId,
      toOwnerPaise: result.settlement.toOwnerPaise,
      toTenantPaise: result.settlement.toTenantPaise,
      rationaleHash: result.rationaleHash,
      evidenceRoot: moveOutRoot,
      nonce: 1n,
    });
    say("Verdict signed (EIP-712)", dim("the oracle signs; anyone may submit and pay the gas"));

    const before = {
      owner: await balanceOf(chain, token, tokenArt.abi, chain.addresses.owner),
      tenant: await balanceOf(chain, token, tokenArt.abi, chain.addresses.tenant),
    };

    const receipt = await chain.send(
      escrow,
      escrowArt.abi,
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
      ],
      "deployer"
    );
    say("Verdict executed on-chain", `tx ${receipt.transactionHash.slice(0, 18)}...`);
    console.log(
      dim(
        "      contract re-checked: splits sum to the pool, evidence root matches the anchor, signature recovers to the oracle"
      )
    );

    const after = {
      owner: await balanceOf(chain, token, tokenArt.abi, chain.addresses.owner),
      tenant: await balanceOf(chain, token, tokenArt.abi, chain.addresses.tenant),
    };

    rule("Settlement");
    console.log(`  Deposit held            ${formatPaise(AGREEMENT.depositPaise)}`);
    console.log(
      `  To the owner            ${formatPaise(result.settlement.toOwnerPaise)}   ${dim(`wallet +${formatPaise(after.owner - before.owner)}`)}`
    );
    console.log(
      `  To the tenant           ${formatPaise(result.settlement.toTenantPaise)}   ${dim(`wallet +${formatPaise(after.tenant - before.tenant)}`)}`
    );

    const conserved =
      result.settlement.toOwnerPaise + result.settlement.toTenantPaise === AGREEMENT.depositPaise;
    console.log(
      `\n  ${conserved ? green("Conserved") : red("NOT CONSERVED")}: toOwner + toTenant == deposit, exactly.`
    );

    await persist(db, {
      agreementId,
      escrow,
      moveInRoot,
      moveOutRoot,
      claimsRoot,
      disputeId,
      result,
      signed,
      txHash: receipt.transactionHash,
      addresses: chain.addresses,
    });

    rule("Audit record");
    console.log(`  model                   ${result.audit.adjudicationModel}`);
    console.log(`  rubric                  ${result.audit.rubricVersion}`);
    console.log(`  depreciation schedule   ${result.audit.depreciationScheduleVersion}`);
    console.log(`  evidence root           ${result.audit.evidenceRoot}`);
    console.log(`  rationale hash          ${result.rationaleHash}`);
    console.log(dim(`\n  Full record written to pg-escrow.db (table: verdicts).`));

    rule();
    console.log(bold("\nThe tenant's written settlement\n"));
    console.log(
      result.rationale
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")
    );
    console.log();
  } finally {
    chain.stop();
    db.close();
  }
}

async function balanceOf(
  chain: Awaited<ReturnType<typeof startChain>>,
  token: Address,
  abi: readonly unknown[],
  who: Address
): Promise<bigint> {
  return (await chain.publicClient.readContract({
    address: token,
    abi: abi as never,
    functionName: "balanceOf",
    args: [who],
  })) as bigint;
}

async function persist(
  handle: ReturnType<typeof createDb>,
  data: Record<string, unknown>
): Promise<void> {
  const { agreements, inventoryItems, photos, claims, disputes, verdicts } = await import("@pg/db");
  const { db } = handle;
  const now = new Date();
  const d = data as never as {
    agreementId: Hex;
    escrow: Address;
    moveInRoot: Hex;
    moveOutRoot: Hex;
    claimsRoot: Hex;
    disputeId: bigint;
    result: Awaited<ReturnType<typeof adjudicate>>;
    signed: Awaited<ReturnType<typeof signVerdict>>;
    txHash: Hex;
    addresses: Record<string, Address>;
  };

  await db.insert(agreements).values({
    id: AGREEMENT.id,
    chainId: d.agreementId,
    tenantAddress: d.addresses.tenant!,
    ownerAddress: d.addresses.owner!,
    tenantName: AGREEMENT.tenantName,
    ownerName: AGREEMENT.ownerName,
    propertyLabel: AGREEMENT.propertyLabel,
    rentPaise: AGREEMENT.rentPaise.toString(),
    depositPaise: AGREEMENT.depositPaise.toString(),
    noticeDays: AGREEMENT.noticeDays,
    lateFeeRateBps: AGREEMENT.lateFeeRateBps,
    state: "SETTLED",
    moveInRoot: d.moveInRoot,
    moveOutRoot: d.moveOutRoot,
    startAt: new Date("2025-04-01T00:00:00Z"),
    noticeGivenAt: new Date("2025-06-01T00:00:00Z"),
    moveOutAt: new Date("2025-07-01T00:00:00Z"),
    createdAt: now,
  });

  await db.insert(inventoryItems).values(
    ITEMS.map((i) => ({
      id: i.id,
      agreementId: AGREEMENT.id,
      category: i.category,
      label: i.label,
      ageMonths: i.ageMonths,
      replacementCostPaise: i.replacementCostPaise.toString(),
      conditionAtMoveIn: i.conditionAtMoveIn,
      photoSlots: JSON.stringify(i.photoSlots),
    }))
  );

  await db.insert(photos).values(
    [...MOVE_IN_PHOTOS, ...MOVE_OUT_PHOTOS].map((p) => ({
      id: p.id,
      agreementId: AGREEMENT.id,
      itemId: p.itemId,
      slot: p.slot,
      stage: p.stage,
      sha256: p.sha256,
      storageKey: p.storageKey,
      mediaType: "image/jpeg",
      capturedAt: p.capturedAt,
      capturedBy: p.capturedBy,
      pose: JSON.stringify(p.pose),
    }))
  );

  await db.insert(claims).values(
    CLAIMS.map((c) => ({
      id: c.id,
      agreementId: AGREEMENT.id,
      itemId: c.itemId,
      claimText: c.claimText,
      commitment: commit(c.claimText).commitment,
      committedAt: now,
      revealedAt: now,
    }))
  );

  await db.insert(disputes).values({
    id: `dispute-${d.disputeId}`,
    agreementId: AGREEMENT.id,
    chainDisputeId: d.disputeId.toString(),
    kind: "DEPOSIT",
    poolPaise: AGREEMENT.depositPaise.toString(),
    claimsRoot: d.claimsRoot,
    evidenceRoot: d.moveOutRoot,
    raisedBy: d.addresses.owner!,
    openedAt: now,
    resolvedAt: now,
  });

  await db.insert(verdicts).values({
    id: `verdict-${d.disputeId}`,
    disputeId: `dispute-${d.disputeId}`,
    toOwnerPaise: d.result.settlement.toOwnerPaise.toString(),
    toTenantPaise: d.result.settlement.toTenantPaise.toString(),
    rationale: d.result.rationale,
    rationaleHash: d.result.rationaleHash,
    evidenceRoot: d.result.audit.evidenceRoot,
    auditJson: JSON.stringify(d.result.audit, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v
    ),
    adjudicationModel: d.result.audit.adjudicationModel,
    rubricVersion: d.result.audit.rubricVersion,
    depreciationScheduleVersion: d.result.audit.depreciationScheduleVersion,
    signature: d.signed.signature,
    nonce: d.signed.nonce.toString(),
    txHash: d.txHash,
    decidedAt: now,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
