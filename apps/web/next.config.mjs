import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Next loads `.env` from its own directory, but this is a monorepo and the one
 * that matters lives at the repo root. Without this the Supabase values are
 * undefined here, the Google button never renders, and nothing says why.
 */
const rootEnv = resolve(process.cwd(), "../../.env");
if (existsSync(rootEnv)) {
  try {
    process.loadEnvFile(rootEnv);
  } catch {
    // Malformed .env should not stop the build.
  }
}

const API_URL = process.env.API_URL ?? "http://127.0.0.1:4000";

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,

  /**
   * Supabase's URL and anon key are public by design — they identify the
   * project and are rate-limited server side. Surfaced here so the browser
   * bundle can start the Google redirect. Anything secret stays in the API.
   */
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.SUPABASE_URL ?? "",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY ?? "",
  },

  /**
   * Proxy the API through this origin.
   *
   * Session auth is a cookie, and cookies are scoped by host. Serving pages
   * from `localhost:3000` while the browser posts to `127.0.0.1:4000` means the
   * cookie is stored against a different host than the one rendering the pages,
   * so the session is invisible to every server component — and SameSite=Lax
   * stops the browser sending it on that cross-site request anyway.
   *
   * Routing browser calls through here makes them same-origin, which fixes both
   * halves. Server components still call the API directly and forward the
   * cookie by hand; they are not subject to any of this.
   */
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/api/:path*` }];
  },
};
