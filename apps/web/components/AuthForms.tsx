"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { post } from "@/lib/actions";
import { GoogleButton } from "@/components/GoogleButton";
import { googleEnabled } from "@/lib/supabase";

type Role = "OWNER" | "TENANT";

/**
 * Sign up as either side of the market.
 *
 * The role is picked here and fixed on the account, because the two sides do
 * genuinely different things — one lists property, the other pays a deposit —
 * and the API enforces that split on every write rather than trusting the UI.
 */
export function SignupForm() {
  const router = useRouter();
  const [role, setRole] = useState<Role | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!role) return;
    setBusy(true);
    setError(null);
    try {
      await post("/api/auth/signup", { name, email, password, role });
      // Signing up logs you in, so go straight where the role is useful.
      router.push(role === "OWNER" ? "/owner/new" : "/");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const valid = role && name.trim() && email.trim() && password.length >= 8;

  return (
    <div className="auth-card">
      <h1>Create an account</h1>

      <div className="field">
        <span>I am</span>
        <div className="role-picker">
          <button
            className={`role ${role === "TENANT" ? "on" : ""}`}
            onClick={() => setRole("TENANT")}
          >
            <span className="role-title">Looking for a PG</span>
            <span className="role-sub">
              Browse rooms, pay the deposit into escrow, get it back fairly
            </span>
          </button>
          <button
            className={`role ${role === "OWNER" ? "on" : ""}`}
            onClick={() => setRole("OWNER")}
          >
            <span className="role-title">Listing a PG</span>
            <span className="role-sub">
              Publish rooms, accept tenants, claim genuine damage
            </span>
          </button>
        </div>
      </div>

      <label className="field">
        <span>Name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      <label className="field">
        <span>Email</span>
        <input
          className="input"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>

      <label className="field">
        <span>Password</span>
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <span className="hint">At least 8 characters.</span>
      </label>

      <button className="btn primary wide" disabled={busy || !valid} onClick={submit}>
        {busy ? "Creating…" : "Create account"}
      </button>
      {error && <div className="action-error block">{error}</div>}

      {googleEnabled() && (
        <>
          <div className="or">or</div>
          {/* Passing the role through means Google users skip the extra step. */}
          <GoogleButton role={role ?? undefined} label="Sign up with Google" />
          {!role && (
            <p className="hint" style={{ textAlign: "center", marginTop: 8 }}>
              Pick a side above first, or we&rsquo;ll ask after Google.
            </p>
          )}
        </>
      )}

      <p className="auth-alt">
        Already have one? <Link href="/login">Sign in</Link>
      </p>

      <div className="note">
        A wallet is created for you so you can move money on the escrow contract
        without installing anything. It starts with demo currency.
      </div>
    </div>
  );
}

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ user: { role: Role } }>("/api/auth/login", { email, password });
      router.push(res.user.role === "OWNER" ? "/me" : "/");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="auth-card">
      <h1>Sign in</h1>

      <label className="field">
        <span>Email</span>
        <input
          className="input"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </label>

      <label className="field">
        <span>Password</span>
        <input
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
      </label>

      <button
        className="btn primary wide"
        disabled={busy || !email.trim() || !password}
        onClick={submit}
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
      {error && <div className="action-error block">{error}</div>}

      {googleEnabled() && (
        <>
          <div className="or">or</div>
          <GoogleButton label="Sign in with Google" />
        </>
      )}

      <p className="auth-alt">
        No account yet? <Link href="/signup">Create one</Link>
      </p>
    </div>
  );
}
