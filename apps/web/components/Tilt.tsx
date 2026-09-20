"use client";

import { useRef, type ReactNode } from "react";

/**
 * Pointer-tracking 3D tilt.
 *
 * Writes CSS custom properties on pointer move and lets CSS do the transform,
 * so the work stays on the compositor instead of forcing a React render per
 * mouse event.
 *
 * Skipped entirely for coarse pointers — a tilt that keys off hover is dead
 * weight on a phone — and CSS drops the effect under `prefers-reduced-motion`.
 */
export function Tilt({
  children,
  className = "",
  max = 7,
}: {
  children: ReactNode;
  className?: string;
  max?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  function move(e: React.PointerEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el || e.pointerType !== "mouse") return;

    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;

    el.style.setProperty("--rx", `${(-py * max).toFixed(2)}deg`);
    el.style.setProperty("--ry", `${(px * max).toFixed(2)}deg`);
    // Drives the sheen so the highlight tracks the cursor.
    el.style.setProperty("--mx", `${((px + 0.5) * 100).toFixed(1)}%`);
    el.style.setProperty("--my", `${((py + 0.5) * 100).toFixed(1)}%`);
  }

  function reset() {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--rx", "0deg");
    el.style.setProperty("--ry", "0deg");
  }

  return (
    <div
      ref={ref}
      className={`tilt-3d ${className}`}
      onPointerMove={move}
      onPointerLeave={reset}
    >
      {children}
    </div>
  );
}
