"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { post } from "@/lib/actions";

export interface ClaimableItem {
  id: string;
  label: string;
  ceilingDisplay: string;
  atEndOfLife: boolean;
}

/**
 * The owner files deductions.
 *
 * The per-item ceiling is shown before anything is typed, on purpose. An owner
 * who can see that an item yields nothing mostly does not claim on it, which
 * stops a bad claim at the source rather than arguing about it afterwards.
 */
export function ClaimFiler({
  agreementId,
  items,
}: {
  agreementId: string;
  items: ClaimableItem[];
}) {
  const router = useRouter();
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filled = Object.entries(texts).filter(([, v]) => v.trim().length > 0);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/agreements/${agreementId}/claims`, {
        claims: filled.map(([itemId, claimText]) => ({ itemId, claimText })),
      });
      setTexts({});
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {items.map((item) => (
        <div className="claim-row" key={item.id}>
          <div className="claim-head">
            <strong>{item.label}</strong>
            {item.atEndOfLife ? (
              <span className="pill neutral">past end of life — nothing claimable</span>
            ) : (
              <span className="pill warn">up to {item.ceilingDisplay}</span>
            )}
          </div>
          <textarea
            className="input"
            rows={2}
            placeholder={
              item.atEndOfLife
                ? "This item is fully depreciated. A claim here cannot recover anything."
                : "Describe what is damaged and what it will take to put right."
            }
            value={texts[item.id] ?? ""}
            onChange={(e) => setTexts((t) => ({ ...t, [item.id]: e.target.value }))}
          />
        </div>
      ))}

      <div className="note">
        Your wording is sealed behind a hash until the tenant has replied, so
        neither of you gets to write second and answer the other.
      </div>

      <button className="btn primary" disabled={busy || filled.length === 0} onClick={submit}>
        {busy ? "Filing…" : `File ${filled.length || ""} claim${filled.length === 1 ? "" : "s"}`}
      </button>
      {error && <div className="action-error block">{error}</div>}
    </div>
  );
}

/** The tenant's side of the sealed exchange. */
export function RebuttalForm({
  claimId,
  itemLabel,
}: {
  claimId: string;
  itemLabel: string;
}) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/claims/${claimId}/rebuttal`, { rebuttalText: text });
      setText("");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="claim-row">
      <div className="claim-head">
        <strong>{itemLabel}</strong>
        <span className="pill neutral">their claim is sealed</span>
      </div>
      <textarea
        className="input"
        rows={2}
        placeholder="Say what you know about this item. You cannot read their claim yet, and they cannot read this."
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button className="btn ghost sm" disabled={busy || !text.trim()} onClick={submit}>
        {busy ? "Sending…" : "Send response"}
      </button>
      {error && <div className="action-error block">{error}</div>}
    </div>
  );
}
