/**
 * Read-only MCP tools for data services and metrics (ADR 0004, 0008):
 * `list_databases`, `list_backups` and `get_metrics`.
 *
 * Each checks the same action as the matching REST read (`services:read`)
 * through the same scope loaders, so a token sees exactly what it could
 * over REST.
 *
 * SECURITY: nothing here runs a query or returns a credential, a presigned
 * URL, an object key or a backup key. Database access stays in the
 * dashboard, behind `data:read`/`data:write` and a human.
 *
 * @module
 */
import { backups, environments, nodes, services, volumes } from "@roundhouse/db";
import {
  type Action,
  type ApiTokenScope,
  DEFAULT_METRICS_RANGE_MS,
  MAX_METRICS_RANGE_MS,
  SERVICE_METRICS,
} from "@roundhouse/shared";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, notInArray } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context";
import { getServiceMetrics, getServiceVolume, policyOf } from "../contracts";
import { ApiError, notFound } from "../lib/errors";
import { InvalidMetricsQuery } from "../lib/metrics/query";
import { alignRange, serviceSeries } from "../lib/metrics/series";
import { metricsStore } from "../lib/metrics/store";
import { latestConfig } from "../lib/projects";
import { environmentOf, projectScope, serviceScope } from "../lib/scope";
import type { McpTool } from "./tools";

const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

const Id = (what: string) => z.string().min(1).max(128).describe(`${what} ID`);
const EnvironmentId = Id("Environment").describe(
  "Environment ID (from get_project). Defaults to the project's production environment.",
);

const scopeOf = (route: Parameters<typeof policyOf>[0]): ApiTokenScope =>
  policyOf(route).action as Exclude<Action, "instance:manage" | "workspaces:create">;

async function environmentFor(c: AppContext, projectId: string, environmentId?: string) {
  if (environmentId) return environmentOf(c, projectId, environmentId);
  const [row] = await c
    .get("db")
    .select()
    .from(environments)
    .where(and(eq(environments.projectId, projectId), eq(environments.kind, "production")))
    .limit(1);
  if (!row) throw notFound("Environment");
  return row;
}

const listDatabasesTool: McpTool = {
  name: "list_databases",
  title: "List databases",
  description:
    "Lists a project's database services in one environment: engine, version, and their " +
    "volume's status, size, usage, quota mode and node. Never returns credentials or data.",
  input: z.object({ project_id: Id("Project"), environment_id: EnvironmentId.optional() }),
  scopes: [scopeOf(getServiceVolume)],
  annotations: READ,
  async run({ c }, raw) {
    const input = raw as { project_id: string; environment_id?: string };
    await projectScope(c, input.project_id, policyOf(getServiceVolume).action!);
    const environment = await environmentFor(c, input.project_id, input.environment_id);
    const db = c.get("db");
    const rows = await db
      .select({ service: services, volume: volumes, nodeName: nodes.name })
      .from(services)
      .leftJoin(
        volumes,
        and(
          eq(volumes.serviceId, services.id),
          eq(volumes.environmentId, environment.id),
          notInArray(volumes.status, ["deleted", "abandoned"]),
        ),
      )
      .leftJoin(nodes, eq(nodes.id, volumes.nodeId))
      .where(
        and(
          eq(services.projectId, input.project_id),
          isNull(services.deletedAt),
          isNotNull(services.databaseEngine),
        ),
      )
      .orderBy(asc(services.id));
    return {
      environment_id: environment.id,
      databases: rows.map(({ service, volume, nodeName }) => ({
        service_id: service.id,
        name: service.name,
        slug: service.slug,
        engine: service.databaseEngine,
        version: service.databaseVersion,
        volume: volume
          ? {
              id: volume.id,
              status: volume.status,
              size_mb: volume.sizeMb,
              used_bytes: volume.usedBytes,
              quota_mode: volume.quotaMode,
              node_id: volume.nodeId,
              node_name: nodeName,
              reported_at: volume.reportedAt ? +volume.reportedAt : null,
            }
          : null,
      })),
    };
  },
};

const listBackupsTool: McpTool = {
  name: "list_backups",
  title: "List backups",
  description:
    "Lists a service's backups in one environment, newest first: status, trigger, method, " +
    "sizes and timestamps. Never returns download links or decryption keys.",
  input: z.object({
    service_id: Id("Service"),
    environment_id: EnvironmentId.optional(),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.string().max(128).optional().describe("next_cursor from the previous page."),
  }),
  scopes: [scopeOf(getServiceVolume)],
  annotations: READ,
  async run({ c }, raw) {
    const input = raw as {
      service_id: string;
      environment_id?: string;
      limit: number;
      cursor?: string;
    };
    const { project } = await serviceScope(c, input.service_id, policyOf(getServiceVolume).action!);
    const environment = await environmentFor(c, project.id, input.environment_id);
    const rows = await c
      .get("db")
      .select({
        id: backups.id,
        status: backups.status,
        trigger: backups.trigger,
        method: backups.method,
        engine: backups.engine,
        engineVersion: backups.engineVersion,
        bytesRaw: backups.bytesRaw,
        bytesStored: backups.bytesStored,
        pinned: backups.pinned,
        error: backups.error,
        startedAt: backups.startedAt,
        finishedAt: backups.finishedAt,
        createdAt: backups.createdAt,
      })
      .from(backups)
      .where(
        and(
          eq(backups.serviceId, input.service_id),
          eq(backups.environmentId, environment.id),
          inArray(backups.status, ["queued", "running", "succeeded", "failed"]),
          ...(input.cursor ? [lt(backups.id, input.cursor)] : []),
        ),
      )
      .orderBy(desc(backups.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    return {
      environment_id: environment.id,
      backups: page.map((b) => ({
        id: b.id,
        status: b.status,
        trigger: b.trigger,
        method: b.method,
        engine: b.engine,
        engine_version: b.engineVersion,
        bytes_raw: b.bytesRaw,
        bytes_stored: b.bytesStored,
        pinned: b.pinned,
        error: b.error,
        started_at: b.startedAt ? +b.startedAt : null,
        finished_at: b.finishedAt ? +b.finishedAt : null,
        created_at: +b.createdAt,
      })),
      next_cursor: rows.length > input.limit ? page[page.length - 1]!.id : null,
    };
  },
};

const getMetricsTool: McpTool = {
  name: "get_metrics",
  title: "Get service metrics",
  description:
    "Returns a service's container metrics in one environment over a time range " +
    `(at most ${MAX_METRICS_RANGE_MS / 86_400_000} days; the last hour by default), ` +
    `downsampled. Metrics: ${SERVICE_METRICS.join(", ")}. CPU is millicores; rates are bytes per second.`,
  input: z.object({
    service_id: Id("Service"),
    environment_id: EnvironmentId.optional(),
    from: z.number().int().nonnegative().optional().describe("Unix ms."),
    to: z.number().int().nonnegative().optional().describe("Unix ms; defaults to now."),
    metrics: z.array(z.enum(SERVICE_METRICS)).max(SERVICE_METRICS.length).optional(),
    group: z.enum(["service", "replica"]).default("service"),
  }),
  scopes: [scopeOf(getServiceMetrics)],
  annotations: READ,
  async run({ c }, raw) {
    const input = raw as {
      service_id: string;
      environment_id?: string;
      from?: number;
      to?: number;
      metrics?: (typeof SERVICE_METRICS)[number][];
      group: "service" | "replica";
    };
    const { service, project } = await serviceScope(
      c,
      input.service_id,
      policyOf(getServiceMetrics).action!,
      input.environment_id,
    );
    const environment = await environmentFor(c, project.id, input.environment_id);
    const to = input.to ?? Date.now();
    const from = input.from ?? to - DEFAULT_METRICS_RANGE_MS;
    if (from >= to) throw new ApiError(400, "invalid_request", "`from` must be before `to`");
    if (to - from > MAX_METRICS_RANGE_MS) {
      throw new ApiError(400, "invalid_request", "The range may span at most 90 days");
    }
    const r = alignRange(from, to);
    const store = metricsStore(c.env);
    let result: Awaited<ReturnType<typeof serviceSeries>>;
    try {
      result = await serviceSeries(
        store,
        { workspaceId: project.workspaceId, serviceId: service.id, environmentId: environment.id },
        r,
        input.metrics?.length ? [...new Set(input.metrics)] : [...SERVICE_METRICS],
        input.group,
      );
    } catch (err) {
      if (err instanceof InvalidMetricsQuery)
        throw new ApiError(400, "invalid_request", err.message);
      throw err;
    }
    const config = await latestConfig(c.get("db"), service.id, environment.id);
    return {
      environment_id: environment.id,
      step_s: r.stepS,
      from: r.from * 1000,
      to: r.to * 1000,
      backend: store.backend,
      limits: config
        ? {
            cpu_millis: config.resources.cpu_millis,
            memory_bytes: config.resources.memory_mb * 1024 * 1024,
          }
        : null,
      approximate: result.approximate,
      series: result.series,
    };
  },
};

/** The data and metrics tools, in `tools/list` order. */
export const DATA_TOOLS: readonly McpTool[] = [listDatabasesTool, listBackupsTool, getMetricsTool];
