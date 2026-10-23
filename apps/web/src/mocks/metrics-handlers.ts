/**
 * MSW handlers for the metrics routes (`apps/api/src/contracts/metrics.ts`) against the
 * in-memory {@link db}. Queries are validated with the API's own zod schemas, and
 * `contract.test.ts` validates every response.
 *
 * There is no agent here, so series are synthesised: deterministic per service, replica
 * and timestamp (the same request always answers the same numbers), on the step grid
 * `metricsStep` picks for the range. A service has samples only from its first
 * deployment on, and only while it has an active deployment; a few steps are gaps, as
 * when an agent reconnects. With the D1 backend, samples older than 48 h are gone.
 *
 * @module
 */
import {
  D1_METRICS_RETENTION_MS,
  DEFAULT_METRICS_RANGE_MS,
  MAX_METRICS_RANGE_MS,
  MAX_REPLICA_SERIES,
  metricsStep,
  NODE_METRICS,
  SERVICE_METRICS,
} from "@roundhouse/shared";
import { HttpResponse, http } from "msw";
import {
  METRICS_ROUTES,
  MetricsSummaryQuery,
  NodeMetricsQuery,
  policyOf,
  ServiceMetricsQuery,
} from "../../../api/src/contracts";
import type {
  MetricPoint,
  MetricSeries,
  MetricsSummary,
  NodeMetrics,
  ServiceMetrics,
} from "../lib/api/metrics-client";
import { currentUser, invalid, notFound, requireWorkspace, unauthorized } from "./common";
import { db } from "./db";

type RouteName = keyof typeof METRICS_ROUTES;

function mswPath(name: RouteName): string {
  return `*${METRICS_ROUTES[name].path.replace(/\{([^}]+)\}/g, ":$1")}`;
}

const actionOf = (name: RouteName) => policyOf(METRICS_ROUTES[name]).action!;

// -----------------------------------------------------------------------------
// Knobs for tests
// -----------------------------------------------------------------------------

/** Behaviour a test can switch on; reset with the database. */
export interface MetricsMockState {
  backend: "analytics_engine" | "d1";
  /** Services whose samples are marked approximate (cgroup v1 hosts). */
  approximate: Set<string>;
  /** Services that report nothing, whatever their deployments. */
  silent: Set<string>;
}

// NOTE: Keyed by the database object, which `resetDb` replaces, so these knobs reset
// with it without the shared test setup knowing about metrics.
const states = new WeakMap<object, MetricsMockState>();

function state(): MetricsMockState {
  let current = states.get(db);
  if (!current) {
    current = { backend: "analytics_engine", approximate: new Set(), silent: new Set() };
    states.set(db, current);
  }
  return current;
}

/**
 * Changes how the metrics mocks answer until the next `resetDb`.
 *
 * @param patch - Backend, and services to mark approximate or silent.
 * @example
 * setMetricsMock({ backend: "d1", approximate: ["svc_api"] });
 */
export function setMetricsMock(patch: {
  backend?: MetricsMockState["backend"];
  approximate?: readonly string[];
  silent?: readonly string[];
}): void {
  const current = state();
  if (patch.backend) current.backend = patch.backend;
  for (const id of patch.approximate ?? []) current.approximate.add(id);
  for (const id of patch.silent ?? []) current.silent.add(id);
}

// -----------------------------------------------------------------------------
// Synthetic samples
// -----------------------------------------------------------------------------

/** FNV-1a, folded to [0, 1). */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x1_0000_0000;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MiB = 1024 * 1024;

const wave = (t: number, period: number, phase: number) =>
  Math.sin((2 * Math.PI * t) / period + phase * 2 * Math.PI);

/** One replica's value of a metric at a step, before gaps are applied. */
function sample(metric: string, key: string, t: number, stepS: number): number {
  const scale = 0.6 + hash(`scale:${key}`) * 0.8;
  const phase = hash(`phase:${key}`);
  const noise = hash(`noise:${metric}:${key}:${t}`) - 0.5;
  const daily = wave(t, 24 * HOUR, phase);
  const short = wave(t, 17 * MINUTE, phase);
  switch (metric) {
    case "cpu":
      return Math.max(0, 140 * scale * (1 + 0.4 * daily + 0.15 * short + 0.3 * noise));
    case "memory":
    case "memory_max": {
      const base = 96 * MiB * scale * (1 + 0.08 * daily + 0.03 * noise);
      return metric === "memory_max" ? base * 1.12 : base;
    }
    case "net_rx":
      return Math.max(0, 48 * 1024 * scale * (1 + 0.5 * daily + 0.4 * noise));
    case "net_tx":
      return Math.max(0, 22 * 1024 * scale * (1 + 0.5 * daily + 0.4 * noise));
    case "disk_read":
      return Math.max(0, 6 * 1024 * scale * (1 + 0.8 * noise));
    case "disk_write":
      return Math.max(0, 31 * 1024 * scale * (1 + 0.3 * daily + 0.6 * noise));
    case "restarts":
      // NOTE: About one restart a day per replica, whatever the step.
      return hash(`restart:${key}:${t}`) < stepS / 86_400 ? 1 : 0;
    case "pids":
      return Math.round(12 * scale + 2 * noise);
    default:
      return 0;
  }
}

interface SeriesSource {
  /** Seeds the shape: service or node id. */
  key: string;
  /** Replica (or node) keys, one per workload. */
  workloads: readonly string[];
  /** No samples before this. */
  since: number;
}

function stepGrid(from: number, to: number, stepS: number): number[] {
  const step = stepS * 1000;
  const times: number[] = [];
  for (let t = Math.ceil(from / step) * step; t < to; t += step) times.push(t);
  return times;
}

function pointsFor(
  metric: string,
  source: SeriesSource,
  workloads: readonly string[],
  times: readonly number[],
  stepS: number,
): MetricPoint[] {
  const horizon = state().backend === "d1" ? Date.now() - D1_METRICS_RETENTION_MS : 0;
  const now = Date.now();
  return times.map((t): MetricPoint => {
    const gap = hash(`gap:${source.key}:${t}`) < 0.012;
    if (gap || t < source.since || t < horizon || t > now) return [t, null];
    let total = 0;
    for (const w of workloads) total += sample(metric, `${source.key}:${w}`, t, stepS);
    return [t, Math.round(total * 100) / 100];
  });
}

function seriesFor(
  metrics: readonly string[],
  source: SeriesSource,
  group: "service" | "replica",
  times: readonly number[],
  stepS: number,
): MetricSeries[] {
  if (source.workloads.length === 0) return [];
  if (group === "service") {
    return metrics.map((metric) => ({
      metric,
      points: pointsFor(metric, source, source.workloads, times, stepS),
    }));
  }
  return metrics.flatMap((metric) =>
    source.workloads.slice(0, MAX_REPLICA_SERIES).map((workload) => ({
      metric,
      workload_id: workload,
      points: pointsFor(metric, source, [workload], times, stepS),
    })),
  );
}

// -----------------------------------------------------------------------------
// Rows
// -----------------------------------------------------------------------------

function liveService(serviceId: string) {
  const service = db.deploy.services.find((row) => row.id === serviceId && !row.deleted);
  const project = service
    ? db.deploy.projects.find((row) => row.id === service.project_id && !row.deleted)
    : undefined;
  return service && project ? { service, project } : undefined;
}

/** What a service in an environment reports: its active replicas, from its first deploy. */
function serviceSource(serviceId: string, environmentId: string): SeriesSource {
  const deployments = db.deploy.deployments.filter(
    (row) => row.service_id === serviceId && row.environment_id === environmentId,
  );
  const active = deployments.filter((row) => row.status === "active").map((row) => row.id);
  const workloads = state().silent.has(serviceId)
    ? []
    : db.deploy.placements
        .filter((row) => active.includes(row.deployment_id) && row.workload_id)
        .map((row) => row.workload_id!)
        .sort();
  const since = Math.min(...deployments.map((row) => row.created_at), Number.POSITIVE_INFINITY);
  return { key: serviceId, workloads, since };
}

function limitsFor(serviceId: string, environmentId: string): ServiceMetrics["limits"] {
  const deployed = db.deploy.deployments.some(
    (row) => row.service_id === serviceId && row.environment_id === environmentId,
  );
  const config = db.deploy.configs
    .filter((row) => row.service_id === serviceId && row.environment_id === environmentId)
    .sort((a, b) => b.version - a.version)[0];
  if (!deployed || !config) return null;
  return {
    cpu_millis: config.resources.cpu_millis,
    memory_bytes: config.resources.memory_mb * MiB,
  };
}

/** Parses a query with the API's schema; the first issue becomes the 400 message. */
function parseQuery<T>(
  schema: {
    safeParse(v: unknown): {
      success: boolean;
      data?: T;
      error?: { issues: { path: PropertyKey[]; message: string }[] };
    };
  },
  request: Request,
): { ok: true; data: T } | { ok: false; response: Response } {
  const raw = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data as T };
  const issue = parsed.error?.issues[0];
  return {
    ok: false,
    response: invalid(issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid query"),
  };
}

/** The API's range rules: `to` defaults to now, `from` to an hour before it. */
function resolveRange(query: { from?: number; to?: number }) {
  const to = query.to ?? Date.now();
  const from = query.from ?? to - DEFAULT_METRICS_RANGE_MS;
  if (from >= to) return { ok: false as const, response: invalid("from must be before to") };
  if (to - from > MAX_METRICS_RANGE_MS) {
    return { ok: false as const, response: invalid("The range may cover at most 90 days") };
  }
  return { ok: true as const, from, to, stepS: metricsStep(to - from) };
}

function meta(from: number, to: number, stepS: number) {
  const backend = state().backend;
  return { step_s: stepS, from, to, backend, short_retention: backend === "d1" };
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

/** Metrics handlers. */
export const metricsHandlers = [
  http.get(mswPath("getServiceMetrics"), ({ request, params }) => {
    const query = parseQuery<{
      environment_id: string;
      from?: number;
      to?: number;
      metrics?: string[];
      group: "service" | "replica";
    }>(ServiceMetricsQuery, request);
    if (!query.ok) return query.response;
    const range = resolveRange(query.data);
    if (!range.ok) return range.response;
    if (!currentUser()) return unauthorized();
    const found = liveService(String(params.serviceId));
    if (!found) return notFound("Service");
    const guard = requireWorkspace(found.project.workspace_id, actionOf("getServiceMetrics"));
    if (!guard.ok) return guard.response.status === 404 ? notFound("Service") : guard.response;
    const environment = db.deploy.environments.find(
      (row) => row.id === query.data.environment_id && row.project_id === found.project.id,
    );
    if (!environment) return notFound("Environment");

    const source = serviceSource(found.service.id, environment.id);
    const metrics = query.data.metrics?.length ? query.data.metrics : [...SERVICE_METRICS];
    const series = seriesFor(
      metrics,
      source,
      query.data.group,
      stepGrid(range.from, range.to, range.stepS),
      range.stepS,
    );
    const body: ServiceMetrics = {
      ...meta(range.from, range.to, range.stepS),
      limits: limitsFor(found.service.id, environment.id),
      approximate: series.length > 0 && state().approximate.has(found.service.id),
      series,
    };
    return HttpResponse.json(body);
  }),

  http.get(mswPath("getProjectMetricsSummary"), ({ request, params }) => {
    const query = parseQuery<{ environment_id?: string }>(MetricsSummaryQuery, request);
    if (!query.ok) return query.response;
    if (!currentUser()) return unauthorized();
    const project = db.deploy.projects.find(
      (row) => row.id === String(params.projectId) && !row.deleted,
    );
    if (!project) return notFound("Project");
    const guard = requireWorkspace(project.workspace_id, actionOf("getProjectMetricsSummary"));
    if (!guard.ok) return guard.response.status === 404 ? notFound("Project") : guard.response;
    const environments = db.deploy.environments.filter((row) => row.project_id === project.id);
    const environment = query.data.environment_id
      ? environments.find((row) => row.id === query.data.environment_id)
      : environments.find((row) => row.kind === "production");
    if (!environment) return notFound("Environment");

    const stepS = 300;
    const to = Math.floor(Date.now() / (stepS * 1000)) * stepS * 1000;
    const times = stepGrid(to - HOUR, to, stepS);
    const services = db.deploy.services
      .filter((row) => row.project_id === project.id && !row.deleted)
      .map((service) => {
        const source = serviceSource(service.id, environment.id);
        const [cpu, memory] = seriesFor(["cpu", "memory"], source, "service", times, stepS);
        const limits = limitsFor(service.id, environment.id);
        const latest = (points: MetricPoint[] | undefined) =>
          points?.findLast(([, v]) => v !== null)?.[1] ?? null;
        return {
          service_id: service.id,
          cpu_millis: latest(cpu?.points),
          mem_bytes: latest(memory?.points),
          cpu_limit_millis: limits?.cpu_millis ?? null,
          mem_limit_bytes: limits?.memory_bytes ?? null,
          cpu: cpu?.points ?? times.map((t): MetricPoint => [t, null]),
          memory: memory?.points ?? times.map((t): MetricPoint => [t, null]),
        };
      });
    const backend = state().backend;
    const body: MetricsSummary = {
      environment_id: environment.id,
      backend,
      short_retention: backend === "d1",
      services,
    };
    return HttpResponse.json(body);
  }),

  http.get(mswPath("getNodeMetrics"), ({ request, params }) => {
    const query = parseQuery<{ from?: number; to?: number; metrics?: string[] }>(
      NodeMetricsQuery,
      request,
    );
    if (!query.ok) return query.response;
    const range = resolveRange(query.data);
    if (!range.ok) return range.response;
    const workspaceId = String(params.workspaceId);
    const guard = requireWorkspace(workspaceId, actionOf("getNodeMetrics"));
    if (!guard.ok) return guard.response;
    const node = db.nodes.find(
      (row) => row.id === String(params.nodeId) && row.workspace_id === workspaceId,
    );
    if (!node) return notFound("Node");

    const times = stepGrid(range.from, range.to, range.stepS);
    const metrics = query.data.metrics?.length ? query.data.metrics : [...NODE_METRICS];
    const reported = node.cpu_percent !== null;
    const around = (base: number, key: string): MetricPoint[] =>
      times.map((t): MetricPoint => {
        if (t < node.created_at || t > Date.now() || hash(`gap:${node.id}:${t}`) < 0.012) {
          return [t, null];
        }
        const swing = 1 + 0.15 * wave(t, 24 * HOUR, hash(key)) + 0.1 * (hash(`${key}:${t}`) - 0.5);
        return [t, Math.round(base * swing * 100) / 100];
      });
    const bases: Record<(typeof NODE_METRICS)[number], number> = {
      cpu_percent: node.cpu_percent ?? 0,
      memory: node.mem_used ?? 0,
      disk: node.disk_used ?? 0,
      load1: ((node.cpu_percent ?? 0) / 100) * (node.cpu_total ?? 1),
    };
    const body: NodeMetrics = {
      ...meta(range.from, range.to, range.stepS),
      series: reported
        ? metrics.map((metric) => ({
            metric,
            points: around(bases[metric as keyof typeof bases], `${node.id}:${metric}`),
          }))
        : [],
    };
    return HttpResponse.json(body);
  }),
];
