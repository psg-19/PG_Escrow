import Link from "next/link";
import { notFound } from "next/navigation";
import { api } from "@/lib/api";
import { RequestRoom } from "@/components/Forms";

const STATUS_TONE: Record<string, string> = {
  VACANT: "allow",
  RESERVED: "warn",
  OCCUPIED: "neutral",
};

export default async function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [listing, me, requests] = await Promise.all([
    api.listing(id),
    api.me(),
    api.requests(),
  ]);
  if (!listing) notFound();

  const isOwner = me?.walletAddress.toLowerCase() === listing.ownerAddress.toLowerCase();
  const myRequests = requests ?? [];

  return (
    <main>
      <Link href="/" className="back">
        &larr; All properties
      </Link>
      <h1>{listing.title}</h1>
      <p className="lede">
        {listing.locality}, {listing.city} &middot; {listing.ownerName}
        {isOwner && <span className="pill neutral" style={{ marginLeft: 8 }}>yours</span>}
      </p>

      {listing.description && <div className="card">{listing.description}</div>}

      <div className="chips readonly" style={{ marginBottom: 20 }}>
        {listing.amenities.map((a) => (
          <span className="chip" key={a}>
            {a}
          </span>
        ))}
        <span className="chip">{listing.noticeDays}-day notice</span>
      </div>

      <h2>Rooms</h2>
      {listing.rooms.map((room) => {
        const mine = myRequests.find((q) => q.roomId === room.id);
        return (
          <div className="card" key={room.id}>
            <div className="row" style={{ marginBottom: 10 }}>
              <div>
                <h3>{room.label}</h3>
                <div style={{ fontSize: 13.5, color: "var(--text-dim)" }}>
                  {room.occupancy.toLowerCase()} occupancy &middot; {room.inventoryCount} inventory
                  items recorded
                </div>
              </div>
              <span className={`pill ${STATUS_TONE[room.status]}`}>{room.status}</span>
            </div>

            <div className="stats compact">
              <div className="stat">
                <div className="label">Rent</div>
                <div className="value sm">{room.rentDisplay}</div>
              </div>
              <div className="stat">
                <div className="label">Deposit (held in escrow)</div>
                <div className="value sm">{room.depositDisplay}</div>
              </div>
            </div>

            <div style={{ marginTop: 14 }}>
              {isOwner ? (
                room.pendingRequests > 0 ? (
                  <Link href="/me" className="btn ghost sm">
                    {room.pendingRequests} request{room.pendingRequests === 1 ? "" : "s"} waiting
                  </Link>
                ) : (
                  <span style={{ fontSize: 13.5, color: "var(--text-faint)" }}>
                    No requests yet.
                  </span>
                )
              ) : mine ? (
                <span className={`pill ${mine.status === "PENDING" ? "warn" : "neutral"}`}>
                  your request: {mine.status.toLowerCase()}
                </span>
              ) : me?.role === "TENANT" ? (
                <RequestRoom roomId={room.id} disabled={room.status !== "VACANT"} />
              ) : me ? (
                <span style={{ fontSize: 13.5, color: "var(--text-faint)" }}>
                  You are signed in as an owner.
                </span>
              ) : (
                <Link href="/signup" className="btn primary sm">
                  Sign up to request this room
                </Link>
              )}
            </div>
          </div>
        );
      })}

      <h2>What happens when you move in</h2>
      <div className="card">
        <ol className="steps">
          <li>
            <strong>The owner accepts your request.</strong> An agreement is created on-chain with
            the rent, deposit and notice period fixed.
          </li>
          <li>
            <strong>You fund the escrow.</strong> Deposit plus the first month&rsquo;s rent go to
            the contract — not to the owner.
          </li>
          <li>
            <strong>You both photograph the room.</strong> Every inventory item, the same slots.
            Nothing is anchored until you have both signed off on the same set.
          </li>
          <li>
            <strong>Rent runs monthly.</strong> Each payment is held 48 hours before it reaches the
            owner, which gives you a window to raise a habitability complaint.
          </li>
          <li>
            <strong>At move-out you photograph the same slots again.</strong> If the owner claims
            deductions and you disagree, it goes to the adjudicator.
          </li>
        </ol>
      </div>
    </main>
  );
}
