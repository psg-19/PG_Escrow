"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { post } from "@/lib/actions";

/** Tenant asks for a room. */
export function RequestRoom({
  roomId,
  disabled,
}: {
  roomId: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/rooms/${roomId}/requests`, { message });
      setOpen(false);
      setMessage("");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (disabled) return <span className="pill neutral">not available</span>;

  if (!open) {
    return (
      <button className="btn primary sm" onClick={() => setOpen(true)}>
        Request this room
      </button>
    );
  }

  return (
    <div className="inline-form">
      <textarea
        className="input"
        rows={2}
        placeholder="Tell the owner a little about yourself and when you'd move in."
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      <div className="btn-row">
        <button className="btn primary sm" disabled={busy} onClick={submit}>
          {busy ? "Sending…" : "Send request"}
        </button>
        <button className="btn ghost sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error && <div className="action-error block">{error}</div>}
    </div>
  );
}

interface DraftItem {
  category: string;
  label: string;
  ageMonths: number;
  replacementCostRupees: number;
  conditionAtMoveIn: string;
  photoSlots: string[];
}

const CATEGORIES = [
  "WALL",
  "MATTRESS",
  "GEYSER",
  "AC",
  "DOOR",
  "WINDOW",
  "FURNITURE",
  "BATHROOM_FITTING",
  "FLOORING",
];

const STARTER: DraftItem[] = [
  { category: "WALL", label: "Bedroom wall", ageMonths: 6, replacementCostRupees: 12000, conditionAtMoveIn: "NEW", photoSlots: ["wide"] },
  { category: "MATTRESS", label: "Single mattress", ageMonths: 12, replacementCostRupees: 10000, conditionAtMoveIn: "GOOD", photoSlots: ["top"] },
];

/**
 * Create a listing, with the room's inventory declared up front.
 *
 * The inventory is the part that matters later: it is what gets photographed at
 * both ends of the tenancy and what any deduction is measured against. Declaring
 * an item's real age and condition here is what caps what can be charged for it
 * — an owner overstating condition is bounded by the depreciation schedule
 * anyway, and understating it only lowers their own ceiling.
 */
export function NewListingForm() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [locality, setLocality] = useState("");
  const [city, setCity] = useState("Bengaluru");
  const [description, setDescription] = useState("");
  const [amenities, setAmenities] = useState<string[]>(["WiFi", "Meals"]);
  const [roomLabel, setRoomLabel] = useState("Room 1");
  const [rent, setRent] = useState(15000);
  const [deposit, setDeposit] = useState(45000);
  const [items, setItems] = useState<DraftItem[]>(STARTER);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const AMENITIES = ["WiFi", "Meals", "Laundry", "AC", "Parking", "Housekeeping", "Power backup"];

  function updateItem(i: number, patch: Partial<DraftItem>) {
    setItems((list) => list.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ id: string }>("/api/listings", {
          title,
          locality,
          city,
          description,
          amenities,
          rooms: [
            {
              label: roomLabel,
              occupancy: "SINGLE",
              rentRupees: rent,
              depositRupees: deposit,
              inventory: items,
            },
          ],
      });
      router.push(`/listings/${res.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const valid = title.trim() && locality.trim() && rent > 0 && deposit > 0;

  return (
    <div>
      <h2>The property</h2>
      <div className="card">
        <label className="field">
          <span>Name</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sunshine PG" />
        </label>
        <div className="field-row">
          <label className="field">
            <span>Locality</span>
            <input className="input" value={locality} onChange={(e) => setLocality(e.target.value)} placeholder="Koramangala" />
          </label>
          <label className="field">
            <span>City</span>
            <input className="input" value={city} onChange={(e) => setCity(e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>Description</span>
          <textarea className="input" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's it like to live there?" />
        </label>
        <div className="field">
          <span>Amenities</span>
          <div className="chips">
            {AMENITIES.map((a) => (
              <button
                key={a}
                className={`chip ${amenities.includes(a) ? "on" : ""}`}
                onClick={() =>
                  setAmenities((list) => (list.includes(a) ? list.filter((x) => x !== a) : [...list, a]))
                }
              >
                {a}
              </button>
            ))}
          </div>
        </div>
      </div>

      <h2>The room</h2>
      <div className="card">
        <div className="field-row">
          <label className="field">
            <span>Label</span>
            <input className="input" value={roomLabel} onChange={(e) => setRoomLabel(e.target.value)} />
          </label>
          <label className="field">
            <span>Rent (₹ / month)</span>
            <input className="input" type="number" value={rent} onChange={(e) => setRent(Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Deposit (₹)</span>
            <input className="input" type="number" value={deposit} onChange={(e) => setDeposit(Number(e.target.value))} />
          </label>
        </div>
      </div>

      <h2>Inventory</h2>
      <p className="lede">
        Each item gets photographed at move-in and move-out, and any deduction is
        measured against it. Its age and condition here set the ceiling on what can
        ever be charged for it.
      </p>
      <div className="card">
        {items.map((item, i) => (
          <div className="claim-row" key={i}>
            <div className="field-row">
              <label className="field">
                <span>Item</span>
                <input className="input" value={item.label} onChange={(e) => updateItem(i, { label: e.target.value })} />
              </label>
              <label className="field">
                <span>Category</span>
                <select className="input" value={item.category} onChange={(e) => updateItem(i, { category: e.target.value })}>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="field-row">
              <label className="field">
                <span>Age (months)</span>
                <input className="input" type="number" value={item.ageMonths} onChange={(e) => updateItem(i, { ageMonths: Number(e.target.value) })} />
              </label>
              <label className="field">
                <span>Replacement (₹)</span>
                <input className="input" type="number" value={item.replacementCostRupees} onChange={(e) => updateItem(i, { replacementCostRupees: Number(e.target.value) })} />
              </label>
              <label className="field">
                <span>Condition</span>
                <select className="input" value={item.conditionAtMoveIn} onChange={(e) => updateItem(i, { conditionAtMoveIn: e.target.value })}>
                  {["NEW", "GOOD", "FAIR", "WORN"].map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <button className="btn ghost sm" onClick={() => setItems((l) => l.filter((_, idx) => idx !== i))}>
                Remove
              </button>
            </div>
          </div>
        ))}
        <button
          className="btn ghost sm"
          onClick={() =>
            setItems((l) => [
              ...l,
              { category: "FURNITURE", label: "", ageMonths: 0, replacementCostRupees: 5000, conditionAtMoveIn: "GOOD", photoSlots: ["wide"] },
            ])
          }
        >
          Add item
        </button>
      </div>

      <div className="btn-row" style={{ marginTop: 20 }}>
        <button className="btn primary" disabled={busy || !valid} onClick={submit}>
          {busy ? "Publishing…" : "Publish listing"}
        </button>
      </div>
      {error && <div className="action-error block">{error}</div>}
    </div>
  );
}
