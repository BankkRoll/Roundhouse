/**
 * Metrics (ADR 0008): the SQL builder and its injection guard, Analytics
 * Engine answers, the `metrics` frame write path through the node Durable
 * Object into the D1 fallback, and the query routes with their contracts.
 */

import { env, introspectWorkflow } from "cloudflare:test";
import { OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import { type ControlMessage, METRICS_PROTOCOL_VERSION } from "@roundhouse/protocol";
import { ACTIONS, metricsStep } from "@roundhouse/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  METRICS_ROUTES,
  PHASE1_ROUTES,
  POLICY_KEY,
  policyOf,
  type RoutePolicy,
  ServiceMetricsSchema,
} from "../src/contracts";
import { app } from "../src/index";
import {
  buildMetricsQuery,
  InvalidMetricsQuery,
  type MetricsQuery,
} from "../src/lib/metrics/query";
import { alignRange } from "../src/lib/metrics/series";
import { AnalyticsEngineStore, analyticsSqlUrl, parseRows } from "../src/lib/metrics/store";
import { runRetention } from "../src/lib/retention";
import aeNode from "./fixtures/analytics-engine/node.json";
import aeService from "./fixtures/analytics-engine/service-by-workload.json";
import { call, eventually, install, joinNode } from "./helpers";
import {
  connectWorkloadAgent,
  createProject,
  createService,
  deploy,
  settleDeployments,
  waitForStatus,
} from "./pipeline-helpers";

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
beforeEach(async () => {
  introspector = await introspectWorkflow(env.DEPLOY_WORKFLOW);
});
afterEach(async () => {
  await settleDeployments();
  await introspector?.dispose();
});

const query = (over: Partial<MetricsQuery> = {}): MetricsQuery => ({
  kind: "container",
  filters: { index: "svc_1", workspace_id: "ws_1", environment_id: "env_1" },
  from: 1_792_735_200,
  to: 1_792_738_800,
  stepS: 15,
  columns: [
    { column: "cpu_millis", aggregate: "avg" },
    { column: "net_rx_bytes", aggregate: "rate" },
  ],
  byWorkload: true,
  withSource: true,
  ...over,
});

describe("metrics SQL", () => {
  it("builds Analytics Engine SQL with weighted aggregates and inlined, validated values", () => {
    const { sql, params } = buildMetricsQuery(query(), "analytics_engine");
    expect(params).toEqual([]);
    expect(sql).toMatchInlineSnapshot(`
      "SELECT toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL '15' SECOND)) AS t, blob7 AS workload, sum(double1 * _sample_interval) / sum(_sample_interval) AS m0, sum(double5 * _sample_interval) / 15 AS m1, max(if(blob9 = 'docker_stats', 1, 0)) AS approx
      FROM roundhouse_metrics
      WHERE blob1 = 'container' AND index1 = 'svc_1' AND blob2 = 'ws_1' AND blob4 = 'env_1' AND timestamp >= toDateTime(1792735200) AND timestamp < toDateTime(1792738800)
      GROUP BY t, workload
      ORDER BY t
      LIMIT 20000
      FORMAT JSON"
    `);
  });

  it("binds every value for D1", () => {
    const { sql, params } = buildMetricsQuery(query(), "d1");
    expect(sql).not.toContain("svc_1");
    expect(sql).toContain("(timestamp / 15000) * 15 AS t");
    expect(params).toEqual([
      "container",
      "svc_1",
      "ws_1",
      "env_1",
      1_792_735_200_000,
      1_792_738_800_000,
    ]);
  });

  it.each([
    ["an ID with a quote", { filters: { index: "svc_1' OR 1=1 --" } }],
    ["an ID with spaces", { filters: { workspace_id: "ws 1" } }],
    ["a fractional step", { stepS: 1.5 }],
    ["a negative from", { from: -1 }],
    ["an inverted range", { from: 10, to: 5 }],
    ["an unknown column", { columns: [{ column: "drop" as never, aggregate: "avg" as const }] }],
  ])("rejects %s before any SQL exists", (_, over) => {
    expect(() => buildMetricsQuery(query(over), "analytics_engine")).toThrow(InvalidMetricsQuery);
  });

  it("keeps every range at 360 points or fewer", () => {
    for (const hours of [1, 6, 24, 24 * 7, 24 * 30, 24 * 90]) {
      const ms = hours * 3_600_000;
      const r = alignRange(1_792_735_123_000 - ms, 1_792_735_123_000);
      expect(r.stepS).toBe(metricsStep(ms));
      expect((r.to - r.from) / r.stepS).toBeLessThanOrEqual(360);
    }
  });
});

describe("Analytics Engine store", () => {
  it("parses SQL API answers, numbers as strings and NaN included", () => {
    const rows = parseRows(aeService.data, 2);
    expect(rows).toEqual([
      { t: 1_792_735_200, workload: "wl_01JA", values: [250.5, 134_217_728], approx: false },
      { t: 1_792_735_200, workload: "wl_01JB", values: [120, 67_108_864], approx: false },
      { t: 1_792_735_215, workload: "wl_01JA", values: [260, null], approx: true },
    ]);
    expect(parseRows(aeNode.data, 1)).toEqual([
      { t: 1_792_735_200, values: [41.25], approx: false },
    ]);
  });

  it("posts the SQL with the read token and maps failures to 503", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const ok = new AnalyticsEngineStore(
      "acc123",
      "tok-read",
      (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return Response.json(aeService);
      }) as typeof fetch,
      null,
    );
    const rows = await ok.run(query());
    expect(rows).toHaveLength(3);
    expect(seen[0]!.url).toBe(analyticsSqlUrl("acc123"));
    expect(new Headers(seen[0]!.init.headers).get("authorization")).toBe("Bearer tok-read");
    expect(String(seen[0]!.init.body)).toContain("FROM roundhouse_metrics");

    const failing = new AnalyticsEngineStore(
      "acc123",
      "tok-read",
      (async () => new Response("no", { status: 401 })) as unknown as typeof fetch,
      null,
    );
    await expect(failing.run(query())).rejects.toMatchObject({ status: 503 });
  });
});

describe("metrics contracts", () => {
  const routes = Object.entries(METRICS_ROUTES) as [
    string,
    RouteConfig & { [POLICY_KEY]: RoutePolicy },
  ][];

  it("serves every route with its policy, read-only and unaudited", () => {
    const live = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } });
    const taken = new Set(Object.values(PHASE1_ROUTES).map((r) => `${r.method} ${r.path}`));
    for (const [name, route] of routes) {
      const op = (live.paths?.[route.path] as Record<string, Record<string, unknown>>)?.[
        route.method
      ];
      expect(op?.[POLICY_KEY], name).toEqual(policyOf(route));
      expect(route.method).toBe("get");
      expect(policyOf(route).audit).toEqual([]);
      expect(ACTIONS).toContain(policyOf(route).action);
      expect(taken.has(`${route.method} ${route.path}`)).toBe(false);
    }
    const router = new OpenAPIHono();
    for (const [, r] of routes) router.openapi(r, (c) => c.body(null, 204) as never);
    expect(
      Object.keys(
        router.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } })
          .paths ?? {},
      ),
    ).toHaveLength(3);
  });
});

/** Installs, connects a protocol 6 agent, and deploys an image service to it. */
async function metricsStage() {
  const { owner, workspaceId } = await install();
  const joined = await joinNode(owner, workspaceId);
  const agent = await connectWorkloadAgent(
    joined,
    {},
    { protocol_version: METRICS_PROTOCOL_VERSION },
  );
  const project = await createProject(owner, workspaceId);
  const created = await createService(owner, project.id);
  const envId = project.environments[0]!.id;
  const serviceId = created.service.id;
  const d = await deploy(owner, serviceId, envId);
  const active = await waitForStatus(owner, d.id, ["active"]);
  return {
    owner,
    workspaceId,
    joined,
    agent,
    project,
    envId,
    serviceId,
    workloadId: active.placements![0]!.workload_id,
  };
}

const sample = (workloadId: string, cpu = 400) => ({
  workload_id: workloadId,
  cpu_millis: cpu,
  mem_bytes: 300 * 2 ** 20,
  mem_limit_bytes: 512 * 2 ** 20,
  net_rx_bytes: 15_000,
  net_tx_bytes: 30_000,
  disk_read_bytes: 0,
  disk_write_bytes: 4096,
  pids: 3,
  restarts: 0,
});

const frame = (samples: unknown[], ts = Date.now()) => ({
  type: "metrics",
  ts,
  interval_ms: 15_000,
  source: "cgroup_v2",
  samples,
});

async function sampleCount(where = "1 = 1") {
  const row = await env.DB.prepare(
    `SELECT count(*) AS n FROM metrics_samples WHERE blob1 = 'container' AND ${where}`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

describe("metrics ingest and queries", () => {
  it("asks only metrics-capable agents for metrics in welcome", async () => {
    const s = await metricsStage();
    const welcome = s.agent.received.find((m: ControlMessage) => m.type === "welcome");
    expect(welcome).toMatchObject({ metrics_interval_ms: 15_000 });

    const old = await joinNode(s.owner, s.workspaceId);
    const v5 = await connectWorkloadAgent(old, {}, { protocol_version: 5 });
    await eventually(async () => (v5.received.length ? true : undefined));
    const w5 = v5.received.find((m: ControlMessage) => m.type === "welcome");
    expect(w5).toBeDefined();
    expect(w5).not.toHaveProperty("metrics_interval_ms");
  });

  it("writes this node's samples, drops foreign workloads, and serves them per service and replica", async () => {
    const s = await metricsStage();
    s.agent.send(frame([sample(s.workloadId), sample("wl_notmine")]));
    await eventually(async () => ((await sampleCount()) > 0 ? true : undefined));
    expect(await sampleCount()).toBe(1);

    const res = await s.owner.json<unknown>(
      `/v1/services/${s.serviceId}/metrics?environment_id=${s.envId}&metrics=cpu,memory,net_rx`,
    );
    expect(res.status).toBe(200);
    const body = ServiceMetricsSchema.parse(res.body);
    expect(body).toMatchObject({
      step_s: 15,
      backend: "d1",
      short_retention: true,
      approximate: false,
    });
    expect(body.limits).toEqual({
      cpu_millis: expect.any(Number),
      memory_bytes: expect.any(Number),
    });
    const values = (m: string) =>
      body.series.find((x) => x.metric === m)!.points.flatMap(([, v]) => (v === null ? [] : [v]));
    expect(values("cpu")).toEqual([400]);
    expect(values("memory")).toEqual([300 * 2 ** 20]);
    expect(values("net_rx")).toEqual([1000]);
    expect(body.series.find((x) => x.metric === "cpu")!.points.length).toBeLessThanOrEqual(241);

    const replicas = await s.owner.json<{ series: { workload_id?: string }[] }>(
      `/v1/services/${s.serviceId}/metrics?environment_id=${s.envId}&metrics=cpu&group=replica`,
    );
    expect(replicas.body.series.map((x) => x.workload_id)).toEqual([s.workloadId]);

    const summary = await s.owner.json<{
      services: { service_id: string; cpu_millis: number | null }[];
    }>(`/v1/projects/${s.project.id}/metrics/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body.services).toEqual([
      expect.objectContaining({ service_id: s.serviceId, cpu_millis: 400 }),
    ]);
  });

  it("ignores samples a different node reports for this node's workload", async () => {
    const s = await metricsStage();
    const other = await joinNode(s.owner, s.workspaceId);
    const intruder = await connectWorkloadAgent(
      other,
      {},
      { protocol_version: METRICS_PROTOCOL_VERSION },
    );
    await eventually(async () => (intruder.received.length ? true : undefined));
    intruder.send(frame([sample(s.workloadId, 999)]));
    s.agent.send(frame([sample(s.workloadId, 100)]));
    await eventually(async () => ((await sampleCount()) > 0 ? true : undefined));
    expect(await sampleCount("double1 = 999")).toBe(0);
  });

  it("drops metrics from agents below the metrics protocol", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const agent = await connectWorkloadAgent(joined, {}, { protocol_version: 5 });
    await eventually(async () => (agent.received.length ? true : undefined));
    agent.send(frame([sample("wl_whatever")]));
    agent.send({
      type: "heartbeat",
      seq: 1,
      ts: Date.now(),
      observed_generation: 0,
      usage: {
        cpu_percent: 1,
        mem_used_bytes: 1,
        mem_total_bytes: 2,
        disk_used_bytes: 1,
        disk_total_bytes: 2,
        load1: 0,
      },
    });
    await eventually(async () => {
      const r = await env.DB.prepare(
        "SELECT count(*) AS n FROM metrics_samples WHERE blob1 = 'node'",
      ).first<{ n: number }>();
      return r && r.n > 0 ? true : undefined;
    });
    expect(await sampleCount()).toBe(0);
  });

  it("validates ranges, needs a session, and 404s environments of other projects", async () => {
    const s = await metricsStage();
    const base = `/v1/services/${s.serviceId}/metrics`;
    expect((await call(`${base}?environment_id=${s.envId}`)).status).toBe(401);
    expect((await s.owner.json(`${base}?environment_id=${s.envId}&from=10&to=5`)).status).toBe(400);
    expect(
      (await s.owner.json(`${base}?environment_id=${s.envId}&from=0&to=${100 * 86_400_000}`))
        .status,
    ).toBe(400);
    expect((await s.owner.json(`${base}?environment_id=${s.envId}&metrics=cpu,nope`)).status).toBe(
      400,
    );
    const other = await createProject(s.owner, s.workspaceId, { name: "Other" });
    expect((await s.owner.json(`${base}?environment_id=${other.environments[0]!.id}`)).status).toBe(
      404,
    );
  });

  it("records node usage from heartbeats and serves it", async () => {
    const s = await metricsStage();
    s.agent.send({
      type: "heartbeat",
      seq: 1,
      ts: Date.now(),
      observed_generation: 0,
      usage: {
        cpu_percent: 37.5,
        mem_used_bytes: 1024,
        mem_total_bytes: 4096,
        disk_used_bytes: 10,
        disk_total_bytes: 20,
        load1: 0.5,
      },
    });
    const series = await eventually(async () => {
      const res = await s.owner.json<{
        series: { metric: string; points: [number, number | null][] }[];
      }>(`/v1/workspaces/${s.workspaceId}/nodes/${s.joined.node_id}/metrics?metrics=cpu_percent`);
      const v = res.body.series[0]?.points.find(([, x]) => x !== null);
      return v ? res.body.series : undefined;
    });
    expect(series[0]!.points.find(([, x]) => x !== null)![1]).toBe(37.5);
    expect(
      (await s.owner.json(`/v1/workspaces/${s.workspaceId}/nodes/nod_missing/metrics`)).status,
    ).toBe(404);
  });

  it("prunes D1 samples after 48 hours", async () => {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO metrics_samples (index1, timestamp, blob1) VALUES ('svc_1', ?, 'container'), ('svc_1', ?, 'container')",
    )
      .bind(now - 49 * 3_600_000, now - 3_600_000)
      .run();
    const report = await runRetention(env, now);
    expect(report.metricsSamples).toBe(1);
    expect(await sampleCount()).toBe(1);
  });
});
