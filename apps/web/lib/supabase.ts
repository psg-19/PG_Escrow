"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase client, created lazily.
 *
 * Only used to run the Google redirect dance and hand back an access token —
 * the app's own session is what everything else authorises against. Returns
 * null when unconfigured so the sign-in pages can simply not render the button
 * rather than crashing on a missing URL.
 */
let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  client ??= createClient(url, key, {
    auth: {
      // The session is exchanged for ours immediately and never reused, so
      // there is nothing worth persisting or refreshing.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return client;
}

export function googleEnabled(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

/** Survives the redirect to Google and back, so we know which side they picked. */
export const PENDING_ROLE_KEY = "pg_pending_role";
