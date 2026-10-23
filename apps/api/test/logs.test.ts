/**
 * Log ingest: secret redaction, NDJSON chunks in R2 at the ADR key layout,
 * the `log_chunks` index, and newest-first paging across chunks.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { redact, redactionList } from "../src/lib/logs";
import { addMember, eventually } from "./helpers";
import {
  COMMIT_SHA,
  deploy,
  GIT_SERVICE,
  type Stage,
  stage,
  waitForStatus,
} from "./pipeline-helpers";

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
beforeEach(async () => {
  introspector = await introspectWorkflow(env.DEPLOY_WORKFLOW);
});
afterEach(async () => {
  await introspector?.dispose();
});

interface Page {
  lines: { ts: number; stream: string; text: string; workload_id?: string }[];
  next_cursor: string | null;
}

const flush = (nodeId: string) =>
  env.NODE_CONNECTION.get(env.NODE_CONNECTION.idFromName(nodeId)).flushLogs();

async function activeDeployment(s: Stage) {
  const d = await deploy(s.owner, s.serviceId, s.envId);
  const active = await waitForStatus(s.owner, d.id, ["active"]);
  return { id: d.id, workloadId: active.placements![0]!.workload_id };
}

function sendLines(
  s: Stage,
  deploymentId: string,
  workloadId: string,
  texts: string[],
  ts0 = Date.now(),
) {
  s.agent.send({
    type: "logs",
    source: { type: "runtime", workload_id: workloadId, deployment_id: deploymentId },
    lines: texts.map((text, i) => ({ ts: ts0 + i, stream: "stdout", text })),
  });
}

async function chunkCount(deploymentId: string) {
  const row = await env.DB.prepare("SELECT count(*) AS n FROM log_chunks WHERE deployment_id = ?")
    .bind(deploymentId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("redaction", () => {
  it("replaces secrets longest first and ignores trivially short ones", () => {
    const list = redactionList(["abc", "hunter22", "hunter2244", "hunter22"]);
    expect(list).toEqual(["hunter2244", "hunter22"]);
    expect(redact("pw=hunter2244 old=hunter22 abc", list)).toBe("pw=[REDACTED] old=[REDACTED] abc");
  });
});

describe("runtime logs", () => {
  it("redacts secrets, stores NDJSON chunks in R2 and indexes them", async () => {
    const s = await stage();
    await s.owner.json(`/v1/services/${s.serviceId}/variables?environment_id=${s.envId}`, {
      method: "PUT",
      json: {
        set: [{ key: "DB_PASSWORD", value: "correct-horse-42", tier: "secret" }],
        confirm_write_only: true,
      },
    });
    await s.owner.json(`/v1/projects/${s.project.id}/variables?environment_id=${s.envId}`, {
      method: "PUT",
      json: {
        set: [{ key: "SHARED_TOKEN", value: "tok-shared-777", tier: "secret" }],
        confirm_write_only: true,
      },
    });
    const { id, workloadId } = await activeDeployment(s);
    const ts = Date.UTC(2026, 9, 22, 13, 5, 0);
    sendLines(
      s,
      id,
      workloadId,
      ["connecting with correct-horse-42", "token tok-shared-777 ok", "plain line"],
      ts,
    );
    await eventually(async () => {
      await flush(s.joined.node_id);
      return (await chunkCount(id)) > 0 ? true : undefined;
    });

    const chunk = await env.DB.prepare(
      "SELECT r2_key, line_count, first_ts, last_ts, project_id, service_id FROM log_chunks WHERE deployment_id = ?",
    )
      .bind(id)
      .first<{
        r2_key: string;
        line_count: number;
        first_ts: number;
        last_ts: number;
        project_id: string;
        service_id: string;
      }>();
    expect(chunk).toMatchObject({
      line_count: 3,
      first_ts: ts,
      last_ts: ts + 2,
      project_id: s.project.id,
      service_id: s.serviceId,
    });
    expect(chunk!.r2_key).toMatch(
      new RegExp(`^logs/${s.project.id}/${s.serviceId}/2026/10/22/13/log_[0-9A-Z]+\\.ndjson$`),
    );
    const object = await env.LOGS.get(chunk!.r2_key);
    const stored = (await object!.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(stored.map((l) => l.text)).toEqual([
      "connecting with [REDACTED]",
      "token [REDACTED] ok",
      "plain line",
    ]);
    expect(stored[0]).toMatchObject({ stream: "stdout", workload_id: workloadId });

    const page = await s.owner.json<Page>(`/v1/deployments/${id}/logs`);
    expect(page.body.lines.map((l) => l.text)).toEqual(stored.map((l) => l.text));
    expect(page.body.next_cursor).toBeNull();
  });

  it("pages newest first across chunks, each page in order", async () => {
    const s = await stage();
    const { id, workloadId } = await activeDeployment(s);
    sendLines(s, id, workloadId, ["a1", "a2"]);
    await eventually(async () => {
      await flush(s.joined.node_id);
      return (await chunkCount(id)) === 1 ? true : undefined;
    });
    sendLines(s, id, workloadId, ["b1", "b2", "b3"]);
    await eventually(async () => {
      await flush(s.joined.node_id);
      return (await chunkCount(id)) === 2 ? true : undefined;
    });

    const texts: string[][] = [];
    let cursor: string | null = null;
    do {
      const res: { body: Page } = await s.owner.json<Page>(
        `/v1/deployments/${id}/logs?limit=2${cursor ? `&cursor=${cursor}` : ""}`,
      );
      texts.push(res.body.lines.map((l) => l.text));
      cursor = res.body.next_cursor;
    } while (cursor);
    expect(texts).toEqual([["b2", "b3"], ["a2", "b1"], ["a1"]]);

    expect((await s.owner.json(`/v1/deployments/${id}/logs?cursor=garbage`)).status).toBe(400);
    expect((await s.owner.json(`/v1/deployments/${id}/logs?limit=5000`)).status).toBe(400);
  });

  it("drops lines for replicas this node doesn't run", async () => {
    const s = await stage();
    const { id } = await activeDeployment(s);
    sendLines(s, id, "wl_01NOTOURS", ["spoofed"]);
    await new Promise((r) => setTimeout(r, 200));
    await flush(s.joined.node_id);
    expect(await chunkCount(id)).toBe(0);
  });

  it("is readable by viewers and hidden from other workspaces", async () => {
    const s = await stage();
    const { id } = await activeDeployment(s);
    const viewer = await addMember(s.owner, s.workspaceId, "v@example.com", "viewer");
    expect((await viewer.json(`/v1/deployments/${id}/logs`)).status).toBe(200);
    const ws2 = await s.owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Other" },
    });
    const outsider = await addMember(s.owner, ws2.body.id, "o@example.com", "admin");
    expect((await outsider.json(`/v1/deployments/${id}/logs`)).status).toBe(404);
  });
});

describe("build logs", () => {
  it("stores and pages a build's output", async () => {
    const s = await stage(GIT_SERVICE, { buildLogs: ["#1 resolve", "#2 build", "#3 push"] });
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    const active = await waitForStatus(s.owner, d.id, ["active"]);
    const buildId = active.build!.id;
    await eventually(async () => {
      await flush(s.joined.node_id);
      const row = await env.DB.prepare(
        "SELECT sum(line_count) AS n FROM log_chunks WHERE build_id = ?",
      )
        .bind(buildId)
        .first<{ n: number | null }>();
      return row?.n === 3 ? true : undefined;
    });
    const page = await s.owner.json<Page>(`/v1/builds/${buildId}/logs`);
    expect(page.status).toBe(200);
    expect(page.body.lines.map((l) => l.text)).toEqual(["#1 resolve", "#2 build", "#3 push"]);
    expect(page.body.lines.every((l) => l.workload_id === undefined)).toBe(true);
    expect((await s.owner.json("/v1/builds/bld_missing/logs")).status).toBe(404);
  });
});
