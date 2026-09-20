import { redirect } from "next/navigation";
import { api } from "@/lib/api";
import { Topup } from "@/components/Topup";

export default async function WalletPage() {
  const me = await api.me();
  if (!me) redirect("/login");

  return (
    <main>
      <h1>Wallet</h1>
      <p className="lede">
        Your balance is what funds deposits and rent on the escrow contract.
        Top it up over UPI.
      </p>

      <div className="stats reveal">
        <div className="stat">
          <div className="label">Balance</div>
          <div className="value">{me.balanceDisplay ?? "—"}</div>
        </div>
        <div className="stat">
          <div className="label">Account</div>
          <div className="value sm">{me.name}</div>
        </div>
        <div className="stat">
          <div className="label">Wallet</div>
          <div className="value sm mono" style={{ fontSize: 12 }}>
            {me.walletAddress.slice(0, 10)}…{me.walletAddress.slice(-8)}
          </div>
        </div>
      </div>

      <Topup balanceDisplay={me.balanceDisplay} />
    </main>
  );
}
