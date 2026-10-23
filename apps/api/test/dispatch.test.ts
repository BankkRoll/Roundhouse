/**
 * The minute tick (`lib/dispatch.ts`) and the node Durable Object's Phase 2
 * gates: claimers run in order and in isolation, the `* * * * *` Cron
 * Trigger drives them, and frames and RPCs of protocol 5 never reach or
 * come from an older agent.
 */
import { createScheduledController, env } from "cloudflare:test";
import { DB_QUERY_PROTOCOL_VERSION, SEALED_ENV_PROTOCOL_VERSION } from "@roundhouse/protocol";
import { newId } from "@roundhouse/shared";
import { describe, expect, it } from "vitest";
import { FRAME_RATE_LIMITS } from "../src/durable/node-connection";
import worker from "../src/index";
import { MINUTE_CLAIMERS, MINUTE_CRON, runMinuteTick } from "../src/lib/dispatch";
import { eventually, install, joinNode } from "./helpers";
import { connectWorkloadAgent, createProject, createService } from "./pipeline-helpers";

describe("minute tick", () => {
  it("runs every claimer, isolating failures", async () => {
    const ran: string[] = [];
    const report = await runMinuteTick(env, Date.now(), [
      {
        name: "a",
        run: async () => {
          ran.push("a");
          return 2;
        },
      },
      {
        name: "b",
        run: async () => {
          throw new Error("boom");
        },
      },
      {
        name: "c",
        run: async () => {
          ran.push("c");
          return 0;
        },
      },
    ]);
    expect(ran).toEqual(["a", "c"]);
    expect(report).toEqual({ a: 2, b: "failed", c: 0 });
  });

  it("registers each claimer once and runs from the minute Cron Trigger", async () => {
    const names = MINUTE_CLAIMERS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("volume_deletions");
    expect(MINUTE_CRON).toBe("* * * * *");
    await expect(
      worker.scheduled(
        createScheduledController({ scheduledTime: Date.now(), cron: MINUTE_CRON }),
        env,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("node connection gates", () => {
  it("rate-limits every Phase 2 agent frame", () => {
    for (const type of [
      "volume_status",
      "db_query_result",
      "backup_parts_request",
      "backup_progress",
      "backup_result",
      "restore_result",
    ]) {
      expect(FRAME_RATE_LIMITS, type).toHaveProperty(type);
    }
  });

  it("neither accepts volume_status from nor sends db_query or volume_delete to a protocol 4 agent", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const agent = await connectWorkloadAgent(
      joined,
      {},
      { protocol_version: SEALED_ENV_PROTOCOL_VERSION },
    );
    const project = await createProject(owner, workspaceId);
    const created = await createService(owner, project.id);
    const volumeId = newId("volume");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO volumes (id, project_id, environment_id, service_id, mount_path, size_mb, node_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, '/data', 1024, ?, 'pending', ?, ?)`,
    )
      .bind(
        volumeId,
        project.id,
        project.environments[0]!.id,
        created.service.id,
        joined.node_id,
        now,
        now,
      )
      .run();
    agent.send({
      type: "volume_status",
      volumes: [
        { volume_id: volumeId, state: "ready", size_bytes: 1, used_bytes: 1, quota: "loop" },
      ],
    });
    // A heartbeat after it proves the frame was processed (and dropped).
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
      const n = await env.DB.prepare("SELECT cpu_percent FROM nodes WHERE id = ?")
        .bind(joined.node_id)
        .first<{ cpu_percent: number | null }>();
      return n?.cpu_percent === 1 ? true : undefined;
    });
    const row = await env.DB.prepare("SELECT status, reported_at FROM volumes WHERE id = ?")
      .bind(volumeId)
      .first<{ status: string; reported_at: number | null }>();
    expect(row).toEqual({ status: "pending", reported_at: null });

    const stub = env.NODE_CONNECTION.get(env.NODE_CONNECTION.idFromName(joined.node_id));
    expect(await stub.sendVolumeDelete(volumeId)).toEqual({
      sent: false,
      reason: "protocol_too_old",
    });
    const outcome = await stub.runQuery({
      request_id: "dbq_test",
      workload_id: "wl_test",
      engine: "postgres",
      credential_sealed: { v: 1, kid: "k", epk: "e", ct: "c" } as never,
      mode: "read",
      op: { type: "list_namespaces" },
      max_rows: 1,
      max_bytes: 1,
      timeout_ms: 100,
    });
    expect(outcome).toEqual({ ok: false, reason: "protocol_too_old" });
    expect(agent.received.some((m) => m.type === "db_query" || m.type === "volume_delete")).toBe(
      false,
    );
  });

  it("sends a signed volume_delete to a protocol 5 agent", async () => {
    const { owner, workspaceId } = await install();
    const joined = await joinNode(owner, workspaceId);
    const agent = await connectWorkloadAgent(
      joined,
      {},
      { protocol_version: DB_QUERY_PROTOCOL_VERSION },
    );
    const stub = env.NODE_CONNECTION.get(env.NODE_CONNECTION.idFromName(joined.node_id));
    expect(await stub.sendVolumeDelete("vol_01J0000000000000000000000A")).toEqual({ sent: true });
    const frame = await agent.waitFor(
      (m): m is Extract<typeof m, { type: "volume_delete" }> => m.type === "volume_delete",
    );
    expect(frame.volume_id).toBe("vol_01J0000000000000000000000A");
    expect(agent.rejected).toEqual([]);
  });
});
