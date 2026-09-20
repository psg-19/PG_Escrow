"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { post, fileToDataUrl } from "@/lib/actions";

/** Same-origin via the rewrite in next.config.mjs. */
const API = "";

export interface SlotState {
  itemId: string;
  itemLabel: string;
  slot: string;
  moveInPhotoId: string | null;
  moveOutPhotoId: string | null;
}

/**
 * Photograph one inventory slot.
 *
 * At move-out the move-in shot is shown alongside as a reference, because a
 * before/after pair only means anything if the two frames actually line up. The
 * API enforces that too and will reject a shot framed from somewhere else, so
 * this is a prompt rather than the guarantee.
 *
 * A real capture screen would overlay the baseline at low opacity inside a live
 * camera view. This is a file picker with the baseline beside it — the same
 * discipline, without the camera work.
 */
export function EvidenceCapture({
  agreementId,
  stage,
  slots,
}: {
  agreementId: string;
  stage: "MOVE_IN" | "MOVE_OUT";
  slots: SlotState[];
}) {
  const router = useRouter();
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  async function upload(slot: SlotState, file: File) {
    const key = `${slot.itemId}:${slot.slot}`;
    setBusySlot(key);
    setErrors((e) => ({ ...e, [key]: "" }));
    try {
      const dataUrl = await fileToDataUrl(file);
      await post(`/api/agreements/${agreementId}/photos`, {
        itemId: slot.itemId,
        slot: slot.slot,
        stage,
        dataUrl,
      });
      router.refresh();
    } catch (err) {
      setErrors((e) => ({ ...e, [key]: (err as Error).message }));
    } finally {
      setBusySlot(null);
    }
  }

  return (
    <div className="capture-grid">
      {slots.map((slot) => {
        const key = `${slot.itemId}:${slot.slot}`;
        const taken = stage === "MOVE_IN" ? slot.moveInPhotoId : slot.moveOutPhotoId;
        const busy = busySlot === key;

        return (
          <div className={`capture ${taken ? "done" : ""}`} key={key}>
            <div className="capture-head">
              <div>
                <div className="capture-item">{slot.itemLabel}</div>
                <div className="capture-slot">{slot.slot}</div>
              </div>
              {taken && <span className="pill allow">captured</span>}
            </div>

            <div className="capture-frames">
              {stage === "MOVE_OUT" && (
                <figure className="frame">
                  <figcaption>Move-in baseline</figcaption>
                  {slot.moveInPhotoId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`${API}/api/photos/${slot.moveInPhotoId}/file`} alt="" />
                  ) : (
                    <div className="frame-empty">none</div>
                  )}
                </figure>
              )}
              <figure className="frame">
                <figcaption>{stage === "MOVE_IN" ? "Baseline" : "Now"}</figcaption>
                {taken ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`${API}/api/photos/${taken}/file`} alt="" />
                ) : (
                  <div className="frame-empty">not captured</div>
                )}
              </figure>
            </div>

            <input
              ref={(el) => {
                inputs.current[key] = el;
              }}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              capture="environment"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(slot, file);
                e.target.value = "";
              }}
            />
            <button
              className="btn ghost sm"
              disabled={busy}
              onClick={() => inputs.current[key]?.click()}
            >
              {busy ? "Uploading…" : taken ? "Replace" : "Take photo"}
            </button>
            {errors[key] && <div className="action-error block">{errors[key]}</div>}
          </div>
        );
      })}
    </div>
  );
}
