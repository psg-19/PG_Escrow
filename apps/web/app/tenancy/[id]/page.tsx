import Link from "next/link";
import { notFound } from "next/navigation";
import { api, type AgreementDetail } from "@/lib/api";
import { Action } from "@/components/Action";
import { EvidenceCapture, type SlotState } from "@/components/EvidenceCapture";
import { ClaimFiler, RebuttalForm } from "@/components/ClaimForms";
import { Adjudicate } from "@/components/Adjudicate";

const STAGE_ORDER = ["DRAFT", "FUNDED", "ACTIVE", "NOTICE", "MOVE_OUT", "SETTLED"];

/**
 * Rent as a timeline rather than a button.
 *
 * Shows what each payment bought and when the next one opens, because "Pay
 * rent" with no dates attached invites paying twice for the same month.
 */
function RentTimeline({ agreement }: { agreement: AgreementDetail }) {
  const { ledger, rentCycle } = agreement;
  const paid = ledger.filter((l) => l.paidAt);

  return (
    <div className="rent-timeline">
      {paid.map((l) => (
        <div className="rent-cycle done" key={l.cycleIndex}>
          <div className="rc-head">
            <strong>Cycle {l.cycleIndex}</strong>
            <span className="pill allow">paid</span>
          </div>
          <div className="rc-range">
            {when(l.paidAt)} &rarr; {when(l.coversUntil)}
          </div>
          <div className="rc-amount">{l.amountDisplay}</div>
          <div className="rc-bar">
            <span style={{ width: "100%" }} />
          </div>
        </div>
      ))}

      <div className={`rent-cycle next ${rentCycle.payable ? "open" : ""}`}>
        <div className="rc-head">
          <strong>Cycle {rentCycle.index}</strong>
          <span className={`pill ${rentCycle.payable ? "warn" : "neutral"}`}>
            {rentCycle.payable ? "due now" : `in ${rentCycle.daysUntilDue}d`}
          </span>
        </div>
        <div className="rc-range">
          {when(rentCycle.dueAt)} &rarr; {when(rentCycle.coversUntil)}
        </div>
        <div className="rc-amount">{agreement.rentDisplay}</div>
        <div className="rc-bar">
          <span
            className="pending"
            style={{
              width: `${Math.max(
                4,
                Math.round(
                  ((rentCycle.cycleDays - rentCycle.daysUntilDue) / rentCycle.cycleDays) * 100
                )
              )}%`,
            }}
          />
        </div>
      </div>
    </div>
  );
}

function when(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default async function TenancyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [a, me, verdicts] = await Promise.all([api.agreement(id), api.me(), api.verdicts()]);
  if (!a) notFound();

  const myAddress = me?.walletAddress.toLowerCase() ?? "";
  const isTenant = myAddress === a.tenantAddress.toLowerCase();
  const isOwner = myAddress === a.ownerAddress.toLowerCase();
  const isParty = isTenant || isOwner;

  const stageIndex = STAGE_ORDER.indexOf(a.state);
  const verdict = a.dispute ? verdicts?.find((v) => v.disputeId === a.dispute!.id) : undefined;

  // One capture card per inventory slot, at whichever stage is current.
  const slots: SlotState[] = a.items.flatMap((item) =>
    item.photoSlots.map((slot) => ({
      itemId: item.id,
      itemLabel: item.label,
      slot,
      moveInPhotoId:
        a.photos.find((p) => p.itemId === item.id && p.slot === slot && p.stage === "MOVE_IN")?.id ??
        null,
      moveOutPhotoId:
        a.photos.find((p) => p.itemId === item.id && p.slot === slot && p.stage === "MOVE_OUT")
          ?.id ?? null,
    }))
  );

  const moveInDone = slots.every((s) => s.moveInPhotoId);
  const moveOutDone = slots.every((s) => s.moveOutPhotoId);
  const claimedItemIds = new Set(a.claims.map((c) => c.itemId));
  const unclaimedItems = a.items.filter((i) => !claimedItemIds.has(i.id));
  const awaitingRebuttal = a.claims.filter((c) => !c.hasRebuttal);

  return (
    <main>
      <Link href="/me" className="back">
        &larr; Back
      </Link>
      <h1>{a.propertyLabel}</h1>
      <p className="lede">
        {a.tenantName} &middot; owner {a.ownerName}
        {!isParty && (
          <span className="pill neutral" style={{ marginLeft: 8 }}>
            viewing as an outsider
          </span>
        )}
      </p>

      <div className="stats">
        <div className="stat">
          <div className="label">In escrow</div>
          <div className="value">{a.state === "SETTLED" ? "—" : a.depositDisplay}</div>
        </div>
        <div className="stat">
          <div className="label">Rent</div>
          <div className="value sm">{a.rentDisplay}/mo</div>
        </div>
        <div className="stat">
          <div className="label">Stage</div>
          <div className="value sm">{a.state}</div>
        </div>
        <div className="stat">
          <div className="label">Months occupied</div>
          <div className="value sm">{a.occupiedMonths}</div>
        </div>
      </div>

      <ol className="progress">
        {STAGE_ORDER.map((s, i) => (
          <li key={s} className={i < stageIndex ? "done" : i === stageIndex ? "now" : ""}>
            {s.replace("_", " ").toLowerCase()}
          </li>
        ))}
      </ol>

      {/* ------------------------------------------------------------ actions */}

      {isParty && a.state !== "SETTLED" && (
        <>
          <h2>What happens next</h2>

          {a.state === "DRAFT" && (
            <div className="card">
              {isTenant ? (
                <>
                  <h3>Fund the escrow</h3>
                  <p className="lede">
                    {a.depositDisplay} deposit plus {a.rentDisplay} first month. It goes to the
                    contract, not to {a.ownerName} — neither of you can move it alone.
                  </p>
                  <Action
                    path={`/api/agreements/${a.id}/fund`}
                    pending="Funding…"
                  >
                    Pay into escrow
                  </Action>
                </>
              ) : (
                <p style={{ margin: 0 }}>
                  Waiting for {a.tenantName} to fund the escrow.
                </p>
              )}
            </div>
          )}

          {a.state === "FUNDED" && (
            <div className="card">
              <h3>Photograph the room</h3>
              <p className="lede">
                This is the baseline every later claim gets compared against. You both have to
                attest to the same set before it counts, so neither of you sets it alone.
              </p>
              <EvidenceCapture
                agreementId={a.id}
                stage="MOVE_IN"
                slots={slots}
              />
              <div className="btn-row" style={{ marginTop: 16 }}>
                <Action
                  path={`/api/agreements/${a.id}/attest`}
                  body={{ stage: "MOVE_IN" }}
                  pending="Signing…"
                >
                  {moveInDone ? "Attest to this set" : "Attest anyway"}
                </Action>
                {!moveInDone && (
                  <span style={{ fontSize: 13, color: "var(--text-faint)" }}>
                    {slots.filter((s) => !s.moveInPhotoId).length} slot(s) still empty
                  </span>
                )}
              </div>
            </div>
          )}

          {a.state === "ACTIVE" && (
            <div className="card">
              <h3>Tenancy is running</h3>
              <div className="btn-row">
                {isTenant &&
                  (a.rentCycle.payable ? (
                    <Action path={`/api/agreements/${a.id}/pay-rent`} pending="Paying…">
                      Pay rent for cycle {a.rentCycle.index}
                    </Action>
                  ) : (
                    <span className="paid-up">
                      <span className="pill allow">paid up</span>
                      {a.rentCycle.reason}
                    </span>
                  ))}
                <Action
                  path={`/api/agreements/${a.id}/release-rent`}
                  variant="ghost"
                  pending="Releasing…"
                >
                  Release held rent to owner
                </Action>
                <Action
                  path={`/api/agreements/${a.id}/notice`}
                  variant="ghost"
                  confirm="Give notice and start the move-out process?"
                >
                  Give notice
                </Action>
              </div>
              <RentTimeline agreement={a} />

              <div className="note">
                Each rent payment is held for 48 hours before it reaches the owner. That window is
                the tenant&rsquo;s leverage on things like a broken geyser.
              </div>
            </div>
          )}

          {a.state === "NOTICE" && (
            <div className="card">
              <h3>Photograph the room again</h3>
              <p className="lede">
                Same slots as move-in. The baseline is shown beside each one — line the shot up with
                it, or the comparison later is guesswork and the system will reject it.
              </p>
              <EvidenceCapture
                agreementId={a.id}
                stage="MOVE_OUT"
                slots={slots}
              />
              <div className="btn-row" style={{ marginTop: 16 }}>
                <Action
                  path={`/api/agreements/${a.id}/attest`}
                  body={{ stage: "MOVE_OUT" }}
                  pending="Signing…"
                >
                  {moveOutDone ? "Attest to this set" : "Attest anyway"}
                </Action>
              </div>
            </div>
          )}

          {a.state === "MOVE_OUT" && !a.dispute && (
            <>
              {isOwner && unclaimedItems.length > 0 && (
                <div className="card">
                  <h3>Claim any deductions</h3>
                  <p className="lede">
                    Only if something is actually damaged. Each item&rsquo;s ceiling is already
                    fixed by its age and condition — you cannot recover more than that however the
                    claim is worded.
                  </p>
                  <ClaimFiler
                    agreementId={a.id}
                    items={unclaimedItems.map((i) => ({
                      id: i.id,
                      label: i.label,
                      ceilingDisplay: i.ceilingDisplay,
                      atEndOfLife: i.atEndOfLife,
                    }))}
                  />
                </div>
              )}

              {isTenant && awaitingRebuttal.length > 0 && (
                <div className="card">
                  <h3>{a.ownerName} has claimed deductions</h3>
                  <p className="lede">
                    Their wording stays sealed until you have replied, so neither of you can answer
                    the other&rsquo;s story. Say what you know about each item.
                  </p>
                  {awaitingRebuttal.map((c) => (
                    <RebuttalForm
                      key={c.id}
                      claimId={c.id}
                      itemLabel={a.items.find((i) => i.id === c.itemId)?.label ?? c.itemId}
                    />
                  ))}
                </div>
              )}

              <div className="card">
                <h3>{a.claims.length > 0 ? "Settle the deposit" : "No deductions claimed"}</h3>
                <p className="lede">
                  {a.claims.length > 0
                    ? "Send it to the adjudicator. Three panelists read the photographs, and the contract checks the arithmetic before any money moves."
                    : "If nobody claims anything, the whole deposit goes back to the tenant."}
                </p>
                <div className="btn-row">
                  {a.claims.length > 0 && (
                    <Action
                      path={`/api/agreements/${a.id}/dispute`}
                      pending="Opening…"
                    >
                      Send to adjudication
                    </Action>
                  )}
                </div>
              </div>
            </>
          )}

          {a.dispute && !a.dispute.resolvedAt && (
            <div className="card">
              <h3>Ready to adjudicate</h3>
              <p className="lede">
                Claims and responses are both in. Running the panel reveals them, rules on each
                claim, signs the verdict and executes it on-chain.
              </p>
              <Adjudicate disputeId={a.dispute.id} />
            </div>
          )}
        </>
      )}

      {/* ------------------------------------------------------------ outcome */}

      {verdict && (
        <>
          <h2>Settled</h2>
          <Link href={`/audit/${verdict.id}`} className="card card-link" style={{ display: "block" }}>
            <div className="row" style={{ marginBottom: 10 }}>
              <div>
                <h3>Deposit settlement</h3>
                <div style={{ fontSize: 13.5, color: "var(--text-dim)" }}>
                  {verdict.adjudicationModel} &middot; rubric {verdict.rubricVersion}
                </div>
              </div>
              <div style={{ textAlign: "right", fontSize: 13.5 }}>
                <div>
                  owner <strong>{verdict.toOwnerDisplay}</strong>
                </div>
                <div>
                  tenant <strong>{verdict.toTenantDisplay}</strong>
                </div>
              </div>
            </div>
            <span style={{ fontSize: 13, color: "var(--accent)" }}>
              Read the panel&rsquo;s reasoning &rarr;
            </span>
          </Link>
        </>
      )}

      {/* ----------------------------------------------------------- inventory */}

      <h2>Inventory and ceilings</h2>
      <div className="card flush">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>At move-in</th>
              <th className="num">Replacement</th>
              <th className="num">Max deductible</th>
            </tr>
          </thead>
          <tbody>
            {a.items.map((item) => (
              <tr key={item.id}>
                <td>
                  <div style={{ fontWeight: 550 }}>{item.label}</div>
                  <div style={{ fontSize: 12.5, color: "var(--text-faint)" }}>
                    {item.category} &middot; {item.ageMonths + a.occupiedMonths} months old at
                    move-out
                  </div>
                </td>
                <td>{item.conditionAtMoveIn}</td>
                <td className="num">{item.replacementCostDisplay}</td>
                <td className="num">
                  {item.atEndOfLife ? (
                    <span className="pill neutral">past end of life</span>
                  ) : (
                    <strong>{item.ceilingDisplay}</strong>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ------------------------------------------------------------ evidence */}

      <h2>Evidence</h2>
      <div className="card">
        <div style={{ marginBottom: 12 }}>
          <div className="field-label">MOVE-IN ROOT</div>
          <div className="hash">{a.moveInRoot ?? "not anchored yet"}</div>
        </div>
        <div>
          <div className="field-label">MOVE-OUT ROOT</div>
          <div className="hash">{a.moveOutRoot ?? "not anchored yet"}</div>
        </div>
        <div className="note">
          Each root is the hash of the whole photo set, written on-chain only once both parties
          attest to the same value. The move-out root is fixed before any dispute exists, so
          neither side can swap in a better photograph once they see how it is going.
        </div>
        <div style={{ fontSize: 13.5, color: "var(--text-dim)" }}>
          {a.photos.filter((p) => p.stage === "MOVE_IN").length} move-in &middot;{" "}
          {a.photos.filter((p) => p.stage === "MOVE_OUT").length} move-out
        </div>
      </div>

      {a.ledger.length > 0 && (
        <>
          <h2>Rent</h2>
          <div className="card flush">
            <table>
              <thead>
                <tr>
                  <th>Cycle</th>
                  <th>Paid</th>
                  <th>Released to owner</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {a.ledger.map((l) => (
                  <tr key={l.cycleIndex}>
                    <td>#{l.cycleIndex}</td>
                    <td>{when(l.paidAt)}</td>
                    <td>
                      {l.releasedAt ? (
                        when(l.releasedAt)
                      ) : (
                        <span className="pill warn">held in escrow</span>
                      )}
                    </td>
                    <td className="num">{l.amountDisplay}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {isParty && a.state !== "SETTLED" && (
        <div className="devbar">
          A tenancy takes months and this demo takes minutes, so the 48-hour rent hold and 72-hour
          claims window need skipping.
          <Action
            path="/api/dev/advance-time"
            body={{ days: 3 }}
            variant="ghost"
          >
            Skip 3 days
          </Action>
        </div>
      )}
    </main>
  );
}
