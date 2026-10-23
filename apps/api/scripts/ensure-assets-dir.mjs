#!/usr/bin/env node
/**
 * Creates `apps/web/dist` when it is missing. `wrangler.jsonc` serves the
 * dashboard build from there, and wrangler refuses to start (`wrangler dev`,
 * `wrangler d1 …`) while the directory doesn't exist, which it doesn't on a
 * fresh clone. In development the dashboard comes from Vite on :5173, so an
 * empty directory is enough.
 *
 * Usage: `node scripts/ensure-assets-dir.mjs` (run by the `dev` and
 * `db:migrate:local` scripts)
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

mkdirSync(resolve(import.meta.dirname, "..", "..", "web", "dist"), { recursive: true });
