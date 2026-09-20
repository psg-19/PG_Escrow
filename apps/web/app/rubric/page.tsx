import { api } from "@/lib/api";

const CATEGORY_LABEL: Record<string, string> = {
  WALL: "Wall / paint",
  MATTRESS: "Mattress",
  GEYSER: "Geyser",
  AC: "Air conditioner",
  DOOR: "Door",
  WINDOW: "Window",
  FURNITURE: "Furniture",
  BATHROOM_FITTING: "Bathroom fitting",
  FLOORING: "Flooring",
};

export default async function RubricPage() {
  const r = await api.rubric();

  if (!r) {
    return (
      <main>
        <h1>Rules</h1>
        <div className="card empty">
          The API is not reachable. Start it with <code className="mono">npm run api</code>.
        </div>
      </main>
    );
  }

  return (
    <main>
      <h1>Rules</h1>
      <p className="lede">
        The standard every claim is judged against, published in full and versioned. Both parties
        can read it before they file anything, and every verdict records which version decided it.
      </p>

      <h2>Depreciation schedule &mdash; {r.depreciationScheduleVersion}</h2>
      <p className="lede">
        Straight-line over each category&rsquo;s useful life. An item at or past the end of its life
        yields a ceiling of zero: its replacement was already due, so the tenant is not funding it.
      </p>
      <div className="card flush">
        <table>
          <thead>
            <tr>
              <th>Category</th>
              <th className="num">Useful life</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(r.usefulLifeMonths).map(([cat, months]) => (
              <tr key={cat}>
                <td>{CATEGORY_LABEL[cat] ?? cat}</td>
                <td className="num">
                  {months} months
                  <span style={{ color: "var(--text-faint)" }}> ({(months / 12).toFixed(0)}y)</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Severity caps</h2>
      <p className="lede">
        What share of an item&rsquo;s remaining value each severity can justify. This bound applies
        independently of the adjudicator&rsquo;s recommendation &mdash; a scuff cannot bill a whole
        wall however the claim is worded.
      </p>
      <div className="card flush">
        <table>
          <thead>
            <tr>
              <th>Severity</th>
              <th className="num">Maximum</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(r.severityCap).map(([sev, cap]) => (
              <tr key={sev}>
                <td style={{ textTransform: "capitalize" }}>{sev}</td>
                <td className="num">{Math.round(cap * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Condition at move-in</h2>
      <p className="lede">
        An item the tenant received already worn carries less recoverable value. They did not get a
        pristine item and cannot be billed as though they had.
      </p>
      <div className="card flush">
        <table>
          <thead>
            <tr>
              <th>Condition recorded</th>
              <th className="num">Value multiplier</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(r.conditionMultiplier).map(([cond, mult]) => (
              <tr key={cond}>
                <td>{cond}</td>
                <td className="num">{Math.round(mult * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Adjudication rubric &mdash; {r.rubricVersion}</h2>
      <p className="lede">
        The complete instructions given to every panelist. Adjudication is{" "}
        {r.models.adjudication}; party statements are screened first by {r.models.screening}.
      </p>
      <pre className="doc">{r.rubric}</pre>
    </main>
  );
}
