"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { post } from "@/lib/actions";
import type { CurrentUser } from "@/lib/api";

export function UserMenu({ user }: { user: CurrentUser | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!user) {
    return (
      <div className="auth-links">
        <Link href="/login" className="btn ghost sm">
          Sign in
        </Link>
        <Link href="/signup" className="btn primary sm">
          Sign up
        </Link>
      </div>
    );
  }

  async function signOut() {
    setBusy(true);
    try {
      await post("/api/auth/logout");
      setOpen(false);
      router.push("/login");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="switcher">
      <button className="switcher-trigger" onClick={() => setOpen((v) => !v)}>
        <span className="avatar" aria-hidden>
          {user.name.charAt(0).toUpperCase()}
        </span>
        <span className="switcher-name">
          {user.name}
          <span className="switcher-role">{user.role.toLowerCase()}</span>
        </span>
        <span className="chev" aria-hidden>
          {open ? "▴" : "▾"}
        </span>
      </button>

      {open && (
        <>
          <div className="switcher-scrim" onClick={() => setOpen(false)} />
          <div className="switcher-menu">
            <div className="menu-head">
              <div className="menu-name">{user.name}</div>
              <div className="menu-email">{user.email}</div>
            </div>

            <div className="menu-balance">
              <span>Escrow balance</span>
              <strong>{user.balanceDisplay ?? "—"}</strong>
            </div>
            <div className="menu-wallet" title={user.walletAddress}>
              {user.walletAddress.slice(0, 10)}…{user.walletAddress.slice(-8)}
            </div>

            <Link href="/wallet" className="switcher-item" onClick={() => setOpen(false)}>
              <span className="switcher-item-name">Top up wallet</span>
            </Link>

            <Link
              href="/me"
              className="switcher-item"
              onClick={() => setOpen(false)}
            >
              <span className="switcher-item-name">
                {user.role === "OWNER" ? "My properties" : "My tenancy"}
              </span>
            </Link>

            <button className="switcher-item" disabled={busy} onClick={signOut}>
              <span className="switcher-item-name">{busy ? "Signing out…" : "Sign out"}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
