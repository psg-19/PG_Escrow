// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PGEscrow
/// @notice Escrow for paying-guest tenancies. Custody sits here; judgment comes
///         from an off-chain AI adjudicator that signs EIP-712 verdicts.
///
/// The design goal is that a compromised or hallucinating oracle still cannot
/// steal or mint money. Every verdict is checked against three on-chain
/// invariants before a single paisa moves:
///
///   1. toOwner + toTenant == dispute.poolPaise   (exact, no dust, no leakage)
///   2. the evidence root it ruled on == the root anchored BEFORE the dispute
///   3. the signature recovers to the registered oracle signer, nonce unused
///
/// So the blast radius of a bad verdict is bounded to misallocating a pool that
/// already exists, and it can never be a pool whose evidence was swapped after
/// the argument started.
///
/// Liveness: if no verdict arrives within DISPUTE_TIMEOUT, anyone may settle the
/// dispute in favour of its `timeoutBeneficiary` — the party that was NOT making
/// the claim. An unproven claim fails, and an offline oracle cannot lock funds.
contract PGEscrow is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum State {
        NONE,
        DRAFT,
        FUNDED,
        ACTIVE,
        NOTICE,
        MOVE_OUT,
        SETTLED
    }

    enum DisputeKind {
        DEPOSIT,
        RENT
    }

    struct Agreement {
        address tenant;
        address owner;
        uint256 rentPaise;
        uint256 depositPaise; // currently escrowed; zeroed on settlement
        uint64 startAt;
        uint64 moveOutAt;
        uint16 noticeDays;
        bytes32 moveInEvidenceRoot;
        bytes32 moveOutEvidenceRoot;
        State state;
        uint256 openDisputeId; // 0 = none
    }

    struct RentPayment {
        bytes32 agreementId;
        uint256 amountPaise;
        uint64 releasableAt;
        bool released;
        uint256 disputeId; // 0 = none
    }

    struct Dispute {
        bytes32 agreementId;
        DisputeKind kind;
        uint256 poolPaise;
        uint256 rentPaymentId; // 0 for DEPOSIT disputes
        uint64 openedAt;
        uint64 resolveBy;
        address timeoutBeneficiary;
        bytes32 claimsRoot;
        bytes32 evidenceRoot; // snapshot taken when the dispute opened
        bool resolved;
    }

    /// @notice The payload the AI adjudicator signs.
    struct Verdict {
        uint256 disputeId;
        uint256 toOwnerPaise;
        uint256 toTenantPaise;
        bytes32 rationaleHash; // sha256 of the full JSON verdict document
        bytes32 evidenceRoot;
        uint64 nonce;
        uint64 deadline;
    }

    bytes32 private constant VERDICT_TYPEHASH =
        keccak256(
            "Verdict(uint256 disputeId,uint256 toOwnerPaise,uint256 toTenantPaise,bytes32 rationaleHash,bytes32 evidenceRoot,uint64 nonce,uint64 deadline)"
        );

    // ---------------------------------------------------------------------
    // Config
    // ---------------------------------------------------------------------

    /// @notice Rent is held briefly, not for the whole term. Long-held rent
    ///         wrecks owner cashflow and would kill supply-side adoption; 48h
    ///         is enough to give a tenant leverage on habitability.
    uint64 public constant RENT_HOLD = 48 hours;

    /// @notice Window after move-out in which deductions may be claimed.
    uint64 public constant CLAIMS_WINDOW = 72 hours;

    /// @notice Oracle liveness bound. After this, the timeout path opens.
    uint64 public constant DISPUTE_TIMEOUT = 14 days;

    IERC20 public immutable token;

    /// @notice Recovers verdict signatures. Rotatable because a demo key in an
    ///         .env file will eventually need replacing; production should point
    ///         this at a threshold signer or a TEE attestation verifier.
    address public oracleSigner;
    address public admin;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    mapping(bytes32 => Agreement) private _agreements;
    mapping(bytes32 => uint256) private _expectedDeposit;
    mapping(uint256 => RentPayment) private _rentPayments;
    mapping(uint256 => Dispute) private _disputes;
    mapping(uint64 => bool) public verdictNonceUsed;

    // agreementId => party => the root that party attested to
    mapping(bytes32 => mapping(address => bytes32)) private _moveInAttest;
    mapping(bytes32 => mapping(address => bytes32)) private _moveOutAttest;

    // agreementId => proposer => proposed owner-share (mutual settlement path)
    mapping(bytes32 => mapping(address => uint256)) private _settlementProposal;
    mapping(bytes32 => mapping(address => bool)) private _hasProposed;

    uint256 public nextRentPaymentId = 1;
    uint256 public nextDisputeId = 1;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event AgreementCreated(bytes32 indexed id, address indexed tenant, address indexed owner, uint256 rentPaise, uint256 depositPaise);
    event Funded(bytes32 indexed id, uint256 depositPaise, uint256 firstRentPaymentId);
    event MoveInAttested(bytes32 indexed id, address indexed party, bytes32 root);
    event MoveInAnchored(bytes32 indexed id, bytes32 root);
    event RentPaid(bytes32 indexed id, uint256 indexed paymentId, uint256 amountPaise, uint64 releasableAt);
    event RentReleased(bytes32 indexed id, uint256 indexed paymentId, uint256 amountPaise);
    event NoticeGiven(bytes32 indexed id, uint64 at);
    event MoveOutAttested(bytes32 indexed id, address indexed party, bytes32 root);
    event MoveOutAnchored(bytes32 indexed id, bytes32 root);
    event DisputeRaised(uint256 indexed disputeId, bytes32 indexed agreementId, DisputeKind kind, uint256 poolPaise, address claimant, bytes32 claimsRoot);
    event VerdictExecuted(uint256 indexed disputeId, uint256 toOwnerPaise, uint256 toTenantPaise, bytes32 rationaleHash);
    event DisputeTimedOut(uint256 indexed disputeId, address beneficiary, uint256 amountPaise);
    event SettlementProposed(bytes32 indexed id, address indexed proposer, uint256 toOwnerPaise);
    event SettledUncontested(bytes32 indexed id, uint256 toTenantPaise);
    event SettledByAgreement(bytes32 indexed id, uint256 toOwnerPaise, uint256 toTenantPaise);
    event OracleSignerChanged(address indexed previous, address indexed next);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotParty();
    error NotTenant();
    error NotAdmin();
    error BadState();
    error AlreadyExists();
    error UnknownAgreement();
    error UnknownDispute();
    error DisputeAlreadyOpen();
    error DisputeAlreadyResolved();
    error SplitMismatch(uint256 provided, uint256 expected);
    error EvidenceRootMismatch();
    error BadSigner();
    error NonceUsed();
    error VerdictExpired();
    error TooEarly();
    error TooLate();
    error RentAlreadyReleased();
    error RentUnderDispute();
    error ZeroAddress();
    error AttestationMismatch();

    // ---------------------------------------------------------------------

    constructor(IERC20 token_, address oracleSigner_, address admin_) EIP712("PGEscrow", "1") {
        if (address(token_) == address(0) || oracleSigner_ == address(0) || admin_ == address(0)) {
            revert ZeroAddress();
        }
        token = token_;
        oracleSigner = oracleSigner_;
        admin = admin_;
    }

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    /// @param id Caller-supplied id so the backend's row and the chain agree.
    function createAgreement(
        bytes32 id,
        address tenant,
        address owner,
        uint256 rentPaise,
        uint256 depositPaise,
        uint16 noticeDays
    ) external {
        if (_agreements[id].state != State.NONE) revert AlreadyExists();
        if (tenant == address(0) || owner == address(0)) revert ZeroAddress();

        Agreement storage a = _agreements[id];
        a.tenant = tenant;
        a.owner = owner;
        a.rentPaise = rentPaise;
        a.depositPaise = 0; // set on funding
        a.noticeDays = noticeDays;
        a.state = State.DRAFT;

        // Agreed at signing; becomes the authoritative escrowed figure at fund().
        _expectedDeposit[id] = depositPaise;

        emit AgreementCreated(id, tenant, owner, rentPaise, depositPaise);
    }

    /// @notice Tenant pays the deposit plus the first month's rent.
    function fund(bytes32 id) external nonReentrant {
        Agreement storage a = _agreements[id];
        if (a.state == State.NONE) revert UnknownAgreement();
        if (a.state != State.DRAFT) revert BadState();
        if (msg.sender != a.tenant) revert NotTenant();

        uint256 deposit = _expectedDeposit[id];
        uint256 total = deposit + a.rentPaise;
        token.safeTransferFrom(msg.sender, address(this), total);

        a.depositPaise = deposit;
        a.state = State.FUNDED;
        a.startAt = uint64(block.timestamp);

        uint256 paymentId = _recordRent(id, a.rentPaise);
        emit Funded(id, deposit, paymentId);
    }

    /// @notice Both parties attest to the same move-in evidence root. Requiring
    ///         agreement here is what makes the later before/after comparison
    ///         mean something — neither side can quietly set the baseline.
    function attestMoveIn(bytes32 id, bytes32 root) external {
        Agreement storage a = _agreements[id];
        if (a.state != State.FUNDED) revert BadState();
        if (msg.sender != a.tenant && msg.sender != a.owner) revert NotParty();

        _moveInAttest[id][msg.sender] = root;
        emit MoveInAttested(id, msg.sender, root);

        bytes32 t = _moveInAttest[id][a.tenant];
        bytes32 o = _moveInAttest[id][a.owner];
        if (t != bytes32(0) && t == o) {
            a.moveInEvidenceRoot = t;
            a.state = State.ACTIVE;
            emit MoveInAnchored(id, t);
        }
    }

    function payRent(bytes32 id) external nonReentrant returns (uint256 paymentId) {
        Agreement storage a = _agreements[id];
        if (a.state != State.ACTIVE && a.state != State.NOTICE) revert BadState();
        if (msg.sender != a.tenant) revert NotTenant();

        token.safeTransferFrom(msg.sender, address(this), a.rentPaise);
        paymentId = _recordRent(id, a.rentPaise);
    }

    function _recordRent(bytes32 id, uint256 amount) private returns (uint256 paymentId) {
        paymentId = nextRentPaymentId++;
        _rentPayments[paymentId] = RentPayment({
            agreementId: id,
            amountPaise: amount,
            releasableAt: uint64(block.timestamp) + RENT_HOLD,
            released: false,
            disputeId: 0
        });
        emit RentPaid(id, paymentId, amount, uint64(block.timestamp) + RENT_HOLD);
    }

    /// @notice Permissionless: after the hold expires with no complaint, rent goes
    ///         to the owner. Anyone may push it (a keeper, the owner, the UI).
    function releaseRent(uint256 paymentId) external nonReentrant {
        RentPayment storage p = _rentPayments[paymentId];
        if (p.amountPaise == 0) revert UnknownAgreement();
        if (p.released) revert RentAlreadyReleased();
        if (p.disputeId != 0) revert RentUnderDispute();
        if (block.timestamp < p.releasableAt) revert TooEarly();

        Agreement storage a = _agreements[p.agreementId];
        p.released = true;
        token.safeTransfer(a.owner, p.amountPaise);
        emit RentReleased(p.agreementId, paymentId, p.amountPaise);
    }

    /// @notice Tenant freezes a rent payment on habitability grounds. Must land
    ///         inside the hold window — you cannot claw back released rent.
    function fileRentComplaint(uint256 paymentId, bytes32 claimsRoot) external returns (uint256 disputeId) {
        RentPayment storage p = _rentPayments[paymentId];
        if (p.amountPaise == 0) revert UnknownAgreement();
        if (p.released) revert RentAlreadyReleased();
        if (p.disputeId != 0) revert DisputeAlreadyOpen();
        if (block.timestamp >= p.releasableAt) revert TooLate();

        Agreement storage a = _agreements[p.agreementId];
        if (msg.sender != a.tenant) revert NotTenant();

        // The tenant is the claimant here, so an unproven complaint pays the owner.
        disputeId = _openDispute(p.agreementId, DisputeKind.RENT, p.amountPaise, paymentId, a.owner, claimsRoot, a.moveInEvidenceRoot);
        p.disputeId = disputeId;
    }

    function giveNotice(bytes32 id) external {
        Agreement storage a = _agreements[id];
        if (a.state != State.ACTIVE) revert BadState();
        if (msg.sender != a.tenant && msg.sender != a.owner) revert NotParty();
        a.state = State.NOTICE;
        emit NoticeGiven(id, uint64(block.timestamp));
    }

    function attestMoveOut(bytes32 id, bytes32 root) external {
        Agreement storage a = _agreements[id];
        if (a.state != State.NOTICE) revert BadState();
        if (msg.sender != a.tenant && msg.sender != a.owner) revert NotParty();

        _moveOutAttest[id][msg.sender] = root;
        emit MoveOutAttested(id, msg.sender, root);

        bytes32 t = _moveOutAttest[id][a.tenant];
        bytes32 o = _moveOutAttest[id][a.owner];
        if (t != bytes32(0) && t == o) {
            a.moveOutEvidenceRoot = t;
            a.moveOutAt = uint64(block.timestamp);
            a.state = State.MOVE_OUT;
            emit MoveOutAnchored(id, t);
        }
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    /// @notice No deductions claimed inside the window: the deposit goes back in
    ///         full. Permissionless so the tenant is never at the owner's mercy.
    function settleUncontested(bytes32 id) external nonReentrant {
        Agreement storage a = _agreements[id];
        if (a.state != State.MOVE_OUT) revert BadState();
        if (a.openDisputeId != 0) revert DisputeAlreadyOpen();
        if (block.timestamp < a.moveOutAt + CLAIMS_WINDOW) revert TooEarly();

        uint256 amount = a.depositPaise;
        a.depositPaise = 0;
        a.state = State.SETTLED;
        token.safeTransfer(a.tenant, amount);
        emit SettledUncontested(id, amount);
    }

    /// @notice Both parties name the same owner-share; no adjudication needed.
    ///         Most real move-outs should end here rather than in a dispute.
    function proposeSettlement(bytes32 id, uint256 toOwnerPaise) external nonReentrant {
        Agreement storage a = _agreements[id];
        if (a.state != State.MOVE_OUT) revert BadState();
        if (a.openDisputeId != 0) revert DisputeAlreadyOpen();
        if (msg.sender != a.tenant && msg.sender != a.owner) revert NotParty();
        if (toOwnerPaise > a.depositPaise) revert SplitMismatch(toOwnerPaise, a.depositPaise);

        _settlementProposal[id][msg.sender] = toOwnerPaise;
        _hasProposed[id][msg.sender] = true;
        emit SettlementProposed(id, msg.sender, toOwnerPaise);

        if (
            _hasProposed[id][a.tenant] &&
            _hasProposed[id][a.owner] &&
            _settlementProposal[id][a.tenant] == _settlementProposal[id][a.owner]
        ) {
            uint256 toOwner = toOwnerPaise;
            uint256 toTenant = a.depositPaise - toOwner;
            a.depositPaise = 0;
            a.state = State.SETTLED;
            if (toOwner > 0) token.safeTransfer(a.owner, toOwner);
            if (toTenant > 0) token.safeTransfer(a.tenant, toTenant);
            emit SettledByAgreement(id, toOwner, toTenant);
        }
    }

    /// @notice Either party escalates to the adjudicator. Snapshots the move-out
    ///         evidence root, which was anchored before anyone knew there would
    ///         be an argument — that snapshot is what the verdict must match.
    function raiseDepositDispute(bytes32 id, bytes32 claimsRoot) external returns (uint256 disputeId) {
        Agreement storage a = _agreements[id];
        if (a.state != State.MOVE_OUT) revert BadState();
        if (a.openDisputeId != 0) revert DisputeAlreadyOpen();
        if (msg.sender != a.tenant && msg.sender != a.owner) revert NotParty();
        if (block.timestamp >= a.moveOutAt + CLAIMS_WINDOW) revert TooLate();

        // Deductions require proof, so an unproven deposit claim refunds the tenant
        // regardless of who escalated.
        disputeId = _openDispute(id, DisputeKind.DEPOSIT, a.depositPaise, 0, a.tenant, claimsRoot, a.moveOutEvidenceRoot);
        a.openDisputeId = disputeId;
    }

    function _openDispute(
        bytes32 agreementId,
        DisputeKind kind,
        uint256 poolPaise,
        uint256 rentPaymentId,
        address timeoutBeneficiary,
        bytes32 claimsRoot,
        bytes32 evidenceRoot
    ) private returns (uint256 disputeId) {
        disputeId = nextDisputeId++;
        _disputes[disputeId] = Dispute({
            agreementId: agreementId,
            kind: kind,
            poolPaise: poolPaise,
            rentPaymentId: rentPaymentId,
            openedAt: uint64(block.timestamp),
            resolveBy: uint64(block.timestamp) + DISPUTE_TIMEOUT,
            timeoutBeneficiary: timeoutBeneficiary,
            claimsRoot: claimsRoot,
            evidenceRoot: evidenceRoot,
            resolved: false
        });
        emit DisputeRaised(disputeId, agreementId, kind, poolPaise, msg.sender, claimsRoot);
    }

    /// @notice Execute a signed verdict. Permissionless submission: the oracle
    ///         signs, anyone may pay the gas, and the payload lands in calldata
    ///         where it stays auditable forever.
    function submitVerdict(Verdict calldata v, bytes calldata signature) external nonReentrant {
        Dispute storage d = _disputes[v.disputeId];
        if (d.poolPaise == 0 && d.openedAt == 0) revert UnknownDispute();
        if (d.resolved) revert DisputeAlreadyResolved();
        if (block.timestamp > v.deadline) revert VerdictExpired();
        if (verdictNonceUsed[v.nonce]) revert NonceUsed();

        // Invariant 1: conservation. No minting, no dust, no leakage.
        uint256 sum = v.toOwnerPaise + v.toTenantPaise;
        if (sum != d.poolPaise) revert SplitMismatch(sum, d.poolPaise);

        // Invariant 2: ruled on the evidence anchored before the dispute opened.
        if (v.evidenceRoot != d.evidenceRoot) revert EvidenceRootMismatch();

        // Invariant 3: authentic oracle signature.
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    VERDICT_TYPEHASH,
                    v.disputeId,
                    v.toOwnerPaise,
                    v.toTenantPaise,
                    v.rationaleHash,
                    v.evidenceRoot,
                    v.nonce,
                    v.deadline
                )
            )
        );
        if (ECDSA.recover(digest, signature) != oracleSigner) revert BadSigner();

        verdictNonceUsed[v.nonce] = true;
        d.resolved = true;

        _payout(d, v.toOwnerPaise, v.toTenantPaise);
        emit VerdictExecuted(v.disputeId, v.toOwnerPaise, v.toTenantPaise, v.rationaleHash);
    }

    /// @notice Liveness escape hatch. If the adjudicator never rules, the party
    ///         that was not making the claim takes the pool.
    function claimTimeout(uint256 disputeId) external nonReentrant {
        Dispute storage d = _disputes[disputeId];
        if (d.openedAt == 0) revert UnknownDispute();
        if (d.resolved) revert DisputeAlreadyResolved();
        if (block.timestamp < d.resolveBy) revert TooEarly();

        d.resolved = true;
        Agreement storage a = _agreements[d.agreementId];

        uint256 toOwner = d.timeoutBeneficiary == a.owner ? d.poolPaise : 0;
        uint256 toTenant = d.poolPaise - toOwner;
        _payout(d, toOwner, toTenant);

        emit DisputeTimedOut(disputeId, d.timeoutBeneficiary, d.poolPaise);
    }

    function _payout(Dispute storage d, uint256 toOwner, uint256 toTenant) private {
        Agreement storage a = _agreements[d.agreementId];

        if (d.kind == DisputeKind.DEPOSIT) {
            a.depositPaise = 0;
            a.openDisputeId = 0;
            a.state = State.SETTLED;
        } else {
            RentPayment storage p = _rentPayments[d.rentPaymentId];
            p.released = true;
        }

        if (toOwner > 0) token.safeTransfer(a.owner, toOwner);
        if (toTenant > 0) token.safeTransfer(a.tenant, toTenant);
    }

    // ---------------------------------------------------------------------
    // Admin & views
    // ---------------------------------------------------------------------

    function setOracleSigner(address next) external {
        if (msg.sender != admin) revert NotAdmin();
        if (next == address(0)) revert ZeroAddress();
        emit OracleSignerChanged(oracleSigner, next);
        oracleSigner = next;
    }

    function getAgreement(bytes32 id) external view returns (Agreement memory) {
        return _agreements[id];
    }

    function getDispute(uint256 disputeId) external view returns (Dispute memory) {
        return _disputes[disputeId];
    }

    function getRentPayment(uint256 paymentId) external view returns (RentPayment memory) {
        return _rentPayments[paymentId];
    }

    function expectedDeposit(bytes32 id) external view returns (uint256) {
        return _expectedDeposit[id];
    }

    /// @dev Exposed so the off-chain signer can assert it is building the digest
    ///      against the same domain the contract will verify with.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
