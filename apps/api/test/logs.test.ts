/**
 * Log ingest: redaction with each deployment's frozen secret set, NDJSON
 * chunks in R2 at the ADR key layout, the `log_chunks` index, and
 * newest-first paging across chunks.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMember, eventually } from "./helpers";
import {
  COMMIT_SHA,
  deploy,
  GIT_SERVICE,
  type Stage,
  settleDeployments,
  stage,
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
    // Plain, but it resolves to the shared secret, so it is redacted too.
    await s.owner.json(`/v1/services/${s.serviceId}/variables?environment_id=${s.envId}`, {
      method: "PUT",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: `${{…}}` is variable-reference syntax, not a template.
      json: { set: [{ key: "TOKEN", value: "${{shared.SHARED_TOKEN}}", tier: "plain" }] },
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

describe("redaction by deployment", () => {
  async function storedTexts(s: Stage, filter: { deploymentId: string } | { buildId: string }) {
    const [column, id] =
      "deploymentId" in filter
        ? ["deployment_id", filter.deploymentId]
        : ["build_id", filter.buildId];
    return eventually(async () => {
      await flush(s.joined.node_id);
      const rows = await env.DB.prepare(
        `SELECT r2_key FROM log_chunks WHERE ${column} = ? ORDER BY id`,
      )
        .bind(id)
        .all<{ r2_key: string }>();
      if (!rows.results.length) return undefined;
      const texts: string[] = [];
      for (const r of rows.results) {
        const text = await (await env.LOGS.get(r.r2_key))!.text();
        for (const line of text.trim().split("\n")) texts.push(JSON.parse(line).text);
      }
      return texts;
    });
  }

  const putSecret = (s: Stage, value: string) =>
    s.owner.json(`/v1/services/${s.serviceId}/variables?environment_id=${s.envId}`, {
      method: "PUT",
      json: { set: [{ key: "API_SECRET", value, tier: "secret" }], confirm_write_only: true },
    });

  it("keeps redacting a rotated-out secret, and its encodings, for the deployment that has it", async () => {
    const s = await stage();
    await putSecret(s, "old-secret-0123");
    const { id, workloadId } = await activeDeployment(s);
    // Rotated without a redeploy: the running replica still holds the old value.
    await putSecret(s, "new-secret-4567");
    sendLines(s, id, workloadId, [
      "using old-secret-0123",
      `b64 ${btoa("old-secret-0123")}`,
      `url ${encodeURIComponent("old-secret-0123")}`,
      `hex ${[...new TextEncoder().encode("old-secret-0123")].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
      "never had new-secret-4567",
      "short abc",
    ]);
    expect(await storedTexts(s, { deploymentId: id })).toEqual([
      "using [REDACTED]",
      "b64 [REDACTED]",
      "url [REDACTED]",
      "hex [REDACTED]",
      "never had new-secret-4567",
      "short abc",
    ]);
  });

  it("falls back to current secret variables for deployments from before frozen sets", async () => {
    const s = await stage();
    await putSecret(s, "legacy-secret-0123");
    const { id, workloadId } = await activeDeployment(s);
    await env.DB.prepare("UPDATE deployments SET secret_keys = NULL WHERE id = ?").bind(id).run();
    sendLines(s, id, workloadId, ["leak legacy-secret-0123"]);
    expect(await storedTexts(s, { deploymentId: id })).toEqual(["leak [REDACTED]"]);
  });

  it("redacts build output with the build's secrets and secret build args", async () => {
    const s = await stage(
      {
        ...GIT_SERVICE,
        config: {
          build: {
            builder: "dockerfile",
            build_args: { NPM_TOKEN: "npm-marked-secret-1" },
            secret_build_args: ["NPM_TOKEN"],
          },
        },
      },
      {
        buildLogs: [
          "#1 token build-secret-0123",
          "#2 npm npm-marked-secret-1",
          `#3 ${btoa("build-secret-0123")}`,
        ],
      },
    );
    await s.owner.json(`/v1/services/${s.serviceId}/variables?environment_id=${s.envId}`, {
      method: "PUT",
      json: {
        set: [
          {
            key: "BUILD_SECRET",
            value: "build-secret-0123",
            tier: "secret",
            available_at_build: true,
          },
        ],
        confirm_write_only: true,
      },
    });
    const d = await deploy(s.owner, s.serviceId, s.envId, { commit_sha: COMMIT_SHA });
    const active = await waitForStatus(s.owner, d.id, ["active"]);
    expect(await storedTexts(s, { buildId: active.build!.id })).toEqual([
      "#1 token [REDACTED]",
      "#2 npm [REDACTED]",
      "#3 [REDACTED]",
    ]);
  });
});
