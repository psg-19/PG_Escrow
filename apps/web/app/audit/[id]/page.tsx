import Link from "next/link";
import { notFound } from "next/navigation";
import { api, type PanelistOut } from "@/lib/api";

const ROLE_LABEL: Record<string, string> = {
  TENANT_ADVOCATE: "Tenant-side",
  OWNER_ADVOCATE: "Owner-side",
  NEUTRAL: "Neutral (decides)",
};

const FALLBACK_EXPLAIN: Record<string, string> = {
  "injection-in-claim":
    "The claim text tried to instruct the adjudicator. A deduction cannot be awarded on a claim that does that, so it was disallowed.",
  "advocate-disagreement":
    "The strongest honest reading for each side landed too far apart, so the evidence does not settle this claim. An unproven deduction fails.",
  "neutral-panelist-unavailable":
    "The deciding panelist returned nothing. An unassessed claim cannot be charged, so it was disallowed.",
};

function pct(n: number | undefined): string {
  return n === undefined ? "—" : `${Math.round(n * 100)}%`;
}

export default async function VerdictPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const v = await api.verdict(id);
  if (!v) notFound();

  const ownerN = Number(v.toOwnerPaise ?? 0);
  const tenantN = Number(v.toTenantPaise ?? 0);
  const total = ownerN + tenantN || 1;

  return (
    <main>
      <h1>Dispute {v.disputeId.replace("dispute-", "#")}</h1>
      <p className="lede">
        Decided by {v.adjudicationModel} under rubric {v.rubricVersion}, screened by{" "}
        {v.audit.screeningModel}, with no human in the loop.{" "}
        {v.agreementId && (
          <Link href={`/agreement/${v.agreementId}`} style={{ color: "var(--accent)" }}>
            See the tenancy &rarr;
          </Link>
        )}
      </p>

      <div className="stats">
        <div className="stat">
          <div className="label">Deposit in dispute</div>
          <div className="value">{v.poolDisplay ?? "—"}</div>
        </div>
        <div className="stat">
          <div className="label">To the owner</div>
          <div className="value">{v.toOwnerDisplay}</div>
        </div>
        <div className="stat">
          <div className="label">To the tenant</div>
          <div className="value">{v.toTenantDisplay}</div>
        </div>
      </div>

      <div className="bar" style={{ marginBottom: 6 }}>
        <div className="seg-owner" style={{ width: `${(ownerN / total) * 100}%` }} />
        <div className="seg-tenant" style={{ width: `${(tenantN / total) * 100}%` }} />
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-faint)", marginBottom: 8 }}>
        The two shares add back to the deposit exactly. The contract refuses any split that
        doesn&rsquo;t.
      </div>

      <h2>Claim by claim</h2>
      {v.audit.panels.map((panel) => {
        const screen = v.audit.screens[panel.claimId];
        const decided = panel.verdict;
        return (
          <div className="card" key={panel.claimId} style={{ marginBottom: 16 }}>
            <div className="row" style={{ marginBottom: 12 }}>
              <h3 style={{ fontFamily: "var(--mono)", fontSize: 14 }}>{panel.claimId}</h3>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {screen?.claim.suspicious && (
                  <span className="pill refuse">injection: {screen.claim.technique}</span>
                )}
                {screen?.rebuttal.suspicious && (
                  <span className="pill warn">rebuttal flagged</span>
                )}
                <span className={`pill ${panel.fallbackApplied ? "warn" : "neutral"}`}>
                  spread {panel.spread.toFixed(2)}
                </span>
                <span className={`pill ${(decided.recommendedFraction ?? 0) > 0 ? "allow" : "refuse"}`}>
                  {(decided.recommendedFraction ?? 0) > 0 ? "allowed" : "disallowed"}
                </span>
              </div>
            </div>

            <div className="panelists">
              {(["TENANT_ADVOCATE", "NEUTRAL", "OWNER_ADVOCATE"] as const).map((role) => {
                const p: PanelistOut | undefined = panel.panelists[role];
                return (
                  <div
                    key={role}
                    className={`panelist ${role === "NEUTRAL" ? "decisive" : ""}`}
                  >
                    <div className="role">{ROLE_LABEL[role]}</div>
                    {p?.error ? (
                      <div style={{ color: "var(--refuse)", fontSize: 13 }}>
                        unavailable: {p.error}
                      </div>
                    ) : (
                      <>
                        <div className="frac">{pct(p?.recommendedFraction)}</div>
                        <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
                          severity {p?.severity ?? "—"}
                          {p?.fairWearAndTear ? " · fair wear" : ""}
                          {p?.attributableToTenant === false ? " · not tenant's fault" : ""}
                        </div>
                        {p?.reasoning && <div className="why">{p.reasoning}</div>}
                      </>
                    )}
                  </div>
                );
              })}
            </div>

            {panel.fallbackApplied && (
              <div className="note caution">
                <strong>Fallback: {panel.fallbackApplied}</strong>
                <br />
                {FALLBACK_EXPLAIN[panel.fallbackApplied] ??
                  "A fallback rule overrode the deciding panelist."}
              </div>
            )}

            {/* With no fallback the decided verdict is the neutral panelist, whose
                reasoning is already shown in its card — repeating it adds nothing. */}
          </div>
        );
      })}

      <h2>The settlement the parties received</h2>
      <pre className="doc">{v.rationale}</pre>

      <h2>Proof</h2>
      <div className="card">
        <p style={{ margin: "0 0 14px", color: "var(--text-dim)" }}>
          The contract checked all three of these before moving anything: the split equals the pool
          exactly, the evidence root matches what was anchored before the dispute opened, and the
          signature recovers to the registered oracle.
        </p>
        <Field label="Evidence root" value={v.evidenceRoot} />
        <Field label="Rationale hash (sha256 of the document above)" value={v.rationaleHash} />
        <Field label="Oracle signature" value={v.signature ?? "—"} />
        <Field label="Verdict nonce" value={v.nonce ?? "—"} />
        <Field label="Transaction" value={v.txHash ?? "—"} />
        <Field
          label="Depreciation schedule"
          value={`${v.depreciationScheduleVersion} — see /rubric`}
        />
      </div>
    </main>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11.5, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-faint)" }}>
        {label}
      </div>
      <div className="hash">{value}</div>
    </div>
  );
}
