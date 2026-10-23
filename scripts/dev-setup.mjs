#!/usr/bin/env node
/**
 * One-time local setup that works the same in PowerShell, cmd, and POSIX
 * shells: creates `apps/api/.dev.vars` with a fresh MASTER_KEY (unless one is
 * already set) and applies the local D1 migrations.
 *
 * Usage: `pnpm setup:dev`
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const apiDir = resolve(import.meta.dirname, "..", "apps", "api");
const vars = join(apiDir, ".dev.vars");

if (!existsSync(vars)) copyFileSync(join(apiDir, ".dev.vars.example"), vars);

const current = readFileSync(vars, "utf8");
const existing = current.match(/^MASTER_KEY=(.+)$/m)?.[1]?.trim();
let key = existing;
if (!key) {
  key = randomBytes(32).toString("base64");
  const next = /^MASTER_KEY=.*$/m.test(current)
    ? current.replace(/^MASTER_KEY=.*$/m, `MASTER_KEY=${key}`)
    : `${current.trimEnd()}\nMASTER_KEY=${key}\n`;
  writeFileSync(vars, next);
}

const migrate = spawnSync("pnpm", ["--filter", "@roundhouse/api", "db:migrate:local"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

console.log(`
Local setup done.
  Master key (paste it into the setup wizard): ${key}
  Next: pnpm dev, then open http://localhost:5173
`);
