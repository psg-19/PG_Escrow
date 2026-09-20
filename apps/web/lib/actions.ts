"use client";

/**
 * Relative, so every browser call is same-origin and the session cookie is
 * actually sent and stored. next.config.mjs proxies /api/* to the API server.
 */
const BASE = "";

export class ApiError extends Error {}

/** Client-side write. Authenticated by the session cookie. */
export async function post<T = unknown>(
  path: string,
  body: Record<string, unknown> = {}
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // The session cookie is what identifies the caller; the API refuses
    // anything without it.
    credentials: "include",
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }

  if (!res.ok) {
    const message =
      (parsed as { error?: string } | null)?.error ?? text ?? `Request failed (${res.status})`;
    throw new ApiError(message);
  }
  return parsed as T;
}

/** Reads a chosen file as a data URL for upload. */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read that file"));
    reader.readAsDataURL(file);
  });
}
