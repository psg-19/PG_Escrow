import Link from "next/link";
import { api } from "@/lib/api";

export default async function AuditIndex() {
  const verdicts = await api.verdicts();

  return (
    <main>
      <h1>Audit</h1>
      <p className="lede">
        Every verdict this system has issued, with the reasoning that produced it. The adjudicator
        decides autonomously, so the record is open by default — a decision nobody can inspect
        afterwards is not one anyone should be asked to accept.
      </p>

      {verdicts === null && (
        <div className="card empty">
          The API is not reachable. Start it with <code className="mono">npm run api</code>.
        </div>
      )}

      {verdicts?.length === 0 && (
        <div className="card empty">
          No verdicts yet. Run <code className="mono">npm run demo</code> to produce one.
        </div>
      )}

      {verdicts && verdicts.length > 0 && (
        <div className="card flush list">
          {verdicts.map((v) => (
            <Link key={v.id} href={`/audit/${v.id}`} className="list-item card-link">
              <div className="row">
                <div>
                  <h3>Dispute {v.disputeId.replace("dispute-", "#")}</h3>
                  <div style={{ fontSize: 13, color: "var(--text-dim)" }}>
                    {v.adjudicationModel} &middot; rubric {v.rubricVersion} &middot;{" "}
                    {new Date(v.decidedAt).toLocaleDateString("en-IN", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </div>
                </div>
                <div style={{ textAlign: "right", fontSize: 13.5 }}>
                  <div>
                    owner <strong>{v.toOwnerDisplay}</strong>
                  </div>
                  <div>
                    tenant <strong>{v.toTenantDisplay}</strong>
                  </div>
                </div>
              </div>
              {v.txHash && (
                <div className="hash" style={{ marginTop: 8 }}>
                  tx {v.txHash}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}

      <h2>What gets recorded</h2>
      <div className="card">
        <p style={{ margin: "0 0 10px" }}>
          For each verdict: all three panelists&rsquo; raw assessments, the injection screens on
          both parties&rsquo; statements, the model and rubric versions, the evidence root that was
          ruled on, the rendered settlement document and its hash, the oracle signature, and the
          transaction that executed it.
        </p>
        <p style={{ margin: 0, color: "var(--text-dim)" }}>
          The rendered document is hashed and that hash goes on-chain with the split, so the
          reasoning shown here can be proved to be the reasoning the money moved on.
        </p>
      </div>
    </main>
  );
}
