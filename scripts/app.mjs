#!/usr/bin/env node
/**
 * Runs the API and the web app together, and shuts both down cleanly.
 *
 * Each child gets its own process group, because npm/next spawn grandchildren
 * that survive a signal sent only to the immediate child — the same thing that
 * left a chain node holding port 8545 before the demo learned to kill groups.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const services = [
  { name: "api", args: ["run", "api"], color: "\x1b[36m" },
  { name: "web", args: ["run", "web"], color: "\x1b[35m" },
];

const children = [];
let shuttingDown = false;

for (const svc of services) {
  const child = spawn("npm", svc.args, {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    // @pg/db resolves an absolute default from its own location, so nothing
    // here depends on which directory npm happens to run each workspace from.
    env: process.env,
  });

  const tag = `${svc.color}${svc.name.padEnd(3)}\x1b[0m`;
  const pipe = (stream) => {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      for (const line of chunk.split("\n")) {
        if (line.trim()) console.log(`${tag} │ ${line}`);
      }
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);

  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.log(`${tag} │ exited (${code}) — shutting everything down`);
      shutdown(code ?? 1);
    }
  });

  children.push(child);
}

console.log("\n  API  http://127.0.0.1:4000");
console.log("  Web  http://127.0.0.1:3000\n");
console.log("  Seed it first with:  npm run demo\n");

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.pid === undefined) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 400);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
