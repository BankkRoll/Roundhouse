/**
 * The minute tick (ADR 0004, "Scheduled dispatch"): the `* * * * *` Cron
 * Trigger runs every registered claimer in turn.
 *
 * A claimer selects a bounded batch of due rows (at most
 * {@link CLAIM_BATCH}), claims each with a conditional update so two
 * overlapping ticks never both act on a row, and does or starts the work.
 * A missed tick only delays work: the next one still sees the rows due.
 * One claimer failing never stops the others.
 *
 * To add one, append it to {@link MINUTE_CLAIMERS}.
 *
 * @module
 */
import { createDb } from "@roundhouse/db";
import type { Env } from "../env";
import { startPreviewAction } from "../workflows/preview";
import { claimAbandonedCleanups } from "./abandoned-volumes";
import { claimRecoveries } from "./backups/auto-recovery";
import { claimPitrStreams } from "./backups/pitr";
import { claimDueBackups } from "./backups/schedule";
import { claimDueCertificates, syncCertificates } from "./certificates/schedule";
import { claimCloudflareDeletions } from "./cloudflare/runtime";
import { claimDueCronRuns } from "./cron/schedule";
import { refreshAllNodes, refreshNodes } from "./desired-state";
import { DOMAIN_CHECK_CRON, runDomainChecks } from "./domains/check";
import { runSaasTick } from "./domains/saas";
import { reapRetiredEnvironments } from "./environments";
import { progressRotations } from "./mesh";
import { configuredOrigin } from "./origin";
import { runPreviewTick } from "./previews/engine";
import { expireLostShellSessions } from "./shell";
import { claimMigrationCleanups } from "./volume-migrations";
import { claimVolumeDeletions } from "./volumes";

/** The Cron Trigger expression of the minute tick; it must match `wrangler.jsonc`. */
export const MINUTE_CRON = DOMAIN_CHECK_CRON;

/** Rows one claimer takes per tick. */
export const CLAIM_BATCH = 100;

/** One kind of scheduled work the minute tick claims. */
export interface MinuteClaimer {
  /** Short name for logs, e.g. `volume_deletions`. */
  name: string;
  /**
   * Claims and handles the rows due at `now`.
   *
   * @param env - Worker bindings.
   * @param now - The tick's scheduled time, unix ms.
   * @returns How many rows were handled.
   */
  run(env: Env, now: number): Promise<number>;
}

/**
 * Every claimer, in the order they run. Kept as a static list (not
 * self-registration at import) so the set never depends on module load order.
 */
export const MINUTE_CLAIMERS: readonly MinuteClaimer[] = [
  {
    name: "domain_checks",
    run: async (env, now) => (await runDomainChecks(env, now)).checked,
  },
  {
    // After the domain checks, so a domain verified this tick gets its order now.
    name: "certificates",
    run: async (env, now) => {
      const db = createDb(env.DB);
      await syncCertificates(db, now);
      return claimDueCertificates(env, db, now);
    },
  },
  { name: "volume_deletions", run: claimVolumeDeletions },
  { name: "backup_policies", run: claimDueBackups },
  // After the scheduled backups, so a stream's first base backup isn't asked twice.
  { name: "pitr_streams", run: claimPitrStreams },
  { name: "migration_cleanups", run: claimMigrationCleanups },
  { name: "abandoned_copies", run: claimAbandonedCleanups },
  // ADR 0004: restore a lost server's stateful services onto healthy ones.
  { name: "recoveries", run: claimRecoveries },
  { name: "cron", run: claimDueCronRuns },
  {
    // Activates rotations whose peers had their time, and starts the
    // 90-day ones (ADR 0005, "Key rotation").
    name: "mesh_keys",
    run: (env, now) => {
      const db = createDb(env.DB);
      return progressRotations(db, (ids) => refreshNodes(env, db, ids), { now, scheduled: true });
    },
  },
  {
    // Cloudflare for SaaS (ADR 0009): origin records when the ingress
    // servers change, the fallback origin until active, the daily IP ranges.
    name: "saas",
    run: (env, now) => runSaasTick(env, now, () => refreshAllNodes(env, createDb(env.DB))),
  },
  {
    // ADR 0007: expire idle previews and admit queued ones as slots free up.
    name: "previews",
    run: (env, now) =>
      runPreviewTick(env, createDb(env.DB), now, (previewId, action) =>
        startPreviewAction(env, {
          kind: "action",
          preview_id: previewId,
          origin: configuredOrigin(env) ?? "",
          action,
        }),
      ),
  },
  {
    // After volume deletions, which free torn-down preview environments to go.
    name: "retired_environments",
    run: (env) => reapRetiredEnvironments(env, createDb(env.DB)),
  },
  { name: "lost_shell_sessions", run: expireLostShellSessions },
  { name: "cloudflare_deletions", run: claimCloudflareDeletions },
];

/**
 * Runs one minute tick.
 *
 * @param env - Worker bindings.
 * @param now - The tick's scheduled time, unix ms.
 * @param claimers - Claimers to run; every registered one by default.
 * @returns Rows handled per claimer, or `"failed"` for one that threw.
 */
export async function runMinuteTick(
  env: Env,
  now: number,
  claimers: readonly MinuteClaimer[] = MINUTE_CLAIMERS,
): Promise<Record<string, number | "failed">> {
  const report: Record<string, number | "failed"> = {};
  for (const c of claimers) {
    try {
      report[c.name] = await c.run(env, now);
    } catch (err) {
      report[c.name] = "failed";
      console.error(`minute tick: ${c.name} failed`, err instanceof Error ? err.name : "error");
    }
  }
  return report;
}
