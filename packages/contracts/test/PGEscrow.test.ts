import hre from "hardhat";
import { expect } from "chai";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { keccak256, toHex, parseSignature, getAddress } from "viem";

const RENT = 1_500_000n; // Rs 15,000.00 in paise
const DEPOSIT = 4_500_000n; // Rs 45,000.00
const NOTICE_DAYS = 30;

const RENT_HOLD = 48 * 60 * 60;
const CLAIMS_WINDOW = 72 * 60 * 60;
const DISPUTE_TIMEOUT = 14 * 24 * 60 * 60;

const AGREEMENT_ID = keccak256(toHex("agreement-001"));
const MOVE_IN_ROOT = keccak256(toHex("move-in-evidence"));
const MOVE_OUT_ROOT = keccak256(toHex("move-out-evidence"));
const CLAIMS_ROOT = keccak256(toHex("owner-claims"));
const RATIONALE = keccak256(toHex("verdict-document"));

const VERDICT_TYPES = {
  Verdict: [
    { name: "disputeId", type: "uint256" },
    { name: "toOwnerPaise", type: "uint256" },
    { name: "toTenantPaise", type: "uint256" },
    { name: "rationaleHash", type: "bytes32" },
    { name: "evidenceRoot", type: "bytes32" },
    { name: "nonce", type: "uint64" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

async function deployFixture() {
  const [deployer, tenant, owner, oracle, stranger] = await hre.viem.getWalletClients();

  const token = await hre.viem.deployContract("MockINRC");
  const escrow = await hre.viem.deployContract("PGEscrow", [
    token.address,
    oracle.account.address,
    deployer.account.address,
  ]);

  // Fund the tenant with a year of rent plus the deposit.
  await token.write.mint([tenant.account.address, RENT * 12n + DEPOSIT]);
  await token.write.approve([escrow.address, RENT * 12n + DEPOSIT], {
    account: tenant.account,
  });

  const publicClient = await hre.viem.getPublicClient();

  return { token, escrow, deployer, tenant, owner, oracle, stranger, publicClient };
}

/** Builds and signs a verdict exactly as the judge service will. */
async function signVerdict(
  escrow: any,
  signer: any,
  verdict: {
    disputeId: bigint;
    toOwnerPaise: bigint;
    toTenantPaise: bigint;
    rationaleHash: `0x${string}`;
    evidenceRoot: `0x${string}`;
    nonce: bigint;
    deadline: bigint;
  }
) {
  const chainId = await (await hre.viem.getPublicClient()).getChainId();
  const signature = await signer.signTypedData({
    account: signer.account,
    domain: {
      name: "PGEscrow",
      version: "1",
      chainId,
      verifyingContract: escrow.address,
    },
    types: VERDICT_TYPES,
    primaryType: "Verdict",
    message: verdict,
  });
  return signature;
}

/** Drives an agreement all the way to MOVE_OUT with a deposit dispute open. */
async function toOpenDispute(
  f: Awaited<ReturnType<typeof deployFixture>>,
  id: `0x${string}` = AGREEMENT_ID
) {
  const { escrow, tenant, owner } = f;

  await escrow.write.createAgreement(
    [id, tenant.account.address, owner.account.address, RENT, DEPOSIT, NOTICE_DAYS],
    { account: owner.account }
  );
  await escrow.write.fund([id], { account: tenant.account });
  await escrow.write.attestMoveIn([id, MOVE_IN_ROOT], { account: tenant.account });
  await escrow.write.attestMoveIn([id, MOVE_IN_ROOT], { account: owner.account });
  await escrow.write.giveNotice([id], { account: tenant.account });
  await escrow.write.attestMoveOut([id, MOVE_OUT_ROOT], { account: tenant.account });
  await escrow.write.attestMoveOut([id, MOVE_OUT_ROOT], { account: owner.account });
  await escrow.write.raiseDepositDispute([id, CLAIMS_ROOT], { account: owner.account });
}

describe("PGEscrow", () => {
  describe("lifecycle", () => {
    it("runs a full tenancy from funding to an adjudicated settlement", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, token, tenant, owner, oracle } = f;

      await toOpenDispute(f);

      const deadline = BigInt((await time.latest()) + 3600);
      const toOwner = 1_200_000n; // Rs 12,000 of damage allowed
      const toTenant = DEPOSIT - toOwner;

      const verdict = {
        disputeId: 1n,
        toOwnerPaise: toOwner,
        toTenantPaise: toTenant,
        rationaleHash: RATIONALE,
        evidenceRoot: MOVE_OUT_ROOT,
        nonce: 1n,
        deadline,
      };
      const sig = await signVerdict(escrow, oracle, verdict);

      const ownerBefore = await token.read.balanceOf([owner.account.address]);
      const tenantBefore = await token.read.balanceOf([tenant.account.address]);

      await escrow.write.submitVerdict([verdict, sig]);

      expect(await token.read.balanceOf([owner.account.address])).to.equal(ownerBefore + toOwner);
      expect(await token.read.balanceOf([tenant.account.address])).to.equal(tenantBefore + toTenant);

      const agreement = await escrow.read.getAgreement([AGREEMENT_ID]);
      expect(agreement.state).to.equal(6); // SETTLED
      expect(agreement.depositPaise).to.equal(0n);
    });

    it("anchors move-in only when both parties attest the same root", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, tenant, owner } = f;

      await escrow.write.createAgreement(
        [AGREEMENT_ID, tenant.account.address, owner.account.address, RENT, DEPOSIT, NOTICE_DAYS],
        { account: owner.account }
      );
      await escrow.write.fund([AGREEMENT_ID], { account: tenant.account });

      await escrow.write.attestMoveIn([AGREEMENT_ID, MOVE_IN_ROOT], { account: tenant.account });
      let a = await escrow.read.getAgreement([AGREEMENT_ID]);
      expect(a.state).to.equal(2); // still FUNDED — one attestation is not agreement

      // Owner attests a *different* root: still no anchor.
      await escrow.write.attestMoveIn([AGREEMENT_ID, keccak256(toHex("different"))], {
        account: owner.account,
      });
      a = await escrow.read.getAgreement([AGREEMENT_ID]);
      expect(a.state).to.equal(2);

      await escrow.write.attestMoveIn([AGREEMENT_ID, MOVE_IN_ROOT], { account: owner.account });
      a = await escrow.read.getAgreement([AGREEMENT_ID]);
      expect(a.state).to.equal(3); // ACTIVE
      expect(a.moveInEvidenceRoot).to.equal(MOVE_IN_ROOT);
    });
  });

  describe("rent hold", () => {
    it("releases rent to the owner only after the 48h window", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, token, tenant, owner } = f;

      await escrow.write.createAgreement(
        [AGREEMENT_ID, tenant.account.address, owner.account.address, RENT, DEPOSIT, NOTICE_DAYS],
        { account: owner.account }
      );
      await escrow.write.fund([AGREEMENT_ID], { account: tenant.account });

      // Payment 1 was created by fund().
      await expect(escrow.write.releaseRent([1n])).to.be.rejectedWith("TooEarly");

      await time.increase(RENT_HOLD + 1);
      const before = await token.read.balanceOf([owner.account.address]);
      await escrow.write.releaseRent([1n]);
      expect(await token.read.balanceOf([owner.account.address])).to.equal(before + RENT);

      await expect(escrow.write.releaseRent([1n])).to.be.rejectedWith("RentAlreadyReleased");
    });

    it("lets the tenant freeze rent on habitability grounds inside the window", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, tenant, owner } = f;

      await escrow.write.createAgreement(
        [AGREEMENT_ID, tenant.account.address, owner.account.address, RENT, DEPOSIT, NOTICE_DAYS],
        { account: owner.account }
      );
      await escrow.write.fund([AGREEMENT_ID], { account: tenant.account });

      await escrow.write.fileRentComplaint([1n, CLAIMS_ROOT], { account: tenant.account });

      const dispute = await escrow.read.getDispute([1n]);
      expect(dispute.kind).to.equal(1); // RENT
      expect(dispute.poolPaise).to.equal(RENT);
      // Tenant is the claimant, so an unproven complaint pays the owner.
      expect(getAddress(dispute.timeoutBeneficiary)).to.equal(getAddress(owner.account.address));

      await time.increase(RENT_HOLD + 1);
      await expect(escrow.write.releaseRent([1n])).to.be.rejectedWith("RentUnderDispute");
    });

    it("refuses a complaint filed after the hold expired", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, tenant, owner } = f;

      await escrow.write.createAgreement(
        [AGREEMENT_ID, tenant.account.address, owner.account.address, RENT, DEPOSIT, NOTICE_DAYS],
        { account: owner.account }
      );
      await escrow.write.fund([AGREEMENT_ID], { account: tenant.account });
      await time.increase(RENT_HOLD + 1);

      await expect(
        escrow.write.fileRentComplaint([1n, CLAIMS_ROOT], { account: tenant.account })
      ).to.be.rejectedWith("TooLate");
    });
  });

  describe("verdict invariants", () => {
    it("rejects a split that does not equal the pool exactly", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, oracle } = f;
      await toOpenDispute(f);

      const deadline = BigInt((await time.latest()) + 3600);
      // One paisa short of the pool.
      const verdict = {
        disputeId: 1n,
        toOwnerPaise: 1_000_000n,
        toTenantPaise: DEPOSIT - 1_000_000n - 1n,
        rationaleHash: RATIONALE,
        evidenceRoot: MOVE_OUT_ROOT,
        nonce: 1n,
        deadline,
      };
      const sig = await signVerdict(escrow, oracle, verdict);
      await expect(escrow.write.submitVerdict([verdict, sig])).to.be.rejectedWith("SplitMismatch");
    });

    it("rejects an award larger than the pool", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, oracle } = f;
      await toOpenDispute(f);

      const deadline = BigInt((await time.latest()) + 3600);
      const verdict = {
        disputeId: 1n,
        toOwnerPaise: DEPOSIT * 10n,
        toTenantPaise: 0n,
        rationaleHash: RATIONALE,
        evidenceRoot: MOVE_OUT_ROOT,
        nonce: 1n,
        deadline,
      };
      const sig = await signVerdict(escrow, oracle, verdict);
      await expect(escrow.write.submitVerdict([verdict, sig])).to.be.rejectedWith("SplitMismatch");
    });

    it("rejects a verdict ruling on an evidence root that was never anchored", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, oracle } = f;
      await toOpenDispute(f);

      const deadline = BigInt((await time.latest()) + 3600);
      const verdict = {
        disputeId: 1n,
        toOwnerPaise: 1_000_000n,
        toTenantPaise: DEPOSIT - 1_000_000n,
        rationaleHash: RATIONALE,
        evidenceRoot: keccak256(toHex("photos-swapped-after-the-fact")),
        nonce: 1n,
        deadline,
      };
      const sig = await signVerdict(escrow, oracle, verdict);
      await expect(escrow.write.submitVerdict([verdict, sig])).to.be.rejectedWith(
        "EvidenceRootMismatch"
      );
    });

    it("rejects a verdict signed by anyone other than the oracle", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, stranger } = f;
      await toOpenDispute(f);

      const deadline = BigInt((await time.latest()) + 3600);
      const verdict = {
        disputeId: 1n,
        toOwnerPaise: DEPOSIT,
        toTenantPaise: 0n,
        rationaleHash: RATIONALE,
        evidenceRoot: MOVE_OUT_ROOT,
        nonce: 1n,
        deadline,
      };
      const sig = await signVerdict(escrow, stranger, verdict);
      await expect(escrow.write.submitVerdict([verdict, sig])).to.be.rejectedWith("BadSigner");
    });

    it("rejects re-submitting a verdict against an already-resolved dispute", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, oracle } = f;
      await toOpenDispute(f);

      const deadline = BigInt((await time.latest()) + 3600);
      const verdict = {
        disputeId: 1n,
        toOwnerPaise: 1_000_000n,
        toTenantPaise: DEPOSIT - 1_000_000n,
        rationaleHash: RATIONALE,
        evidenceRoot: MOVE_OUT_ROOT,
        nonce: 7n,
        deadline,
      };
      const sig = await signVerdict(escrow, oracle, verdict);
      await escrow.write.submitVerdict([verdict, sig]);

      // Same payload again — the dispute is resolved, and the nonce is burned.
      await expect(escrow.write.submitVerdict([verdict, sig])).to.be.rejectedWith(
        "DisputeAlreadyResolved"
      );
    });

    it("rejects a nonce reused across two different disputes", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, oracle } = f;
      const SECOND_ID = keccak256(toHex("agreement-002"));

      await toOpenDispute(f, AGREEMENT_ID); // dispute 1
      await toOpenDispute(f, SECOND_ID); // dispute 2

      const deadline = BigInt((await time.latest()) + 3600);
      const first = {
        disputeId: 1n,
        toOwnerPaise: 0n,
        toTenantPaise: DEPOSIT,
        rationaleHash: RATIONALE,
        evidenceRoot: MOVE_OUT_ROOT,
        nonce: 42n,
        deadline,
      };
      await escrow.write.submitVerdict([first, await signVerdict(escrow, oracle, first)]);

      // A different, validly signed verdict that happens to reuse the nonce.
      const second = { ...first, disputeId: 2n };
      await expect(
        escrow.write.submitVerdict([second, await signVerdict(escrow, oracle, second)])
      ).to.be.rejectedWith("NonceUsed");

      // A fresh nonce on the same dispute goes through.
      const retry = { ...second, nonce: 43n };
      await escrow.write.submitVerdict([retry, await signVerdict(escrow, oracle, retry)]);
      const d = await escrow.read.getDispute([2n]);
      expect(d.resolved).to.equal(true);
    });

    it("rejects an expired verdict", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, oracle } = f;
      await toOpenDispute(f);

      const deadline = BigInt((await time.latest()) + 60);
      const verdict = {
        disputeId: 1n,
        toOwnerPaise: 1_000_000n,
        toTenantPaise: DEPOSIT - 1_000_000n,
        rationaleHash: RATIONALE,
        evidenceRoot: MOVE_OUT_ROOT,
        nonce: 1n,
        deadline,
      };
      const sig = await signVerdict(escrow, oracle, verdict);
      await time.increase(120);
      await expect(escrow.write.submitVerdict([verdict, sig])).to.be.rejectedWith("VerdictExpired");
    });

    it("lets anyone submit a validly signed verdict — the signer, not the sender, is trusted", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, oracle, stranger, token, tenant } = f;
      await toOpenDispute(f);

      const deadline = BigInt((await time.latest()) + 3600);
      const verdict = {
        disputeId: 1n,
        toOwnerPaise: 0n,
        toTenantPaise: DEPOSIT,
        rationaleHash: RATIONALE,
        evidenceRoot: MOVE_OUT_ROOT,
        nonce: 1n,
        deadline,
      };
      const sig = await signVerdict(escrow, oracle, verdict);

      const before = await token.read.balanceOf([tenant.account.address]);
      await escrow.write.submitVerdict([verdict, sig], { account: stranger.account });
      expect(await token.read.balanceOf([tenant.account.address])).to.equal(before + DEPOSIT);
    });
  });

  describe("liveness", () => {
    it("refunds the deposit to the tenant if the oracle never rules", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, token, tenant, stranger } = f;
      await toOpenDispute(f);

      await expect(escrow.write.claimTimeout([1n])).to.be.rejectedWith("TooEarly");

      await time.increase(DISPUTE_TIMEOUT + 1);
      const before = await token.read.balanceOf([tenant.account.address]);
      // Permissionless: a bystander can unstick it.
      await escrow.write.claimTimeout([1n], { account: stranger.account });
      expect(await token.read.balanceOf([tenant.account.address])).to.equal(before + DEPOSIT);
    });

    it("pays a timed-out rent complaint to the owner, not the tenant", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, token, tenant, owner } = f;

      await escrow.write.createAgreement(
        [AGREEMENT_ID, tenant.account.address, owner.account.address, RENT, DEPOSIT, NOTICE_DAYS],
        { account: owner.account }
      );
      await escrow.write.fund([AGREEMENT_ID], { account: tenant.account });
      await escrow.write.fileRentComplaint([1n, CLAIMS_ROOT], { account: tenant.account });

      await time.increase(DISPUTE_TIMEOUT + 1);
      const before = await token.read.balanceOf([owner.account.address]);
      await escrow.write.claimTimeout([1n]);
      expect(await token.read.balanceOf([owner.account.address])).to.equal(before + RENT);
    });
  });

  describe("settlement without adjudication", () => {
    it("returns the full deposit when nobody claims a deduction", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, token, tenant, owner } = f;

      await escrow.write.createAgreement(
        [AGREEMENT_ID, tenant.account.address, owner.account.address, RENT, DEPOSIT, NOTICE_DAYS],
        { account: owner.account }
      );
      await escrow.write.fund([AGREEMENT_ID], { account: tenant.account });
      await escrow.write.attestMoveIn([AGREEMENT_ID, MOVE_IN_ROOT], { account: tenant.account });
      await escrow.write.attestMoveIn([AGREEMENT_ID, MOVE_IN_ROOT], { account: owner.account });
      await escrow.write.giveNotice([AGREEMENT_ID], { account: tenant.account });
      await escrow.write.attestMoveOut([AGREEMENT_ID, MOVE_OUT_ROOT], { account: tenant.account });
      await escrow.write.attestMoveOut([AGREEMENT_ID, MOVE_OUT_ROOT], { account: owner.account });

      await expect(escrow.write.settleUncontested([AGREEMENT_ID])).to.be.rejectedWith("TooEarly");

      await time.increase(CLAIMS_WINDOW + 1);
      const before = await token.read.balanceOf([tenant.account.address]);
      await escrow.write.settleUncontested([AGREEMENT_ID]);
      expect(await token.read.balanceOf([tenant.account.address])).to.equal(before + DEPOSIT);
    });

    it("settles instantly when both parties name the same figure", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, token, tenant, owner } = f;

      await escrow.write.createAgreement(
        [AGREEMENT_ID, tenant.account.address, owner.account.address, RENT, DEPOSIT, NOTICE_DAYS],
        { account: owner.account }
      );
      await escrow.write.fund([AGREEMENT_ID], { account: tenant.account });
      await escrow.write.attestMoveIn([AGREEMENT_ID, MOVE_IN_ROOT], { account: tenant.account });
      await escrow.write.attestMoveIn([AGREEMENT_ID, MOVE_IN_ROOT], { account: owner.account });
      await escrow.write.giveNotice([AGREEMENT_ID], { account: tenant.account });
      await escrow.write.attestMoveOut([AGREEMENT_ID, MOVE_OUT_ROOT], { account: tenant.account });
      await escrow.write.attestMoveOut([AGREEMENT_ID, MOVE_OUT_ROOT], { account: owner.account });

      const agreed = 500_000n; // Rs 5,000
      await escrow.write.proposeSettlement([AGREEMENT_ID, agreed], { account: owner.account });

      let a = await escrow.read.getAgreement([AGREEMENT_ID]);
      expect(a.state).to.equal(5); // still MOVE_OUT — one proposal is not agreement

      const ownerBefore = await token.read.balanceOf([owner.account.address]);
      const tenantBefore = await token.read.balanceOf([tenant.account.address]);
      await escrow.write.proposeSettlement([AGREEMENT_ID, agreed], { account: tenant.account });

      expect(await token.read.balanceOf([owner.account.address])).to.equal(ownerBefore + agreed);
      expect(await token.read.balanceOf([tenant.account.address])).to.equal(
        tenantBefore + DEPOSIT - agreed
      );
      a = await escrow.read.getAgreement([AGREEMENT_ID]);
      expect(a.state).to.equal(6); // SETTLED
    });
  });

  describe("access control", () => {
    it("refuses a second dispute on the same deposit", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, tenant } = f;
      await toOpenDispute(f);

      await expect(
        escrow.write.raiseDepositDispute([AGREEMENT_ID, CLAIMS_ROOT], { account: tenant.account })
      ).to.be.rejectedWith("DisputeAlreadyOpen");
    });

    it("refuses a dispute raised after settlement", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, oracle, tenant } = f;
      await toOpenDispute(f);

      const deadline = BigInt((await time.latest()) + 3600);
      const verdict = {
        disputeId: 1n,
        toOwnerPaise: 0n,
        toTenantPaise: DEPOSIT,
        rationaleHash: RATIONALE,
        evidenceRoot: MOVE_OUT_ROOT,
        nonce: 1n,
        deadline,
      };
      await escrow.write.submitVerdict([verdict, await signVerdict(escrow, oracle, verdict)]);

      await expect(
        escrow.write.raiseDepositDispute([AGREEMENT_ID, CLAIMS_ROOT], { account: tenant.account })
      ).to.be.rejectedWith("BadState");
    });

    it("refuses a stranger's attempt to fund or attest", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, tenant, owner, stranger } = f;

      await escrow.write.createAgreement(
        [AGREEMENT_ID, tenant.account.address, owner.account.address, RENT, DEPOSIT, NOTICE_DAYS],
        { account: owner.account }
      );
      await expect(
        escrow.write.fund([AGREEMENT_ID], { account: stranger.account })
      ).to.be.rejectedWith("NotTenant");

      await escrow.write.fund([AGREEMENT_ID], { account: tenant.account });
      await expect(
        escrow.write.attestMoveIn([AGREEMENT_ID, MOVE_IN_ROOT], { account: stranger.account })
      ).to.be.rejectedWith("NotParty");
    });

    it("only lets the admin rotate the oracle signer", async () => {
      const f = await loadFixture(deployFixture);
      const { escrow, deployer, stranger } = f;

      await expect(
        escrow.write.setOracleSigner([stranger.account.address], { account: stranger.account })
      ).to.be.rejectedWith("NotAdmin");

      await escrow.write.setOracleSigner([stranger.account.address], { account: deployer.account });
      expect(getAddress(await escrow.read.oracleSigner())).to.equal(
        getAddress(stranger.account.address)
      );
    });
  });
});
