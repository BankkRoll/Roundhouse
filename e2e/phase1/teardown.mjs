#!/usr/bin/env node
/**
 * Removes what a Phase 1 run left behind (after `PHASE1_KEEP=1` or a killed
 * run): the kept `wrangler dev` and its state, containers, networks, volumes
 * and the node's data directory.
 */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stopControlPlane, teardown } from "./lib/stack.mjs";
import { ARTIFACTS } from "./lib/util.mjs";

await teardown();
const kept = join(ARTIFACTS, "keep.json");
try {
  stopControlPlane(JSON.parse(readFileSync(kept, "utf8")));
  rmSync(kept);
} catch (err) {
  if (err.code !== "ENOENT") throw err;
}
