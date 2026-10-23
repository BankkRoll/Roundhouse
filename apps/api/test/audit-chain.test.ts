/**
 * Instance administration (ADR 0014 "Instance admin", "Audit log"):
 * instance admins, the instance-level audit log and its filters, the
 * append-only guards, and the hash chain with its checkpoints: sealing,
 * verification, and detection of edits, removals, truncation and a rewrite
 * that recomputes every hash.
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AuditChain } from "../src/durable/audit-chain";
import {
  AUDIT_CHAIN_NAME,
  auditEntryHash,
  GENESIS_HASH,
  RAW_AUDIT_COLUMNS,
  type RawAuditRow,
} from "../src/lib/audit-chain";
import { addMember, type Client, call, install } from "./helpers";

const chain = () => env.AUDIT_CHAIN.get(env.AUDIT_CHAIN.idFromName(AUDIT_CHAIN_NAME));

interface Verification {
  ok: boolean;
  checked: number;
  head_seq: number;
  head_hash: string | null;
  broken_at_seq: number | null;
  unsealed: number;
  checkpoints: number;
}

async function verify(owner: Client) {
  const res = await owner.json<Verification>("/v1/instance/audit-logs/verify");
  expect(res.status).toBe(200);
  return res.body;
}

/** Writes a few audited actions: workspace renames. */
async function activity(owner: Client, workspaceId: string, n = 3) {
  for (let i = 0; i < n; i++) {
    await owner.request(`/v1/workspaces/${workspaceId}`, {
      method: "PATCH",
      json: { name: `Name ${i}` },
    });
  }
}

/** Plays an attacker with raw database access: the guards come off first. */
async function tamper(sql: string, ...args: unknown[]) {
  await env.DB.batch([
    env.DB.prepare("DROP TRIGGER IF EXISTS audit_logs_no_delete"),
    env.DB.prepare("DROP TRIGGER IF EXISTS audit_logs_sealed_immutable"),
    env.DB.prepare("DROP TRIGGER IF EXISTS audit_logs_unsealed_content_fixed"),
  ]);
  await env.DB.prepare(sql)
    .bind(...args)
    .run();
}

async function rows(): Promise<RawAuditRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${RAW_AUDIT_COLUMNS} FROM audit_logs ORDER BY seq`,
  ).all<RawAuditRow>();
  return results;
}

describe("instance admins", () => {
  it("lists, grants and revokes the flag, never the last one, for instance admins only", async () => {
    const { owner, workspaceId, userId } = await install();
    const admin = await addMember(owner, workspaceId, "a@example.com", "admin");
    const { body } = await owner.json<{ members: { user_id: string; email: string }[] }>(
      `/v1/workspaces/${workspaceId}/members`,
    );
    const other = body.members.find((m) => m.email === "a@example.com")!.user_id;

    const list = await owner.json<{ admins: { user_id: string }[] }>("/v1/instance/admins");
    expect(list.body.admins.map((a) => a.user_id)).toEqual([userId]);
    // A workspace admin is not an instance admin.
    expect((await admin.request("/v1/instance/admins")).status).toBe(403);
    expect(
      (
        await admin.request(`/v1/instance/admins/${other}`, {
          method: "PUT",
          json: { instance_admin: true },
        })
      ).status,
    ).toBe(403);

    const last = await owner.json<{ error: { code: string } }>(`/v1/instance/admins/${userId}`, {
      method: "PUT",
      json: { instance_admin: false },
    });
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe("last_owner");

    const granted = await owner.json<{ user_id: string }>(`/v1/instance/admins/${other}`, {
      method: "PUT",
      json: { instance_admin: true },
    });
    expect(granted.body.user_id).toBe(other);
    expect((await admin.request("/v1/instance/admins")).status).toBe(200);
    expect(
      (
        await admin.request(`/v1/instance/admins/${userId}`, {
          method: "PUT",
          json: { instance_admin: false },
        })
      ).status,
    ).toBe(200);
    expect((await owner.request("/v1/instance/admins")).status).toBe(403);
    expect(
      (
        await owner.request("/v1/instance/admins/usr_nobody", {
          method: "PUT",
          json: { instance_admin: true },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin.request("/v1/instance/admins/usr_nobody", {
          method: "PUT",
          json: { instance_admin: true },
        })
      ).status,
    ).toBe(404);
  });
});

describe("instance audit log", () => {
  it("lists only instance-level entries, newest first, with filters and pages", async () => {
    const { owner, workspaceId, userId } = await install();
    await activity(owner, workspaceId, 2);
    await owner.request("/v1/instance/settings", { method: "PATCH", json: { mcp_enabled: true } });
    await owner.request("/v1/instance/settings", { method: "PATCH", json: { mcp_enabled: false } });

    type Page = {
      entries: {
        id: string;
        action: string;
        workspace_id: null;
        seq: number;
        actor_name: string;
      }[];
      next_cursor: string | null;
    };
    const all = await owner.json<Page>("/v1/instance/audit-logs");
    expect(all.body.entries.map((e) => e.action)).toEqual([
      "instance.settings_updated",
      "instance.settings_updated",
      "instance.setup_completed",
    ]);
    expect(all.body.entries.every((e) => e.workspace_id === null)).toBe(true);
    expect(all.body.entries[0]!.actor_name).toBe("Mara Okafor");

    const first = await owner.json<Page>("/v1/instance/audit-logs?limit=2");
    expect(first.body.entries).toHaveLength(2);
    const second = await owner.json<Page>(
      `/v1/instance/audit-logs?limit=2&cursor=${first.body.next_cursor}`,
    );
    expect(second.body.entries.map((e) => e.action)).toEqual(["instance.setup_completed"]);
    expect(second.body.next_cursor).toBeNull();

    const setup = await owner.json<Page>("/v1/instance/audit-logs?action=instance.setup_completed");
    expect(setup.body.entries).toHaveLength(1);
    const byActor = await owner.json<Page>(`/v1/instance/audit-logs?actor_id=${userId}`);
    expect(byActor.body.entries).toHaveLength(3);
    const future = await owner.json<Page>(`/v1/instance/audit-logs?since=${Date.now() + 60_000}`);
    expect(future.body.entries).toEqual([]);
    expect((await owner.request("/v1/instance/audit-logs?action=nope")).status).toBe(400);
  });

  it("is for instance admins only, never tokens", async () => {
    const { owner, workspaceId } = await install();
    const admin = await addMember(owner, workspaceId, "a@example.com", "admin");
    expect((await admin.request("/v1/instance/audit-logs")).status).toBe(403);
    expect((await admin.request("/v1/instance/audit-logs/verify")).status).toBe(403);
    const { body } = await owner.json<{ secret: string }>(`/v1/workspaces/${workspaceId}/tokens`, {
      method: "POST",
      json: { name: "ci", scopes: ["audit:read"], expires_in_days: 1 },
    });
    const res = await call("/v1/instance/audit-logs", {
      headers: { authorization: `Bearer ${body.secret}` },
    });
    expect(res.status).toBe(403);
  });
});

describe("append-only guards", () => {
  it("refuse deleting entries and changing sealed ones, and content before sealing", async () => {
    const { owner, workspaceId } = await install();
    await activity(owner, workspaceId, 1);
    await expect(env.DB.prepare("DELETE FROM audit_logs").run()).rejects.toThrow(/append-only/);
    await expect(
      env.DB.prepare("UPDATE audit_logs SET action = 'workspace.renamed'").run(),
    ).rejects.toThrow(/immutable/);
    await chain().seal();
    await expect(env.DB.prepare("UPDATE audit_logs SET hash = 'x'").run()).rejects.toThrow(
      /immutable/,
    );
  });
});

describe("hash chain", () => {
  it("seals entries in seq order from the genesis hash, as ADR 0014 defines the hash", async () => {
    const { owner, workspaceId } = await install();
    await activity(owner, workspaceId);
    const result = await chain().seal();
    const sealed = await rows();
    expect(result).toMatchObject({ sealed: sealed.length, headSeq: sealed.at(-1)!.seq });
    expect(sealed[0]!.prev_hash).toBe(GENESIS_HASH);
    let prev = GENESIS_HASH;
    for (const row of sealed) {
      expect(row.prev_hash).toBe(prev);
      const canonical = JSON.stringify([
        "roundhouse-audit:v1",
        row.seq,
        prev,
        row.id,
        row.workspace_id,
        row.actor_type,
        row.actor_id,
        row.action,
        row.target_type,
        row.target_id,
        row.metadata,
        row.ip,
        row.created_at,
      ]);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      expect(row.hash).toBe(hex);
      expect(await auditEntryHash(row, prev)).toBe(hex);
      prev = row.hash!;
    }
    // Nothing left: a second pass seals nothing and keeps the head.
    expect(await chain().seal()).toMatchObject({ sealed: 0, headSeq: result.headSeq });
  });

  it("seals concurrent passes into one unforked chain", async () => {
    const { owner, workspaceId } = await install();
    await activity(owner, workspaceId, 5);
    const results = await Promise.all([chain().seal(), chain().seal(), chain().seal()]);
    expect(results.reduce((n, r) => n + r.sealed, 0)).toBe((await rows()).length);
    expect((await verify(owner)).ok).toBe(true);
  });

  it("verifies an intact chain, sealing what is pending first", async () => {
    const { owner, workspaceId } = await install();
    await activity(owner, workspaceId);
    const report = await verify(owner);
    const all = await rows();
    expect(report).toEqual({
      ok: true,
      checked: all.length,
      head_seq: all.at(-1)!.seq,
      head_hash: all.at(-1)!.hash,
      broken_at_seq: null,
      unsealed: 0,
      // The first checkpoint and the head are the same entry.
      checkpoints: 1,
    });
  });

  it("finds an edited entry", async () => {
    const { owner, workspaceId } = await install();
    await activity(owner, workspaceId);
    await chain().seal();
    const target = (await rows())[2]!;
    await tamper("UPDATE audit_logs SET metadata = ? WHERE seq = ?", '{"name":"Evil"}', target.seq);
    const report = await verify(owner);
    expect(report).toMatchObject({ ok: false, broken_at_seq: target.seq });
  });

  it("finds a removed entry", async () => {
    const { owner, workspaceId } = await install();
    await activity(owner, workspaceId, 4);
    await chain().seal();
    const all = await rows();
    await tamper("DELETE FROM audit_logs WHERE seq = ?", all[1]!.seq);
    expect(await verify(owner)).toMatchObject({ ok: false, broken_at_seq: all[2]!.seq });
  });

  it("finds a cut-off end", async () => {
    const { owner: owner2, workspaceId: ws2 } = await install();
    await activity(owner2, ws2, 4);
    await chain().seal();
    const all2 = await rows();
    // Removing the newest entries leaves a valid-looking shorter chain; the
    // head recorded outside the database gives it away.
    await tamper("DELETE FROM audit_logs WHERE seq >= ?", all2.at(-2)!.seq);
    expect(await verify(owner2)).toMatchObject({ ok: false, broken_at_seq: all2.at(-2)!.seq });
  });

  it("finds a rewrite that recomputes every later hash", async () => {
    const { owner, workspaceId } = await install();
    await activity(owner, workspaceId, 4);
    await chain().seal();
    const all = await rows();
    const from = all[1]!;
    await tamper("UPDATE audit_logs SET metadata = ? WHERE seq = ?", '{"name":"Evil"}', from.seq);
    // Re-hash from the edit onwards, so the chain itself is self-consistent.
    let prev = all[0]!.hash!;
    for (const row of await rows()) {
      if (row.seq < from.seq) continue;
      const hash = await auditEntryHash(row, prev);
      await env.DB.prepare("UPDATE audit_logs SET prev_hash = ?, hash = ? WHERE seq = ?")
        .bind(prev, hash, row.seq)
        .run();
      prev = hash;
    }
    const report = await verify(owner);
    expect(report.ok).toBe(false);
    // The checkpoint at the head no longer matches.
    expect(report.broken_at_seq).toBe(all.at(-1)!.seq);
  });

  it("finds an entry sealed out of order and refuses to seal below the head", async () => {
    const { owner, workspaceId } = await install();
    await activity(owner, workspaceId);
    await chain().seal();
    const all = await rows();
    await tamper("UPDATE audit_logs SET hash = NULL WHERE seq = ?", all[1]!.seq);
    expect(await chain().seal()).toMatchObject({ sealed: 0 });
    expect(await verify(owner)).toMatchObject({ ok: false, broken_at_seq: all[2]!.seq });
  });

  it("keeps a checkpoint per interval and a head outside the database", async () => {
    const { owner, workspaceId } = await install();
    await activity(owner, workspaceId, 2);
    await chain().seal();
    await activity(owner, workspaceId, 2);
    await chain().seal();
    const state = await chain().state();
    const all = await rows();
    expect(state.head).toMatchObject({ seq: all.at(-1)!.seq, hash: all.at(-1)!.hash });
    // The second pass is well inside the interval: still one checkpoint.
    expect(state.checkpoints).toHaveLength(1);
    await runInDurableObject(chain(), async (instance: AuditChain, ctx) => {
      expect(instance).toBeInstanceOf(AuditChain);
      const [cp] = (await ctx.storage.list<{ at: number }>({ prefix: "checkpoint:" })).entries();
      await ctx.storage.put(cp![0], { ...cp![1], at: 0 });
    });
    await activity(owner, workspaceId, 1);
    await chain().seal();
    expect((await chain().state()).checkpoints).toHaveLength(2);
    expect((await verify(owner)).ok).toBe(true);
  });
});
