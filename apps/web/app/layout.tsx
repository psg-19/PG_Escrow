import type { Metadata } from "next";
import Link from "next/link";
import { api } from "@/lib/api";
import { UserMenu } from "@/components/UserMenu";
import "./globals.css";

export const metadata: Metadata = {
  title: "PG Escrow",
  description:
    "Rent a PG where the deposit sits in escrow and disputes are settled on the evidence, not on whoever is holding the money.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [me, chain] = await Promise.all([api.me(), api.chain()]);

  return (
    <html lang="en">
      <body>
        <header className="top">
          <div className="inner">
            <Link href="/" className="brand">
              PG<span>Escrow</span>
            </Link>
            <nav className="top-nav">
              <Link href="/">Find a PG</Link>
              {me && <Link href="/me">{me.role === "OWNER" ? "My properties" : "My tenancy"}</Link>}
              {me && <Link href="/wallet">Wallet</Link>}
              <Link href="/audit">Audit</Link>
              <Link href="/rubric">Rules</Link>
            </nav>
            <div className="spacer" />
            <UserMenu user={me} />
          </div>
        </header>

        {chain && !chain.chainUp && (
          <div className="banner">
            No chain is running. Start one with <code>npm run chain</code>, then{" "}
            <code>npm run deploy</code>. Browsing works; anything that moves money will fail.
          </div>
        )}
        {chain?.chainUp && !chain.deployed && (
          <div className="banner">
            The chain is up but no contracts are deployed. Run <code>npm run deploy</code>.
          </div>
        )}

        <div className="shell">{children}</div>
      </body>
    </html>
  );
}
