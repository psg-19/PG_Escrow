import Link from "next/link";
import { api } from "@/lib/api";
import { Tilt } from "@/components/Tilt";
export default async function Home() {
  const [listings, me] = await Promise.all([api.listings(), api.me()]);

  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Deposits held in escrow</span>
          <h1>
            Your deposit stops being
            <br />
            <em>their</em> money.
          </h1>
          <p className="lede">
            Same rooms, same rent. The difference is that ₹45,000 goes into a
            contract neither of you can raid, and if you disagree at move-out it
            is settled on the photographs rather than on who happens to be
            holding the cash.
          </p>
          {!me && (
            <div className="btn-row" style={{ marginTop: 18 }}>
              <Link href="/signup" className="btn primary">
                Get started
              </Link>
              <Link href="/rubric" className="btn ghost">
                Read the rules
              </Link>
            </div>
          )}
        </div>

        <Tilt className="hero-art" max={9}>
          <div className="deposit-card">
            <div className="dc-label">Held in escrow</div>
            <div className="dc-amount">₹45,000</div>
            <div className="dc-split">
              <span className="dc-party">
                <i className="dc-dot tenant" /> Tenant
              </span>
              <span className="dc-party">
                <i className="dc-dot owner" /> Owner
              </span>
            </div>
            <div className="dc-bar">
              <div className="dc-seg tenant" />
              <div className="dc-seg owner" />
            </div>
            <div className="dc-foot">Neither side can move it alone</div>
          </div>
        </Tilt>
      </section>

      {listings === null && (
        <div className="card">
          <h3>The API is not reachable</h3>
          <p className="lede" style={{ marginTop: 6 }}>
            Start it with <code className="mono">npm run app</code>.
          </p>
        </div>
      )}

      {listings?.length === 0 && (
        <div className="card empty">
          <p style={{ margin: "0 0 14px" }}>No properties listed yet.</p>
          {me?.role === "OWNER" ? (
            <Link href="/owner/new" className="btn primary">
              List your property
            </Link>
          ) : me ? (
            <span>Nothing here yet. Check back once owners start listing.</span>
          ) : (
            <Link href="/signup" className="btn primary">
              Sign up to list a property
            </Link>
          )}
        </div>
      )}

      {listings && listings.length > 0 && (
        <div className="listing-grid">
          {listings.map((l) => (
            <Tilt key={l.id} max={5}>
              <Link href={`/listings/${l.id}`} className="listing card-link">
              <div className="listing-body">
                <div className="row">
                  <h3>{l.title}</h3>
                  {l.vacantCount > 0 ? (
                    <span className="pill allow">
                      {l.vacantCount} vacant
                    </span>
                  ) : (
                    <span className="pill neutral">full</span>
                  )}
                </div>
                <div className="listing-where">
                  {l.locality}, {l.city}
                </div>
                <div className="chips readonly">
                  {l.amenities.slice(0, 4).map((a) => (
                    <span className="chip" key={a}>
                      {a}
                    </span>
                  ))}
                </div>
                <div className="listing-foot">
                  <span>
                    {l.fromDisplay ? (
                      <>
                        from <strong>{l.fromDisplay}</strong>/mo
                      </>
                    ) : (
                      "no rooms available"
                    )}
                  </span>
                  <span className="listing-owner">{l.ownerName}</span>
                </div>
              </div>
              </Link>
            </Tilt>
          ))}
        </div>
      )}

      {me?.role === "OWNER" && listings && listings.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <Link href="/owner/new" className="btn ghost">
            List another property
          </Link>
        </div>
      )}

      <h2>Why the deposit sits in escrow</h2>
      <div className="card">
        <p style={{ margin: "0 0 12px" }}>
          Normally the owner holds your deposit <em>and</em> decides what to take
          out of it. One side controls the money and judges the outcome, and
          ₹45,000 is far too small to be worth suing over — so unfair deductions
          just get absorbed.
        </p>
        <p style={{ margin: 0, color: "var(--text-dim)" }}>
          Here the contract holds it. Both of you photograph the room at move-in
          and again at move-out, and those photos are hashed and locked before
          anyone knows there will be an argument. If you disagree, an adjudicator
          rules on them and publishes its reasoning — you can read every verdict
          it has ever issued on the <Link href="/audit" style={{ color: "var(--accent)" }}>audit page</Link>.
        </p>
      </div>
    </main>
  );
}
