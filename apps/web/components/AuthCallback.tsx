"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { post } from "@/lib/actions";
import { supabase, PENDING_ROLE_KEY } from "@/lib/supabase";

type Phase = "verifying" | "needs-role" | "error";

/**
 * Lands here after Google.
 *
 * Reads the Supabase session out of the URL fragment, hands the access token to
 * our API, and gets one of our own sessions back. If this identity is brand new
 * and no role survived the redirect, it asks — Google never tells us which side
 * of the market someone is on, and guessing would put a tenant in an owner's
 * dashboard.
 */
export function AuthCallback() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("verifying");
  const [error, setError] = useState<string | null>(null);
  const [who, setWho] = useState<{ email: string; name: string } | null>(null);
  const token = useRef<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    // React 18 strict mode mounts twice; exchanging the same code twice fails.
    if (ran.current) return;
    ran.current = true;

    (async () => {
      try {
        const client = supabase();
        if (!client) throw new Error("Google sign-in is not configured");

        // Supabase returns the session one of two ways depending on the
        // project's flow: PKCE puts a `code` in the query string, implicit
        // leaves the tokens in the URL fragment. Handle both rather than
        // assuming, since the flow is a dashboard setting we do not control.
        let accessToken: string | null = null;

        const code = new URLSearchParams(window.location.search).get("code");
        if (code) {
          const ex = await client.auth.exchangeCodeForSession(code);
          if (ex.error) throw ex.error;
          accessToken = ex.data.session?.access_token ?? null;
        } else {
          const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
          const fragmentError = fragment.get("error_description") ?? fragment.get("error");
          if (fragmentError) throw new Error(fragmentError);
          accessToken = fragment.get("access_token");
        }

        if (!accessToken) {
          const queryError = new URLSearchParams(window.location.search).get("error_description");
          throw new Error(queryError ?? "Google did not return a session");
        }

        token.current = accessToken;

        let role: string | null = null;
        try {
          role = sessionStorage.getItem(PENDING_ROLE_KEY);
        } catch {
          /* storage blocked */
        }

        const res = await post<{
          needsRole?: boolean;
          email?: string;
          name?: string;
          user?: { role: "OWNER" | "TENANT" };
        }>("/api/auth/google", { accessToken, role: role ?? undefined });

        if (res.needsRole) {
          setWho({ email: res.email ?? "", name: res.name ?? "" });
          setPhase("needs-role");
          return;
        }

        try {
          sessionStorage.removeItem(PENDING_ROLE_KEY);
        } catch {
          /* ignore */
        }
        router.replace(res.user?.role === "OWNER" ? "/me" : "/");
        router.refresh();
      } catch (e) {
        setError((e as Error).message);
        setPhase("error");
      }
    })();
  }, [router]);

  async function pickRole(role: "OWNER" | "TENANT") {
    setPhase("verifying");
    try {
      const res = await post<{ user?: { role: string } }>("/api/auth/google", {
        accessToken: token.current,
        role,
      });
      router.replace(res.user?.role === "OWNER" ? "/owner/new" : "/");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setPhase("error");
    }
  }

  if (phase === "verifying") {
    return (
      <div className="auth-card center">
        <div className="spinner" aria-hidden />
        <p className="lede" style={{ marginTop: 14 }}>
          Signing you in…
        </p>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="auth-card">
        <h1>That didn&rsquo;t work</h1>
        <div className="action-error block">{error}</div>
        <p className="auth-alt">
          <a href="/login">Back to sign in</a>
        </p>
      </div>
    );
  }

  return (
    <div className="auth-card">
      <h1>One last thing</h1>
      <p className="lede">
        {who?.name ? `Welcome, ${who.name}. ` : ""}
        Which side are you on? This fixes what your account can do, so pick the
        one you actually need.
      </p>

      <div className="role-picker" style={{ marginTop: 18 }}>
        <button className="role" onClick={() => pickRole("TENANT")}>
          <span className="role-title">Looking for a PG</span>
          <span className="role-sub">
            Browse rooms, pay the deposit into escrow, get it back fairly
          </span>
        </button>
        <button className="role" onClick={() => pickRole("OWNER")}>
          <span className="role-title">Listing a PG</span>
          <span className="role-sub">
            Publish rooms, accept tenants, claim genuine damage
          </span>
        </button>
      </div>
    </div>
  );
}
