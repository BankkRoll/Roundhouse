/**
 * The data browser (ADR 0004): `POST …/database/query` and `GET
 * …/database/schema` through the node Durable Object's `runQuery`, the
 * sealed `db-credential` box, RBAC, reauth, audit without values, the
 * per-user rate limit, and the control plane's own `provision_readonly`.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import {
  DB_QUERY_PROTOCOL_VERSION,
  type DbQuery,
  dbCredentialAad,
  type JoinResponse,
  openBox,
  SealedDbCredentialSchema,
} from "@roundhouse/protocol";
import { newId } from "@roundhouse/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_QUERIES_PER_USER_PER_S,
  PendingQueries,
  UserQueryLimiter,
} from "../src/durable/node/handlers/data";
import { AUDITED_STATEMENT_BYTES, auditedStatement } from "../src/routes/data-browser";
import {
  addMember,
  type Client,
  eventually,
  install,
  joinNode,
  NODE_ENCRYPTION_PRIVATE_KEY,
} from "./helpers";
import {
  connectWorkloadAgent,
  createProject,
  createService,
  deploy,
  type FakeWorkloadAgent,
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

// Test-only values; they only need to be recognisable in frames and audit rows.
const ADMIN_PASSWORD = "test-admin-pw-not-a-real-credential";
const RO_PASSWORD = "test-ro-pw-not-a-real-credential";

interface DataStage {
  owner: Client;
  workspaceId: string;
  projectId: string;
  envId: string;
  serviceId: string;
  volumeId: string;
  joined: JoinResponse;
  agent: FakeWorkloadAgent;
}

/**
 * A running Postgres-shaped service on a protocol 5 node: deployed as an
 * image, then marked a database with a volume on that node, so these tests
 * don't depend on how databases are created.
 */
async function dataStage(): Promise<DataStage> {
  const { owner, workspaceId } = await install();
  const joined = await joinNode(owner, workspaceId);
  const agent = await connectWorkloadAgent(
    joined,
    {},
    { protocol_version: DB_QUERY_PROTOCOL_VERSION },
  );
  const project = await createProject(owner, workspaceId);
  const envId = project.environments[0]!.id;
  const created = await createService(owner, project.id, {
    name: "db",
    source: { type: "image", image: "postgres:18-bookworm" },
  });
  const serviceId = created.service.id;
  const put = await owner.json(`/v1/services/${serviceId}/variables?environment_id=${envId}`, {
    method: "PUT",
    json: {
      set: [
        { key: "POSTGRES_USER", value: "postgres", tier: "plain" },
        { key: "POSTGRES_PASSWORD", value: ADMIN_PASSWORD, tier: "secret" },
        { key: "ROUNDHOUSE_RO_PASSWORD", value: RO_PASSWORD, tier: "secret" },
      ],
      confirm_write_only: true,
    },
  });
  expect(put.status).toBe(200);
  const d = await deploy(owner, serviceId, envId);
  await waitForStatus(owner, d.id, ["active"]);
  const volumeId = newId("volume");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE services SET kind = 'database', database_engine = 'postgres', database_version = '18' WHERE id = ?",
    ).bind(serviceId),
    env.DB.prepare(
      `INSERT INTO volumes (id, project_id, environment_id, service_id, mount_path, size_mb, node_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, '/var/lib/postgresql', 5120, ?, 'ready', ?, ?)`,
    ).bind(volumeId, project.id, envId, serviceId, joined.node_id, now, now),
  ]);
  return {
    owner,
    workspaceId,
    projectId: project.id,
    envId,
    serviceId,
    volumeId,
    joined,
    agent,
  };
}

const isQuery = (m: { type: string }): m is DbQuery => m.type === "db_query";

/** Waits for the next `db_query` not in `seen`. */
function nextQuery(s: DataStage, seen: Set<string>, timeoutMs = 5000): Promise<DbQuery> {
  return eventually(async () => {
    const q = s.agent.received.filter(isQuery).find((m) => !seen.has(m.request_id));
    if (q) seen.add(q.request_id);
    return q;
  }, timeoutMs);
}

/** Opens a query's credential box the way the agent does. */
async function openCredential(s: DataStage, q: DbQuery) {
  const pt = await openBox(
    NODE_ENCRYPTION_PRIVATE_KEY,
    q.credential_sealed,
    "db-credential",
    dbCredentialAad(s.joined.node_id, q.request_id),
  );
  return SealedDbCredentialSchema.parse(JSON.parse(new TextDecoder().decode(pt)));
}

function answer(s: DataStage, q: DbQuery, over: Record<string, unknown> = {}) {
  s.agent.send({
    type: "db_query_result",
    request_id: q.request_id,
    ok: true,
    columns: [{ name: "n", type: "int4" }],
    rows: [[1]],
    row_count: 1,
    truncated: false,
    duration_ms: 3,
    ...over,
  });
}

function query(c: Client, s: DataStage, body: Record<string, unknown>) {
  return c.json<Record<string, unknown>>(`/v1/services/${s.serviceId}/database/query`, {
    method: "POST",
    json: { environment_id: s.envId, ...body },
  });
}

async function auditRows(action: string) {
  const rows = await env.DB.prepare(
    "SELECT actor_id, metadata FROM audit_logs WHERE action = ? ORDER BY seq",
  )
    .bind(action)
    .all<{ actor_id: string | null; metadata: string }>();
  return rows.results.map((r) => ({ ...r, metadata: JSON.parse(r.metadata) }));
}

describe("query route", () => {
  it("seals the read-only credential to the node, returns the result and audits raw SQL without values", async () => {
    const s = await dataStage();
    const seen = new Set<string>();
    const pending = query(s.owner, s, {
      op: { type: "raw", statement: "SELECT $1::int AS n", params: ["42-param-value"] },
    });
    const q = await nextQuery(s, seen);
    expect(q.mode).toBe("read");
    expect(q.engine).toBe("postgres");
    expect(q.max_rows).toBe(100);
    expect(q.exp - q.iat).toBeLessThanOrEqual(60_000);
    expect(await openCredential(s, q)).toEqual({
      username: "roundhouse_ro",
      password: RO_PASSWORD,
    });
    // SECURITY: the box is bound to this node and request.
    await expect(
      openBox(
        NODE_ENCRYPTION_PRIVATE_KEY,
        q.credential_sealed,
        "db-credential",
        dbCredentialAad(s.joined.node_id, "dbq_other"),
      ),
    ).rejects.toThrow();
    const raw = s.agent.frames.find((f) => f.includes(q.request_id))!;
    expect(raw).not.toContain(RO_PASSWORD);
    expect(raw).not.toContain(ADMIN_PASSWORD);
    expect(raw).not.toContain('"credential"');
    answer(s, q, { rows: [[42]] });

    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      request_id: q.request_id,
      ok: true,
      rows: [[42]],
      row_count: 1,
    });

    const [audit] = await auditRows("database.query_executed");
    expect(audit!.metadata).toMatchObject({
      environment_id: s.envId,
      mode: "read",
      statement: "SELECT $1::int AS n",
      outcome: "ok",
      row_count: 1,
    });
    expect(audit!.metadata.statement_sha256).toMatch(/^[0-9a-f]{64}$/);
    const stored = JSON.stringify(audit);
    expect(stored).not.toContain("42-param-value");
    expect(stored).not.toContain(RO_PASSWORD);
    expect(stored).not.toContain("[[42]]");
  });

  it("does not audit structured browsing, and reports engine errors as results", async () => {
    const s = await dataStage();
    const seen = new Set<string>();
    const pending = query(s.owner, s, { op: { type: "list_tables", namespace: "public" } });
    const q = await nextQuery(s, seen);
    s.agent.send({
      type: "db_query_result",
      request_id: q.request_id,
      ok: false,
      error: "permission denied",
      duration_ms: 1,
    });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, error: "permission denied" });
    expect(await auditRows("database.query_executed")).toEqual([]);
  });

  it("runs writes as the admin, after data:write and a fresh session", async () => {
    const s = await dataStage();
    const seen = new Set<string>();
    const pending = query(s.owner, s, {
      mode: "write",
      op: { type: "raw", statement: "INSERT INTO t VALUES (1)" },
    });
    const q = await nextQuery(s, seen);
    expect(q.mode).toBe("write");
    expect(await openCredential(s, q)).toEqual({ username: "postgres", password: ADMIN_PASSWORD });
    answer(s, q, { columns: [], rows: [], row_count: 1 });
    expect((await pending).status).toBe(200);
    const [audit] = await auditRows("database.query_executed");
    expect(audit!.metadata).toMatchObject({ mode: "write", outcome: "ok" });

    // A session older than the reauth window can't write.
    await env.DB.prepare("UPDATE sessions SET created_at = ?, reauthenticated_at = NULL")
      .bind(Date.now() - 24 * 60 * 60 * 1000)
      .run();
    const stale = await query(s.owner, s, {
      mode: "write",
      op: { type: "raw", statement: "DELETE FROM t" },
    });
    expect(stale.status).toBe(403);
    expect(stale.body).toMatchObject({ error: { code: "reauth_required" } });
  });

  it("refuses viewers entirely and members' writes", async () => {
    const s = await dataStage();
    const viewer = await addMember(s.owner, s.workspaceId, "vic@example.com", "viewer");
    const member = await addMember(s.owner, s.workspaceId, "dev@example.com", "member");
    const read = { op: { type: "list_namespaces" } };
    expect((await query(viewer, s, read)).status).toBe(403);
    const schema = await viewer.json(
      `/v1/services/${s.serviceId}/database/schema?environment_id=${s.envId}`,
    );
    expect(schema.status).toBe(403);
    const write = await query(member, s, {
      mode: "write",
      op: { type: "raw", statement: "DROP TABLE t" },
    });
    expect(write.status).toBe(403);
    expect(s.agent.received.filter(isQuery)).toEqual([]);
  });

  it("never accepts provision_readonly from the API", async () => {
    const s = await dataStage();
    const res = await query(s.owner, s, { mode: "write", op: { type: "provision_readonly" } });
    expect(res.status).toBe(400);
    expect(s.agent.received.filter(isQuery)).toEqual([]);
  });

  it("rejects a service that is not a database, and caps max_rows and timeout_ms", async () => {
    const s = await dataStage();
    await env.DB.prepare("UPDATE services SET database_engine = NULL WHERE id = ?")
      .bind(s.serviceId)
      .run();
    expect((await query(s.owner, s, { op: { type: "list_namespaces" } })).status).toBe(409);
    expect(
      (await query(s.owner, s, { op: { type: "list_namespaces" }, max_rows: 1001 })).status,
    ).toBe(400);
    expect(
      (await query(s.owner, s, { op: { type: "list_namespaces" }, timeout_ms: 30_001 })).status,
    ).toBe(400);
  });

  it("limits each user to two queries a second", async () => {
    const s = await dataStage();
    const seen = new Set<string>();
    const op = { op: { type: "list_namespaces" } };
    const first = query(s.owner, s, op);
    const second = query(s.owner, s, op);
    const a = await nextQuery(s, seen);
    const b = await nextQuery(s, seen);
    const third = await query(s.owner, s, op);
    expect(third.status).toBe(429);
    answer(s, a);
    answer(s, b);
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  it("answers 503 when the node is offline", async () => {
    const s = await dataStage();
    s.agent.ws.close(1000, "bye");
    await s.agent.closed;
    const res = await eventually(async () => {
      const r = await query(s.owner, s, { op: { type: "list_namespaces" } });
      return r.status === 503 ? r : undefined;
    });
    expect(res.body).toMatchObject({ error: { code: "node_offline" } });
  });
});

describe("schema route", () => {
  it("lists namespaces read-only and audits the browser being opened", async () => {
    const s = await dataStage();
    const seen = new Set<string>();
    const pending = s.owner.json<Record<string, unknown>>(
      `/v1/services/${s.serviceId}/database/schema?environment_id=${s.envId}`,
    );
    const q = await nextQuery(s, seen);
    expect(q.op).toEqual({ type: "list_namespaces" });
    expect(q.mode).toBe("read");
    answer(s, q, { columns: [{ name: "name", type: "text" }], rows: [["public"]] });
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      engine: "postgres",
      version: "18",
      namespaces: { ok: true, rows: [["public"]] },
    });
    const audits = await auditRows("database.browser_opened");
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toEqual({ environment_id: s.envId });
  });
});

describe("read-only principal", () => {
  it("is provisioned by the control plane once the database reports in, as the admin", async () => {
    const s = await dataStage();
    const seen = new Set<string>();
    s.agent.send({
      type: "volume_status",
      volumes: [
        {
          volume_id: s.volumeId,
          state: "ready",
          size_bytes: 5120 * 2 ** 20,
          used_bytes: 2 ** 20,
          quota: "loop",
        },
      ],
    });
    const q = await nextQuery(s, seen);
    expect(q.op).toEqual({ type: "provision_readonly" });
    expect(q.mode).toBe("write");
    expect(await openCredential(s, q)).toEqual({ username: "postgres", password: ADMIN_PASSWORD });
    answer(s, q, { columns: [], rows: [], row_count: 0 });
    await eventually(async () => {
      const row = await env.DB.prepare("SELECT readonly_provisioned_at FROM volumes WHERE id = ?")
        .bind(s.volumeId)
        .first<{ readonly_provisioned_at: number | null }>();
      return row?.readonly_provisioned_at ? true : undefined;
    });

    // Once provisioned, a later report sends nothing more.
    s.agent.send({
      type: "volume_status",
      volumes: [
        {
          volume_id: s.volumeId,
          state: "ready",
          size_bytes: 5120 * 2 ** 20,
          used_bytes: 2 ** 20,
          quota: "loop",
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(s.agent.received.filter(isQuery)).toHaveLength(1);
  });

  it("stays unprovisioned when the agent reports a failure", async () => {
    const s = await dataStage();
    const seen = new Set<string>();
    s.agent.send({
      type: "volume_status",
      volumes: [
        { volume_id: s.volumeId, state: "ready", size_bytes: 1, used_bytes: 0, quota: "none" },
      ],
    });
    const q = await nextQuery(s, seen);
    s.agent.send({
      type: "db_query_result",
      request_id: q.request_id,
      ok: false,
      error: "the database system is starting up",
      duration_ms: 1,
    });
    await new Promise((r) => setTimeout(r, 300));
    const row = await env.DB.prepare("SELECT readonly_provisioned_at FROM volumes WHERE id = ?")
      .bind(s.volumeId)
      .first<{ readonly_provisioned_at: number | null }>();
    expect(row?.readonly_provisioned_at).toBeNull();
  });
});

describe("query plumbing", () => {
  it("correlates results by request ID and times out", async () => {
    const pending = new PendingQueries();
    const waiting = pending.wait("dbq_1", 1000);
    expect(
      pending.settle({
        type: "db_query_result",
        request_id: "dbq_2",
        ok: false,
        error: "x",
        duration_ms: 0,
      }),
    ).toBe(false);
    pending.settle({
      type: "db_query_result",
      request_id: "dbq_1",
      ok: false,
      error: "x",
      duration_ms: 0,
    });
    expect(await waiting).toMatchObject({ request_id: "dbq_1" });
    expect(await pending.wait("dbq_3", 10)).toBeNull();
    expect(pending.size).toBe(0);
  });

  it("limits starts per user per second", () => {
    const limiter = new UserQueryLimiter();
    for (let i = 0; i < MAX_QUERIES_PER_USER_PER_S; i++) {
      expect(limiter.admit("usr_1", 1000)).toBe(true);
    }
    expect(limiter.admit("usr_1", 1500)).toBe(false);
    expect(limiter.admit("usr_2", 1500)).toBe(true);
    expect(limiter.admit("usr_1", 2001)).toBe(true);
  });

  it("audits at most 2 KiB of a statement, cut on a character boundary", async () => {
    const long = `SELECT '${"é".repeat(3000)}'`;
    const { statement, statement_sha256 } = await auditedStatement({
      type: "raw",
      statement: long,
    });
    expect(new TextEncoder().encode(statement).byteLength).toBeLessThanOrEqual(
      AUDITED_STATEMENT_BYTES,
    );
    expect(statement).not.toContain("�");
    expect(statement_sha256).toMatch(/^[0-9a-f]{64}$/);
    const redis = await auditedStatement({ type: "raw", argv: ["SET", "k", "secret-value"] });
    expect(redis.statement).toBe("SET");
  });
});
