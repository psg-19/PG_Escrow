import { loadEnv } from "./env.js";

// Evaluated before the entrypoint imports modules that initialize chain clients.
export const env = loadEnv();
