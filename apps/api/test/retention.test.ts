/**
 * The hourly retention job, driven by time travel (a run's `now` is the Cron
 * Trigger's scheduled time): expired log chunks leave R2 and D1 according to
 * `log_retention_days`, in bounded batches; delivery IDs, join tokens,
 * sessions, invites, verifications and redeemed nonces are pruned; nothing
 * live is touched.
 */
import { createScheduledController, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { runRetention } from "../src/lib/retention";
import { install } from "./helpers";
import { createProject } from "./pipeline-helpers";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
  return row!.n;
}

/** Stores a chunk in R2 and indexes it, with its newest line `ageDays` before {@link NOW}. */
async function chunk(projectId: string, name: string, ageDays: number) {
  const key = `logs/${projectId}/${name}.ndjson`;
  await env.LOGS.put(key, '{"ts":0,"stream":"stdout","text":"x"}\n');
  const last = NOW - ageDays * DAY;
  await env.DB.prepare(
    "INSERT INTO log_chunks (id, project_id, r2_key, first_ts, last_ts, line_count, bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, 40, ?, ?)",
  )
    .bind(`log_${name}`, projectId, key, last - 1000, last, last, last)
    .run();
  return key;
}

describe("log retention", () => {
  it("deletes chunks older than the default 7 days from R2 and D1, and keeps newer ones", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const old = await chunk(p.id, "old", 8);
    const edge = await chunk(p.id, "edge", 6.9);
    const fresh = await chunk(p.id, "fresh", 0.1);

    const report = await runRetention(env, NOW);
    expect(report.logChunks).toBe(1);
    expect(await env.LOGS.head(old)).toBeNull();
    expect(await env.LOGS.head(edge)).not.toBeNull();
    expect(await env.LOGS.head(fresh)).not.toBeNull();
    expect(await count("log_chunks")).toBe(2);

    // A week later the rest has aged out too.
    const later = await runRetention(env, NOW + 7 * DAY);
    expect(later.logChunks).toBe(2);
    expect(await count("log_chunks")).toBe(0);
    expect((await env.LOGS.list({ prefix: `logs/${p.id}/` })).objects).toEqual([]);
  });

  it("follows the owner's log_retention_days setting", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    await chunk(p.id, "two-days", 2);
    await chunk(p.id, "half-day", 0.5);
    const res = await owner.json("/v1/instance/settings", {
      method: "PATCH",
      json: { log_retention_days: 1 },
    });
    expect(res.status).toBe(200);
    expect((await runRetention(env, NOW)).logChunks).toBe(1);
    expect(await count("log_chunks")).toBe(1);
  });

  it("works in bounded batches and leaves the rest for the next run", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    for (let i = 0; i < 5; i++) await chunk(p.id, `c${i}`, 10 + i);
    const limits = { logChunkBatch: 2, rowBatch: 2, maxBatches: 2 };
    expect((await runRetention(env, NOW, limits)).logChunks).toBe(4);
    expect(await count("log_chunks")).toBe(1);
    // The oldest go first.
    const left = await env.DB.prepare("SELECT id FROM log_chunks").first<{ id: string }>();
    expect(left?.id).toBe("log_c0");
    expect((await runRetention(env, NOW, limits)).logChunks).toBe(1);
    expect(await count("log_chunks")).toBe(0);
  });

  it("keeps the index row when R2 fails, so the next run retries it", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    const key = await chunk(p.id, "stuck", 30);
    const failing = {
      ...env,
      LOGS: {
        delete: async () => {
          throw new Error("R2 unavailable");
        },
      } as unknown as R2Bucket,
    };
    await expect(runRetention(failing, NOW)).rejects.toThrow("R2 unavailable");
    expect(await count("log_chunks")).toBe(1);
    expect((await runRetention(env, NOW)).logChunks).toBe(1);
    expect(await env.LOGS.head(key)).toBeNull();
  });
});

describe("expired records", () => {
  it("prunes delivery IDs, join tokens, sessions, invites, verifications and nonces", async () => {
    const { owner, workspaceId, userId } = await install();
    const ins = (sql: string, ...args: unknown[]) =>
      env.DB.prepare(sql)
        .bind(...args)
        .run();
    const at = (offsetDays: number) => NOW + offsetDays * DAY;

    await ins(
      "INSERT INTO github_deliveries (id, event, created_at, updated_at) VALUES ('old', 'push', ?, ?), ('new', 'push', ?, ?)",
      at(-15),
      at(-15),
      at(-1),
      at(-1),
    );
    await ins(
      "INSERT INTO node_join_tokens (id, workspace_id, token_hash, expires_at, created_at, updated_at) VALUES ('njt_old', ?, 'h1', ?, 0, 0), ('njt_grace', ?, 'h2', ?, 0, 0), ('njt_live', ?, 'h3', ?, 0, 0)",
      workspaceId,
      at(-8),
      workspaceId,
      at(-1),
      workspaceId,
      at(1),
    );
    await ins(
      "INSERT INTO invites (id, workspace_id, email, role, token_hash, expires_at, created_at, updated_at) VALUES ('inv_old', ?, 'a@x.io', 'viewer', 'i1', ?, 0, 0), ('inv_live', ?, 'b@x.io', 'viewer', 'i2', ?, 0, 0)",
      workspaceId,
      at(-8),
      workspaceId,
      at(3),
    );
    await ins(
      "INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at) VALUES ('ses_old', ?, 't-old', ?, 0, 0)",
      userId,
      at(-0.01),
    );
    // The owner's real session from install() expires in a week: kept.
    await ins("UPDATE sessions SET expires_at = ? WHERE id <> 'ses_old'", at(6));
    await ins(
      "INSERT INTO verifications (id, identifier, value, expires_at, created_at, updated_at) VALUES ('ver_old', 'x', 'y', ?, 0, 0), ('ver_live', 'x', 'z', ?, 0, 0)",
      at(-1),
      at(1),
    );
    await ins(
      "INSERT INTO consumed_nonces (id, expires_at, created_at, updated_at) VALUES ('github-install:old', ?, 0, 0), ('github-install:live', ?, 0, 0)",
      at(-1),
      at(1),
    );

    const report = await runRetention(env, NOW);
    expect(report).toEqual({
      logChunks: 0,
      githubDeliveries: 1,
      joinTokens: 1,
      sessions: 1,
      invites: 1,
      verifications: 1,
      nonces: 1,
    });
    const ids = async (table: string) =>
      (
        await env.DB.prepare(`SELECT id FROM ${table} ORDER BY id`).all<{ id: string }>()
      ).results.map((r) => r.id);
    expect(await ids("github_deliveries")).toEqual(["new"]);
    expect(await ids("node_join_tokens")).toEqual(["njt_grace", "njt_live"]);
    expect(await ids("invites")).toEqual(["inv_live"]);
    expect(await ids("verifications")).toEqual(["ver_live"]);
    expect(await ids("consumed_nonces")).toEqual(["github-install:live"]);
    expect(await ids("sessions")).not.toContain("ses_old");
    expect(await count("sessions")).toBe(1);
    expect((await owner.json("/v1/me")).status).toBe(200);
  });

  it("runs from the Cron Trigger with the scheduled time as now", async () => {
    const { owner, workspaceId } = await install();
    const p = await createProject(owner, workspaceId);
    await chunk(p.id, "cron", 1);
    const tick = (scheduledTime: number) =>
      worker.scheduled(createScheduledController({ scheduledTime, cron: "17 * * * *" }), env);
    // Today it's a day old: kept. Scheduled a week ahead: deleted.
    await tick(NOW);
    expect(await count("log_chunks")).toBe(1);
    await tick(NOW + 7 * DAY);
    expect(await count("log_chunks")).toBe(0);
  });
});
