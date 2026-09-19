import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Money is stored as TEXT, holding a decimal paise count.
 *
 * SQLite's INTEGER is 64-bit and would fit, but Drizzle hands those back as JS
 * numbers, and a number is exactly the thing this codebase refuses to let near
 * money. Text round-trips through BigInt losslessly and keeps the discipline
 * unbroken from the database to the contract.
 */
const paise = (name: string) => text(name).notNull();

export const agreements = sqliteTable(
  "agreements",
  {
    id: text("id").primaryKey(),
    /** bytes32 used on-chain; the same value the backend row is keyed by. */
    chainId: text("chain_id").notNull(),
    tenantAddress: text("tenant_address").notNull(),
    ownerAddress: text("owner_address").notNull(),
    tenantName: text("tenant_name").notNull(),
    ownerName: text("owner_name").notNull(),
    propertyLabel: text("property_label").notNull(),
    roomId: text("room_id"),

    rentPaise: paise("rent_paise"),
    depositPaise: paise("deposit_paise"),
    noticeDays: integer("notice_days").notNull(),
    lateFeeRateBps: integer("late_fee_rate_bps").notNull(),

    state: text("state", {
      enum: ["DRAFT", "FUNDED", "ACTIVE", "NOTICE", "MOVE_OUT", "SETTLED"],
    })
      .notNull()
      .default("DRAFT"),

    moveInRoot: text("move_in_root"),
    moveOutRoot: text("move_out_root"),

    startAt: integer("start_at", { mode: "timestamp" }),
    noticeGivenAt: integer("notice_given_at", { mode: "timestamp" }),
    moveOutAt: integer("move_out_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    tenantIdx: index("agreements_tenant_idx").on(t.tenantAddress),
    ownerIdx: index("agreements_owner_idx").on(t.ownerAddress),
  })
);

export const inventoryItems = sqliteTable(
  "inventory_items",
  {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id").notNull(),
    category: text("category").notNull(),
    label: text("label").notNull(),
    ageMonths: integer("age_months").notNull(),
    replacementCostPaise: paise("replacement_cost_paise"),
    conditionAtMoveIn: text("condition_at_move_in").notNull(),
    /** JSON array of slot names. */
    photoSlots: text("photo_slots").notNull(),
  },
  (t) => ({ agreementIdx: index("items_agreement_idx").on(t.agreementId) })
);

export const ledgerEntries = sqliteTable(
  "ledger_entries",
  {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id").notNull(),
    cycleIndex: integer("cycle_index").notNull(),
    dueAt: integer("due_at", { mode: "timestamp" }).notNull(),
    amountPaise: paise("amount_paise"),
    paidAt: integer("paid_at", { mode: "timestamp" }),
    /** On-chain rent payment id, once funded. */
    chainPaymentId: text("chain_payment_id"),
    releasedAt: integer("released_at", { mode: "timestamp" }),
  },
  (t) => ({ agreementIdx: index("ledger_agreement_idx").on(t.agreementId) })
);

export const photos = sqliteTable(
  "photos",
  {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id").notNull(),
    itemId: text("item_id").notNull(),
    slot: text("slot").notNull(),
    stage: text("stage", { enum: ["MOVE_IN", "MOVE_OUT"] }).notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    mediaType: text("media_type").notNull(),
    /** Server clock. Device timestamps are not trusted. */
    capturedAt: integer("captured_at", { mode: "timestamp" }).notNull(),
    capturedBy: text("captured_by").notNull(),
    /** JSON CapturePose. */
    pose: text("pose").notNull(),
  },
  (t) => ({
    agreementIdx: index("photos_agreement_idx").on(t.agreementId),
    slotIdx: index("photos_slot_idx").on(t.itemId, t.slot, t.stage),
  })
);

export const claims = sqliteTable(
  "claims",
  {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id").notNull(),
    itemId: text("item_id").notNull(),
    /** Untrusted party text. Null until the commit-reveal window opens. */
    claimText: text("claim_text"),
    commitment: text("commitment").notNull(),
    salt: text("salt"),
    committedAt: integer("committed_at", { mode: "timestamp" }).notNull(),
    revealedAt: integer("revealed_at", { mode: "timestamp" }),
  },
  (t) => ({ agreementIdx: index("claims_agreement_idx").on(t.agreementId) })
);

export const rebuttals = sqliteTable("rebuttals", {
  id: text("id").primaryKey(),
  claimId: text("claim_id").notNull(),
  rebuttalText: text("rebuttal_text"),
  commitment: text("commitment").notNull(),
  salt: text("salt"),
  committedAt: integer("committed_at", { mode: "timestamp" }).notNull(),
  revealedAt: integer("revealed_at", { mode: "timestamp" }),
});

export const disputes = sqliteTable(
  "disputes",
  {
    id: text("id").primaryKey(),
    agreementId: text("agreement_id").notNull(),
    /** uint256 from the contract, as a decimal string. */
    chainDisputeId: text("chain_dispute_id"),
    kind: text("kind", { enum: ["DEPOSIT", "RENT"] }).notNull(),
    poolPaise: paise("pool_paise"),
    claimsRoot: text("claims_root").notNull(),
    evidenceRoot: text("evidence_root").notNull(),
    raisedBy: text("raised_by").notNull(),
    openedAt: integer("opened_at", { mode: "timestamp" }).notNull(),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  },
  (t) => ({ agreementIdx: index("disputes_agreement_idx").on(t.agreementId) })
);

/**
 * The permanent record of an adjudication.
 *
 * Kept in full — every panelist's raw output, the prompt and rubric versions,
 * the evidence root, the rendered document and its hash, and the transaction
 * that executed it. A verdict nobody can inspect afterwards is not
 * accountable, and this system asks people to trust an autonomous decision.
 */
export const verdicts = sqliteTable(
  "verdicts",
  {
    id: text("id").primaryKey(),
    disputeId: text("dispute_id").notNull(),
    toOwnerPaise: paise("to_owner_paise"),
    toTenantPaise: paise("to_tenant_paise"),
    rationale: text("rationale").notNull(),
    rationaleHash: text("rationale_hash").notNull(),
    evidenceRoot: text("evidence_root").notNull(),
    /** JSON AuditRecord: panels, screens, model ids, versions. */
    auditJson: text("audit_json").notNull(),
    adjudicationModel: text("adjudication_model").notNull(),
    rubricVersion: text("rubric_version").notNull(),
    depreciationScheduleVersion: text("depreciation_schedule_version").notNull(),
    signature: text("signature"),
    nonce: text("nonce"),
    txHash: text("tx_hash"),
    decidedAt: integer("decided_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({ disputeIdx: index("verdicts_dispute_idx").on(t.disputeId) })
);

/**
 * A real account.
 *
 * ## The wallet is custodial, and that is a demo compromise
 *
 * Signing up generates an Ethereum key that the server stores and signs with,
 * so a tenant can fund a deposit without installing a wallet extension. It
 * means the server *can* move a tenant's deposit by itself, which a real
 * deployment must not allow — there the user holds the key and signs in their
 * own browser. The column is named to make that impossible to forget.
 */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    role: text("role", { enum: ["OWNER", "TENANT"] }).notNull(),
    /**
     * scrypt hash; never the password itself.
     *
     * Null for accounts created through Google — there is no password to hash,
     * and storing a placeholder would let someone sign in with it.
     */
    passwordHash: text("password_hash"),
    passwordSalt: text("password_salt"),
    /** Supabase user id, for accounts that arrived via an OAuth provider. */
    supabaseId: text("supabase_id"),
    avatarUrl: text("avatar_url"),
    walletAddress: text("wallet_address").notNull(),
    /** kms:v1: ciphertext in AWS mode; plaintext only in local development. */
    custodialPrivateKey: text("custodial_private_key").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({
    emailIdx: index("users_email_idx").on(t.email),
    walletIdx: index("users_wallet_idx").on(t.walletAddress),
    supabaseIdx: index("users_supabase_idx").on(t.supabaseId),
  })
);

/** Opaque bearer tokens. Deleting the row logs the session out everywhere. */
export const sessions = sqliteTable(
  "sessions",
  {
    token: text("token").primaryKey(),
    userId: text("user_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({ userIdx: index("sessions_user_idx").on(t.userId) })
);

/**
 * A PG a tenant can actually find and rent. Rooms are the rentable unit; the
 * inventory the adjudicator later reasons about hangs off the agreement, not
 * the listing, because it is photographed per tenancy.
 */
export const listings = sqliteTable(
  "listings",
  {
    id: text("id").primaryKey(),
    ownerAddress: text("owner_address").notNull(),
    ownerName: text("owner_name").notNull(),
    title: text("title").notNull(),
    locality: text("locality").notNull(),
    city: text("city").notNull(),
    description: text("description").notNull(),
    /** JSON array of amenity tags. */
    amenities: text("amenities").notNull(),
    genderPolicy: text("gender_policy", { enum: ["ANY", "MEN", "WOMEN"] })
      .notNull()
      .default("ANY"),
    noticeDays: integer("notice_days").notNull(),
    lateFeeRateBps: integer("late_fee_rate_bps").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({ cityIdx: index("listings_city_idx").on(t.city) })
);

export const rooms = sqliteTable(
  "rooms",
  {
    id: text("id").primaryKey(),
    listingId: text("listing_id").notNull(),
    label: text("label").notNull(),
    occupancy: text("occupancy", { enum: ["SINGLE", "DOUBLE", "TRIPLE"] }).notNull(),
    rentPaise: paise("rent_paise"),
    depositPaise: paise("deposit_paise"),
    status: text("status", { enum: ["VACANT", "RESERVED", "OCCUPIED"] })
      .notNull()
      .default("VACANT"),
    /** JSON array of inventory templates copied into an agreement on move-in. */
    inventoryTemplate: text("inventory_template").notNull(),
  },
  (t) => ({ listingIdx: index("rooms_listing_idx").on(t.listingId) })
);

/** A tenant asking for a room. The owner accepts, which creates the agreement. */
export const rentalRequests = sqliteTable(
  "rental_requests",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    tenantAddress: text("tenant_address").notNull(),
    tenantName: text("tenant_name").notNull(),
    message: text("message").notNull(),
    status: text("status", { enum: ["PENDING", "ACCEPTED", "DECLINED", "WITHDRAWN"] })
      .notNull()
      .default("PENDING"),
    agreementId: text("agreement_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    decidedAt: integer("decided_at", { mode: "timestamp" }),
  },
  (t) => ({
    roomIdx: index("requests_room_idx").on(t.roomId),
    tenantIdx: index("requests_tenant_idx").on(t.tenantAddress),
  })
);

/**
 * Where the contracts live on the chain this instance is pointed at.
 *
 * Written by the deploy step and read by the API, so the two never disagree
 * about which escrow they are talking to.
 */
export const deployments = sqliteTable("deployments", {
  id: text("id").primaryKey(),
  chainId: integer("chain_id").notNull(),
  escrowAddress: text("escrow_address").notNull(),
  tokenAddress: text("token_address").notNull(),
  oracleAddress: text("oracle_address").notNull(),
  deployedAt: integer("deployed_at", { mode: "timestamp" }).notNull(),
});

export const schema = {
  users,
  sessions,
  listings,
  rooms,
  rentalRequests,
  deployments,
  agreements,
  inventoryItems,
  ledgerEntries,
  photos,
  claims,
  rebuttals,
  disputes,
  verdicts,
};
