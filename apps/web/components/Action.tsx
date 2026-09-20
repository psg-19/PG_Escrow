"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { post } from "@/lib/actions";

/**
 * A button that performs one write and refreshes the page.
 *
 * Errors are shown rather than swallowed. Most failures here are the contract
 * refusing something — a rent hold that has not expired, a state the agreement
 * is not in — and that refusal is the most useful thing to put in front of
 * someone, so it goes on screen verbatim.
 */
export function Action({
  path,
  body,
  children,
  variant = "primary",
  confirm,
  pending: pendingLabel,
  onDone,
}: {
  path: string;
  body?: Record<string, unknown>;
  children: ReactNode;
  variant?: "primary" | "ghost" | "danger";
  confirm?: string;
  pending?: string;
  onDone?: (result: unknown) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    setError(null);
    try {
      const result = await post(path, body ?? {});
      onDone?.(result);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="action-wrap">
      <button className={`btn ${variant}`} onClick={run} disabled={busy}>
        {busy ? (pendingLabel ?? "Working…") : children}
      </button>
      {error && <span className="action-error">{error}</span>}
    </span>
  );
}
