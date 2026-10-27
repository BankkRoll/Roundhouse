/**
 * Rotating a database's credentials (ADR 0004): `set_password` through the
 * query channel with the new password only in the sealed box, read-only
 * user first and admin last, the new passwords stored as secret variables
 * through a change set that redeploys the database and its dependents,
 * resuming an interrupted rotation, the admin retry with the new password,
 * the lease, RBAC, reauth and audit without values.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { createDb, variables } from "@roundhouse/db";
import type { DbQuery, SealedDbCredential } from "@roundhouse/protocol";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rotationSecretsAad } from "../src/lib/credential-rotations";
import { sealWith } from "../src/lib/crypto";
import { setS3Transport } from "../src/lib/s3";
import { openVariable, projectKey } from "../src/lib/variables";
import { allAuditText, auditRows, type QueryAnswer } from "./backups-helpers";
import { type DatabaseStage, databaseStage, FULL_CAPABILITIES } from "./data-stage";
import { addMember, eventually } from "./helpers";
import { settleDeployments, waitForStatus } from "./pipeline-helpers";

let introspector: { dispose(): Promise<void> } | undefined;
beforeEach(async () => {
  introspector = await introspectWorkflow(env.DEPLOY_WORKFLOW);
});
afterEach(async () => {
  await settleDeployments();
  await introspector?.dispose();
  setS3Transport();
});

interface RotationBody {
  id: string;
  status: string;
  principals: string[];
  applied: string[];
  change_set_id: string | null;
  deployment_ids: string[];
  error: string | { code: string; message: string } | null;
}

const rotate = (s: DatabaseStage, body: Record<string, unknown> = {}) =>
  s.owner.json<RotationBody>(`/v1/services/${s.serviceId}/database/rotate-credentials`, {
    method: "POST",
    json: { environment_id: s.envId, confirm: s.serviceSlug, ...body },
  });

async function secret(s: DatabaseStage, key: string): Promise<string> {
  const db = createDb(env.DB);
  const [row] = await db
    .select()
    .from(variables)
    .where(
      and(
        eq(variables.serviceId, s.serviceId),
        eq(variables.environmentId, s.envId),
        eq(variables.key, key),
      ),
    );
  return openVariable(await projectKey(db, env, s.project.id), row!);
}

/** The `set_password` queries the database's node received, with the user each changes. */
const setPasswords = (s: DatabaseStage) =>
  s.home.agent.queries.flatMap((q) =>
    q.query.op.type === "set_password" ? [{ ...q, user: q.query.op.user }] : [],
  );

/** Waits until the database's read-only principal has been provisioned. */
function provisioned(s: DatabaseStage) {
  return eventually(async () => {
    const row = await env.DB.prepare(
      "SELECT readonly_provisioned_at AS at FROM volumes WHERE id = ?",
    )
      .bind(s.volumeId)
      .first<{ at: number | null }>();
    return row?.at ? true : undefined;
  }, 8000);
}

describe("rotating credentials", () => {
  it("sets each password through the sealed box, stores them, and redeploys", async () => {
    const s = await databaseStage();
    await provisioned(s);
    const oldAdmin = await secret(s, "POSTGRES_PASSWORD");
    const oldRo = await secret(s, "ROUNDHOUSE_RO_PASSWORD");

    const res = await rotate(s);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "succeeded",
      principals: ["readonly", "admin"],
      applied: ["readonly", "admin"],
      error: null,
    });
    expect(res.body.change_set_id).toBeTruthy();
    expect(res.body.deployment_ids.length).toBeGreaterThanOrEqual(1);

    const sent = setPasswords(s);
    expect(sent.map((q) => q.query.op)).toEqual([
      { type: "set_password", user: "roundhouse_ro" },
      { type: "set_password", user: "postgres" },
    ]);
    const newAdmin = await secret(s, "POSTGRES_PASSWORD");
    const newRo = await secret(s, "ROUNDHOUSE_RO_PASSWORD");
    expect(newAdmin).not.toBe(oldAdmin);
    expect(newRo).not.toBe(oldRo);
    expect(newAdmin).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Both changes connect as the admin with the password the engine still has.
    expect(sent[0]!.credential).toEqual({
      username: "postgres",
      password: oldAdmin,
      new_password: newRo,
    });
    expect(sent[1]!.credential).toEqual({
      username: "postgres",
      password: oldAdmin,
      new_password: newAdmin,
    });
    for (const q of sent) {
      expect(q.query.mode).toBe("write");
      expect(JSON.stringify(q.query)).not.toContain(newAdmin);
      expect(JSON.stringify(q.query)).not.toContain(newRo);
    }
    const tiers = await env.DB.prepare(
      "SELECT key, tier, version FROM variables WHERE service_id = ? AND key IN ('POSTGRES_PASSWORD', 'ROUNDHOUSE_RO_PASSWORD')",
    )
      .bind(s.serviceId)
      .all<{ key: string; tier: string; version: number }>();
    for (const t of tiers.results) expect(t).toMatchObject({ tier: "secret", version: 2 });

    // The database itself is redeployed with the new environment.
    const redeploy = res.body.deployment_ids[0]!;
    await waitForStatus(s.owner, redeploy, ["active"]);
    const row = await env.DB.prepare(
      "SELECT secrets_sealed, finished_at FROM credential_rotations WHERE id = ?",
    )
      .bind(res.body.id)
      .first<{ secrets_sealed: string | null; finished_at: number | null }>();
    expect(row).toMatchObject({ secrets_sealed: null });
    expect(row?.finished_at).toBeTruthy();

    const [audit] = await auditRows("database.credentials_rotated");
    expect(audit!.metadata).toMatchObject({
      rotation_id: res.body.id,
      applied: ["readonly", "admin"],
      change_set_id: res.body.change_set_id,
    });
    const text = await allAuditText();
    for (const value of [oldAdmin, newAdmin, oldRo, newRo]) expect(text).not.toContain(value);

    const list = await s.owner.json<{ rotations: RotationBody[] }>(
      `/v1/services/${s.serviceId}/database/credential-rotations?environment_id=${s.envId}`,
    );
    expect(list.body.rotations.map((r) => r.id)).toEqual([res.body.id]);
    expect(JSON.stringify(list.body)).not.toContain(newAdmin);
  }, 90_000);

  it("rotates MySQL's application user between the read-only user and the admin", async () => {
    const s = await databaseStage({ engine: "mysql" });
    await provisioned(s);
    const res = await rotate(s);
    expect(res.body).toMatchObject({
      status: "succeeded",
      applied: ["readonly", "app", "admin"],
    });
    expect(setPasswords(s).map((q) => q.query.op)).toEqual([
      { type: "set_password", user: "roundhouse_ro" },
      { type: "set_password", user: "app" },
      { type: "set_password", user: "root" },
    ]);
    const only = await rotate(s, { principals: ["app"] });
    expect(only.body).toMatchObject({ status: "succeeded", applied: ["app"] });
  }, 90_000);

  it("stores what the engine accepted when it refuses a later change", async () => {
    const s = await databaseStage({
      behaviour: {
        backup: "ok",
        restore: "ok",
        workloads: "healthy",
        query: (q: DbQuery): QueryAnswer =>
          q.op.type === "set_password" && q.op.user === "postgres" ? "fail" : "ok",
        queryError: "permission denied to alter role",
      },
    });
    await provisioned(s);
    const oldAdmin = await secret(s, "POSTGRES_PASSWORD");
    const res = await rotate(s);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "failed", applied: ["readonly"] });
    expect(res.body.error).toMatch(/^admin: permission denied/);
    expect(await secret(s, "POSTGRES_PASSWORD")).toBe(oldAdmin);
    const ro = await env.DB.prepare(
      "SELECT version FROM variables WHERE service_id = ? AND key = 'ROUNDHOUSE_RO_PASSWORD'",
    )
      .bind(s.serviceId)
      .first<{ version: number }>();
    expect(ro?.version).toBe(2);
    // The admin change was retried with the new password, in case it had landed.
    expect(setPasswords(s).filter((q) => q.user === "postgres")).toHaveLength(2);
    expect(await auditRows("database.credentials_rotation_failed")).toHaveLength(1);
  }, 90_000);

  it("finishes an interrupted rotation, signing in with the new admin password when needed", async () => {
    let engineAdmin = "";
    const s = await databaseStage({
      behaviour: {
        backup: "ok",
        restore: "ok",
        workloads: "healthy",
        query: (q: DbQuery, c: SealedDbCredential): QueryAnswer =>
          q.op.type !== "set_password" || !engineAdmin || c.password === engineAdmin
            ? "ok"
            : "fail",
        queryError: "password authentication failed",
      },
    });
    await provisioned(s);
    const db = createDb(env.DB);
    const dek = await projectKey(db, env, s.project.id);
    // An earlier call set both passwords in the engine, then died before storing them.
    const secrets = {
      readonly: "rotation-test-ro-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      admin: "rotation-test-admin-aaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    engineAdmin = secrets.admin;
    const id = "rot_01TESTROTATION000000000000";
    const stale = Date.now() - 10 * 60 * 1000;
    await env.DB.prepare(
      `INSERT INTO credential_rotations (id, project_id, service_id, environment_id, status, principals, applied, secrets_sealed, deploy, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', '["readonly","admin"]', '["readonly"]', ?, 'affected', ?, ?)`,
    )
      .bind(
        id,
        s.project.id,
        s.serviceId,
        s.envId,
        JSON.stringify(await sealWith(dek, JSON.stringify(secrets), rotationSecretsAad(id))),
        stale,
        stale,
      )
      .run();

    const res = await rotate(s, { principals: ["readonly"] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id,
      status: "succeeded",
      principals: ["readonly", "admin"],
      applied: ["readonly", "admin"],
    });
    const sent = setPasswords(s);
    expect(sent.map((q) => q.user)).toEqual(["postgres", "postgres"]);
    expect(sent[1]!.credential.password).toBe(secrets.admin);
    expect(await secret(s, "POSTGRES_PASSWORD")).toBe(secrets.admin);
    expect(await secret(s, "ROUNDHOUSE_RO_PASSWORD")).toBe(secrets.readonly);
  }, 90_000);
});

describe("restoring after a rotation", () => {
  it("refuses an in-place snapshot older than the rotation, which would bring back old passwords", async () => {
    const s = await databaseStage();
    await provisioned(s);
    const taken = Date.now() - 60_000;
    await env.DB.prepare(
      `INSERT INTO backups (id, project_id, service_id, environment_id, volume_id, trigger, method, engine, engine_version, status, node_id, object_key, sha256, bytes_stored, pinned, started_at, finished_at, created_at, updated_at)
       VALUES ('bak_01TESTSNAPSHOT0000000000000', ?, ?, ?, ?, 'migration', 'snapshot', 'postgres', '18', 'succeeded', ?, 'x/bak.rhbk.zst.age', ?, 10, 0, ?, ?, ?, ?)`,
    )
      .bind(
        s.project.id,
        s.serviceId,
        s.envId,
        s.volumeId,
        s.home.joined.node_id,
        "a".repeat(64),
        taken,
        taken,
        taken,
        taken,
      )
      .run();
    const restore = () =>
      s.owner.json<{ error: { message: string } }>(
        "/v1/backups/bak_01TESTSNAPSHOT0000000000000/restore",
        {
          method: "POST",
          json: { mode: "in_place", confirm: s.serviceSlug, skip_safety_backup: true },
        },
      );
    expect((await rotate(s)).body.status).toBe("succeeded");
    const refused = await restore();
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/rotated after this snapshot/);
  }, 90_000);
});

describe("rotation guards", () => {
  it("holds a lease, checks the principal, confirmation, session and agent", async () => {
    const s = await databaseStage();
    await provisioned(s);
    const bad = await rotate(s, { principals: ["app"] });
    expect(bad.status).toBe(422);
    const wrong = await rotate(s, { confirm: "nope" });
    expect(wrong.status).toBe(400);

    const id = "rot_01TESTLEASE00000000000000";
    await env.DB.prepare(
      `INSERT INTO credential_rotations (id, project_id, service_id, environment_id, status, principals, applied, secrets_sealed, deploy, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', '["readonly"]', '[]', NULL, 'affected', ?, ?)`,
    )
      .bind(id, s.project.id, s.serviceId, s.envId, Date.now(), Date.now())
      .run();
    const busy = await rotate(s);
    expect(busy.status).toBe(409);
    await env.DB.prepare("DELETE FROM credential_rotations WHERE id = ?").bind(id).run();

    const member = await addMember(s.owner, s.workspaceId, "dev@example.com", "member");
    const denied = await member.json(`/v1/services/${s.serviceId}/database/rotate-credentials`, {
      method: "POST",
      json: { environment_id: s.envId, confirm: s.serviceSlug },
    });
    expect(denied.status).toBe(403);

    await env.DB.prepare("UPDATE sessions SET created_at = ?, reauthenticated_at = NULL")
      .bind(Date.now() - 24 * 60 * 60 * 1000)
      .run();
    const staleSession = await rotate(s);
    expect(staleSession.status).toBe(403);
    expect(setPasswords(s)).toEqual([]);
    expect(await auditRows("database.credentials_rotated")).toEqual([]);
  }, 60_000);

  it("refuses an agent that can't set passwords", async () => {
    const s = await databaseStage({
      hello: () => ({ capabilities: { ...FULL_CAPABILITIES, db_set_password: false } }),
    });
    const res = await rotate(s);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: "agent_outdated" });
  }, 60_000);
});
