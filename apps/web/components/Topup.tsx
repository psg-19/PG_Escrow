"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { post } from "@/lib/actions";
import { Tilt } from "@/components/Tilt";

interface Quote {
  amountRupees: number;
  amountDisplay: string;
  creditsDisplay: string;
  upiUri: string;
  qrSvg: string;
  payeeVpa: string;
  isMock: boolean;
  notice: string;
  presets: number[];
}

/**
 * Wallet top-up.
 *
 * The QR is generated for real and scans like any other UPI request, but the
 * payee handle does not exist so no UPI app will accept it — see topup.ts. The
 * page says that plainly rather than burying it, because a payment screen that
 * looks live and is not is the kind of thing someone tries for real.
 */
export function Topup({ balanceDisplay }: { balanceDisplay: string | null }) {
  const router = useRouter();
  const [amount, setAmount] = useState(15_000);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/topup/quote?amount=${amount}`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Could not build a QR"))))
      .then((q: Quote) => {
        if (!cancelled) setQuote(q);
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [amount]);

  async function simulate() {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ creditedDisplay: string; balanceDisplay: string }>(
        "/api/topup/simulate",
        { amountRupees: amount }
      );
      setDone(`${r.creditedDisplay} credited. Balance is now ${r.balanceDisplay}.`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const presets = quote?.presets ?? [5_000, 15_000, 45_000, 100_000];

  return (
    <div className="topup">
      <div className="mock-banner">
        <strong>Not live yet.</strong> This QR cannot take a payment — the payee
        handle is deliberately one that no UPI app will accept. Real settlement
        is still to come.
      </div>

      <div className="topup-grid">
        <Tilt max={4}>
        <div className="card tilt">
          <div className="field">
            <span>Amount</span>
            <div className="chips">
              {presets.map((p) => (
                <button
                  key={p}
                  className={`chip ${amount === p ? "on" : ""}`}
                  onClick={() => setAmount(p)}
                >
                  ₹{p.toLocaleString("en-IN")}
                </button>
              ))}
            </div>
          </div>

          <label className="field">
            <span>Or enter your own</span>
            <input
              className="input"
              type="number"
              min={100}
              max={500000}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
          </label>

          <div className="topup-summary">
            <div className="row">
              <span>You would pay</span>
              <strong>{quote?.amountDisplay ?? "—"}</strong>
            </div>
            <div className="row">
              <span>Wallet credited</span>
              <strong className="credit">{quote?.creditsDisplay ?? "—"}</strong>
            </div>
            <div className="row muted">
              <span>Current balance</span>
              <span>{balanceDisplay ?? "—"}</span>
            </div>
          </div>

          <button className="btn primary wide" disabled={busy} onClick={simulate}>
            {busy ? "Crediting…" : "Simulate a successful payment"}
          </button>
          <p className="hint" style={{ marginTop: 8 }}>
            Skips the payment entirely and credits the demo currency, so you can
            keep going if you run out mid-tenancy.
          </p>

          {done && <div className="topup-done">{done}</div>}
          {error && <div className="action-error block">{error}</div>}
        </div>
        </Tilt>

        <Tilt max={6}>
        <div className="card qr-card tilt">
          <div className="qr-frame">
            {loading && <div className="qr-skeleton" />}
            {!loading && quote && (
              <div
                className="qr"
                aria-label="UPI QR code (non-functional demo)"
                dangerouslySetInnerHTML={{ __html: quote.qrSvg }}
              />
            )}
            <div className="qr-stamp">DEMO</div>
          </div>

          <div className="qr-meta">
            <div className="field-label">Payee</div>
            <div className="mono">{quote?.payeeVpa ?? "—"}</div>
            <p className="hint" style={{ marginTop: 10 }}>
              {quote?.notice}
            </p>
          </div>
        </div>
        </Tilt>
      </div>

      <div className="card">
        <h3>How this is meant to work</h3>
        <ol className="steps" style={{ marginTop: 10 }}>
          <li>
            <strong>You scan and pay in rupees.</strong> Ordinary UPI, from any
            bank app.
          </li>
          <li>
            <strong>We confirm the settlement.</strong> A webhook from the
            payment provider, matched against the amount and reference.
          </li>
          <li>
            <strong>Your wallet is credited one-for-one.</strong> No spread, no
            fee — the balance is what funds deposits and rent on the escrow
            contract.
          </li>
          <li>
            <strong>Withdrawals run in reverse.</strong> A returned deposit goes
            back out to the bank account you paid from.
          </li>
        </ol>
        <div className="note caution">
          Steps 2 and 4 need a licensed payment partner and a settlement account.
          Until that exists, the balance here is demo currency on a local chain
          and is not redeemable for anything.
        </div>
      </div>
    </div>
  );
}
