/**
 * The node Durable Object's `metrics` handler (ADR 0008): resolves each
 * sample's workload to its owners through this node's placements, and
 * writes one row per sample to the metrics dataset.
 *
 * SECURITY: a sample counts only for a workload placed on the reporting
 * node, so an agent can't write metrics into another node's (or another
 * workspace's) services. System workloads (the registry, …) have no
 * placement and are dropped.
 *
 * @module
 */
import {
  type Db,
  deployments,
  placements,
  projects,
  serviceConfigs,
  services,
} from "@roundhouse/db";
import type { Metrics } from "@roundhouse/protocol";
import { and, eq, inArray } from "drizzle-orm";
import type { Env } from "../../../env";
import {
  containerRow,
  type MetricRow,
  type SampleOwner,
  writeMetricRows,
} from "../../../lib/metrics/write";

/** How long a workload's owners are reused, like log owners. */
export const OWNER_TTL_MS = 30_000;

/** Workloads whose owners one Durable Object remembers. */
const OWNER_CACHE_LIMIT = 1024;

/** D1 binds at most 100 parameters per statement; one goes to the node ID. */
const MAX_IDS_PER_LOOKUP = 90;

/**
 * Samples dated further from the control plane's clock than this are
 * stamped with the receive time instead, so a skewed agent clock can't
 * file samples hours away from where charts look for them.
 */
export const MAX_SAMPLE_SKEW_MS = 5 * 60 * 1000;

/** Resolves and caches the owners of this node's workloads. */
export class MetricOwners {
  private cache = new Map<string, { owner: SampleOwner | null; at: number }>();

  /** @param db - Control-plane database. */
  constructor(private readonly db: Db) {}

  /**
   * Owners of the given workloads on `nodeId`; unknown ones map to `null`.
   *
   * @param nodeId - The reporting node.
   * @param workloadIds - Distinct workload IDs.
   * @param now - Unix ms.
   */
  async resolve(
    nodeId: string,
    workloadIds: readonly string[],
    now: number,
  ): Promise<Map<string, SampleOwner | null>> {
    const out = new Map<string, SampleOwner | null>();
    const missing: string[] = [];
    for (const id of workloadIds) {
      const hit = this.cache.get(id);
      if (hit && now - hit.at < OWNER_TTL_MS) out.set(id, hit.owner);
      else missing.push(id);
    }
    for (let i = 0; i < missing.length; i += MAX_IDS_PER_LOOKUP) {
      const ids = missing.slice(i, i + MAX_IDS_PER_LOOKUP);
      const rows = await this.db
        .select({
          workloadId: placements.workloadId,
          deploymentId: placements.deploymentId,
          serviceId: deployments.serviceId,
          environmentId: deployments.environmentId,
          projectId: services.projectId,
          workspaceId: projects.workspaceId,
          resources: serviceConfigs.resources,
        })
        .from(placements)
        .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
        .innerJoin(services, eq(services.id, deployments.serviceId))
        .innerJoin(projects, eq(projects.id, services.projectId))
        .leftJoin(
          serviceConfigs,
          and(
            eq(serviceConfigs.serviceId, deployments.serviceId),
            eq(serviceConfigs.environmentId, deployments.environmentId),
            eq(serviceConfigs.version, deployments.configVersion),
          ),
        )
        .where(and(eq(placements.nodeId, nodeId), inArray(placements.workloadId, ids)));
      const found = new Map(rows.map((r) => [r.workloadId, r]));
      for (const id of ids) {
        const r = found.get(id);
        const owner: SampleOwner | null = r
          ? {
              workspaceId: r.workspaceId,
              projectId: r.projectId,
              environmentId: r.environmentId,
              serviceId: r.serviceId,
              deploymentId: r.deploymentId,
              cpuLimitMillis: r.resources?.cpu_millis ?? 0,
            }
          : null;
        out.set(id, owner);
        if (this.cache.size >= OWNER_CACHE_LIMIT) this.cache.clear();
        this.cache.set(id, { owner, at: now });
      }
    }
    return out;
  }
}

/**
 * Handles one `metrics` frame.
 *
 * @param env - Worker bindings.
 * @param owners - The Durable Object's owner cache.
 * @param nodeId - The reporting node.
 * @param frame - The validated frame.
 * @param now - Receive time, unix ms.
 * @returns How many samples were written.
 */
export async function onMetrics(
  env: Env,
  owners: MetricOwners,
  nodeId: string,
  frame: Metrics,
  now = Date.now(),
): Promise<number> {
  const resolved = await owners.resolve(
    nodeId,
    frame.samples.map((s) => s.workload_id),
    now,
  );
  const ts = Math.abs(frame.ts - now) > MAX_SAMPLE_SKEW_MS ? now : frame.ts;
  const rows: MetricRow[] = [];
  for (const s of frame.samples) {
    const owner = resolved.get(s.workload_id);
    if (owner) rows.push(containerRow(owner, s, { ...frame, ts }, nodeId));
  }
  await writeMetricRows(env, rows);
  return rows.length;
}
