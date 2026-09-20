"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { post } from "@/lib/actions";

type Status = "idle" | "running" | "done" | "failed";

interface StatusBody {
  status: Status;
  step?: string;
  error?: string;
  verdictId?: string;
  toOwner?: string;
  toTenant?: string;
}

/**
 * Starts adjudication and polls until it finishes.
 *
 * The panel makes several model calls and on a rate-limited key that takes a
 * minute or more — far longer than a browser will hold a request open. Waiting
 * on the response is what made a successful adjudication look like a server
 * error, so the request only ever starts the job and progress comes from
 * polling.
 */
export function Adjudicate({ disputeId }: { disputeId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [step, setStep] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Pick up a run already in flight, e.g. after a page refresh.
  useEffect(() => {
    void check(false);
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopPolling() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }

  async function check(startTicking: boolean) {
    try {
      const res = await fetch(`/api/disputes/${disputeId}/status`, {
        credentials: "include",
        cache: "no-store",
      });
      const body = (await res.json()) as StatusBody;

      setStatus(body.status);
      if (body.step) setStep(body.step);

      if (body.status === "running" && !timer.current) startPolling();
      if (body.status === "done") {
        stopPolling();
        router.refresh();
      }
      if (body.status === "failed") {
        stopPolling();
        setError(body.error ?? "Adjudication failed");
      }
      if (startTicking && body.status === "running") startPolling();
    } catch {
      // A dropped poll is not a failure; the next tick will pick it up.
    }
  }

  function startPolling() {
    stopPolling();
    const startedAt = Date.now();
    timer.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
      void check(false);
    }, 2000);
  }

  async function run() {
    setError(null);
    setStatus("running");
    setStep("Starting");
    try {
      await post(`/api/disputes/${disputeId}/adjudicate`);
      startPolling();
    } catch (err) {
      setStatus("failed");
      setError((err as Error).message);
    }
  }

  if (status === "running") {
    return (
      <div className="adjudicating">
        <div className="spinner" aria-hidden />
        <div>
          <div className="adj-step">{step || "Working"}…</div>
          <div className="adj-note">
            Three panelists read the photographs for every claim. On a free API
            key the calls are spaced out to stay inside the rate limit, so this
            takes a minute or two. You can leave this page — it keeps running.
            {elapsed > 5 && ` (${elapsed}s)`}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <button className="btn primary" onClick={run}>
        Run the adjudicator
      </button>
      {error && (
        <div className="action-error block">
          {error}
          <button className="btn ghost sm" style={{ marginLeft: 10 }} onClick={run}>
            Try again
          </button>
        </div>
      )}
    </>
  );
}
