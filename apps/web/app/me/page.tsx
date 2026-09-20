import Link from "next/link";
import { api } from "@/lib/api";
import { redirect } from "next/navigation";
import { Action } from "@/components/Action";

const STATE_TONE: Record<string, string> = {
  DRAFT: "warn",
  FUNDED: "warn",
  ACTIVE: "allow",
  NOTICE: "warn",
  MOVE_OUT: "warn",
  SETTLED: "neutral",
};

interface NextStep {
  /** What is happening, phrased for the person reading it. */
  text: string;
  /** The button, when this person is the one who has to act. */
  cta: string | null;
  /** True when nothing moves until they do something. */
  urgent: boolean;
}

/**
 * What this person does next.
 *
 * Deliberately asymmetric: at almost every stage exactly one side is holding
 * things up, and telling both of them the same neutral status is how someone
 * ends up staring at a dashboard wondering whose turn it is.
 */
function nextStep(state: string, isOwner: boolean): NextStep {
  switch (state) {
    case "DRAFT":
      return isOwner
        ? { text: "Waiting for the tenant to pay the deposit", cta: null, urgent: false }
        : { text: "Your deposit is due — the room is held until you pay", cta: "Pay the deposit", urgent: true };
    case "FUNDED":
      return { text: "Photograph the room — you both have to sign off on the same set", cta: "Add photos", urgent: true };
    case "ACTIVE":
      return { text: "Tenancy running", cta: "Open", urgent: false };
    case "NOTICE":
      return { text: "Notice given — photograph the same things again", cta: "Add photos", urgent: true };
    case "MOVE_OUT":
      return isOwner
        ? { text: "Claim any deductions, or settle up", cta: "Settle up", urgent: true }
        : { text: "Respond to any claims against your deposit", cta: "Open", urgent: true };
    case "SETTLED":
      return { text: "Closed", cta: "See settlement", urgent: false };
    default:
      return { text: state, cta: "Open", urgent: false };
  }
}

export default async function MePage() {
  const me = await api.me();
  if (!me) redirect("/login");

  const [requests, agreements, listings] = await Promise.all([
    api.requests(),
    api.agreements(),
    api.listings(),
  ]);

  const isOwner = me.role === "OWNER";
  const myListings = (listings ?? []).filter((l) => l.isMine);
  const pending = (requests ?? []).filter((q) => q.status === "PENDING");

  // Surfaced at the top, so nobody has to open each tenancy to find out whether
  // it is their move.
  const waiting = (agreements ?? [])
    .map((agreement) => ({ agreement, step: nextStep(agreement.state, isOwner) }))
    .filter(({ step }) => step.urgent && step.cta);

  return (
    <main>
      <h1>{isOwner ? "My properties" : "My tenancy"}</h1>
      <p className="lede">
        Signed in as {me.name}.{" "}
        {me.balanceDisplay && <>Escrow balance {me.balanceDisplay}.</>}
      </p>

      {waiting.length > 0 && (
        <div className="todo">
          <div className="todo-title">
            {waiting.length === 1 ? "One thing needs you" : `${waiting.length} things need you`}
          </div>
          {waiting.map(({ agreement, step }) => (
            <div className="todo-row" key={agreement.id}>
              <span>
                <strong>{agreement.propertyLabel}</strong> — {step.text}
              </span>
              <Link href={`/tenancy/${agreement.id}`} className="btn primary sm">
                {step.cta}
              </Link>
            </div>
          ))}
        </div>
      )}

      {isOwner && (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            <h2 style={{ margin: 0 }}>Listings</h2>
            <Link href="/owner/new" className="btn primary sm">
              List a property
            </Link>
          </div>
          {myListings.length === 0 ? (
            <div className="card empty">
              Nothing listed yet. <Link href="/owner/new" style={{ color: "var(--accent)" }}>Add your first property.</Link>
            </div>
          ) : (
            <div className="card flush list">
              {myListings.map((l) => (
                <Link key={l.id} href={`/listings/${l.id}`} className="list-item card-link">
                  <div className="row">
                    <div>
                      <h3>{l.title}</h3>
                      <div style={{ fontSize: 13.5, color: "var(--text-dim)" }}>
                        {l.locality} &middot; {l.roomCount} room{l.roomCount === 1 ? "" : "s"},{" "}
                        {l.vacantCount} vacant
                      </div>
                    </div>
                    <span style={{ fontSize: 13, color: "var(--text-dim)" }}>
                      {l.fromDisplay ?? "—"}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </>
      )}

      <h2>{isOwner ? "Requests to move in" : "My requests"}</h2>
      {(requests ?? []).length === 0 ? (
        <div className="card empty">
          {isOwner
            ? "No one has asked for a room yet."
            : "You haven't requested a room yet."}
        </div>
      ) : (
        <div className="card flush list">
          {(requests ?? []).map((q) => (
            <div className="list-item" key={q.id}>
              <div className="row" style={{ marginBottom: 8 }}>
                <div>
                  <h3>
                    {q.roomLabel} &middot; {q.listingTitle}
                  </h3>
                  <div style={{ fontSize: 13.5, color: "var(--text-dim)" }}>
                    {isOwner ? q.tenantName : `${q.rentDisplay}/mo · deposit ${q.depositDisplay}`}
                  </div>
                </div>
                <span className={`pill ${q.status === "PENDING" ? "warn" : q.status === "ACCEPTED" ? "allow" : "neutral"}`}>
                  {q.status.toLowerCase()}
                </span>
              </div>

              {q.message && <div className="quote">{q.message}</div>}

              <div className="btn-row" style={{ marginTop: 10 }}>
                {isOwner && q.status === "PENDING" && (
                  <>
                    <Action path={`/api/requests/${q.id}/accept`}>
                      Accept &amp; create agreement
                    </Action>
                    <Action path={`/api/requests/${q.id}/decline`} variant="ghost">
                      Decline
                    </Action>
                  </>
                )}
                {q.agreementId && (
                  <Link href={`/tenancy/${q.agreementId}`} className="btn ghost sm">
                    Open tenancy
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <h2>Tenancies</h2>
      {(agreements ?? []).length === 0 ? (
        <div className="card empty">
          {isOwner
            ? "No tenancies yet. Accept a request to start one."
            : pending.length > 0
              ? "Waiting for an owner to accept."
              : "Nothing yet. Find a room and request it."}
        </div>
      ) : (
        <div className="card flush list">
          {(agreements ?? []).map((a) => {
            const step = nextStep(a.state, isOwner);
            return (
              <div className="list-item" key={a.id}>
                <div className="row" style={{ marginBottom: 10 }}>
                  <div>
                    <h3>{a.propertyLabel}</h3>
                    <div style={{ fontSize: 13.5, color: "var(--text-dim)" }}>
                      {isOwner ? a.tenantName : a.ownerName} &middot; deposit {a.depositDisplay}
                    </div>
                  </div>
                  <span className={`pill ${STATE_TONE[a.state] ?? "neutral"}`}>{a.state}</span>
                </div>

                <div className="row next-step">
                  <span className={step.urgent ? "next-text urgent" : "next-text"}>
                    {step.urgent && <span className="dot" aria-hidden />}
                    {step.text}
                  </span>
                  <Link
                    href={`/tenancy/${a.id}`}
                    className={`btn sm ${step.urgent && step.cta ? "primary" : "ghost"}`}
                  >
                    {step.cta ?? "Open"}
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </main>
  );
}
