/**
 * The build registry across nodes (ADR 0005, "Registry over the mesh"):
 * filesystem storage with a designated builder, per-node pull credentials
 * and proxies over the mesh; S3 storage with a read-write primary and
 * read-only replicas; the setting's routes; the scheduler's
 * `reachesRegistry` rule; and key rotation of the sealed values.
 */
import { env } from "cloudflare:test";
import { createDb, meshPaths, nodes } from "@roundhouse/db";
import {
  openBox,
  type RegistryConfig,
  registryUpstreamAad,
  SealedRegistryUpstreamSchema,
} from "@roundhouse/protocol";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { policyOf, REGISTRY_ROUTES } from "../src/contracts";
import { buildDesiredState } from "../src/lib/desired-state";
import { pairKey } from "../src/lib/mesh";
import {
  assertBuilderAllowed,
  buildCandidates,
  pullUserName,
  resealPullPasswords,
} from "../src/lib/registry";
import { setS3Transport } from "../src/lib/s3";
import { schedulerSnapshot } from "../src/lib/scheduling";
import { keyStatus } from "../src/workflows/key-rotation";
import { FAKE_S3, FakeS3 } from "./fake-s3";
import { NODE_ENCRYPTION_PRIVATE_KEY } from "./helpers";
import { markReady, meshCluster } from "./mesh-helpers";

afterEach(() => setS3Transport());

/** Read-only key pair of the fake bucket; obviously not real. */
const READONLY = { accessKeyId: "test-readonly-key-id", secretAccessKey: "test-readonly-secret" };

const STORAGE_BODY = {
  endpoint: FAKE_S3.endpoint,
  bucket: FAKE_S3.bucket,
  access_key_id: FAKE_S3.accessKeyId,
  secret_access_key: FAKE_S3.secretAccessKey,
  readonly_access_key_id: READONLY.accessKeyId,
  readonly_secret_access_key: READONLY.secretAccessKey,
};

/** One fake bucket that accepts both key pairs. */
function installBucket() {
  const rw = new FakeS3();
  const ro = new FakeS3({ ...FAKE_S3, ...READONLY });
  setS3Transport((req: Request) =>
    (req.headers.get("authorization") ?? "").includes(`Credential=${READONLY.accessKeyId}/`)
      ? ro.fetch(req)
      : rw.fetch(req),
  );
}

async function registryOf(
  nodeId: string,
): Promise<{ registry: RegistryConfig | null; generation: number }> {
  const body = (await buildDesiredState(createDb(env.DB), env, nodeId))!;
  return { registry: body.registry, generation: body.generation };
}

describe("filesystem registry over the mesh", () => {
  it("makes the oldest builder the primary and every other meshed node a proxy", async () => {
    const c = await meshCluster(2, { builders: 1 });
    const [n1, n2] = c.members.map((m) => m.id) as [string, string];

    const primary = await registryOf(n1);
    expect(primary.registry).toMatchObject({
      listen: "127.0.0.1:5000",
      storage: { type: "filesystem" },
      mode: "primary",
      mesh_listen: "10.200.1.1:5000",
      pull_users: [{ username: pullUserName(n2) }],
    });

    const proxy = await registryOf(n2);
    expect(proxy.registry).toMatchObject({
      mode: "proxy",
      storage: { type: "filesystem" },
      upstream: { url: "http://10.200.1.1:5000", username: pullUserName(n2) },
    });
    const opened = await openBox(
      NODE_ENCRYPTION_PRIVATE_KEY,
      proxy.registry!.upstream!.password_sealed,
      "registry-upstream",
      registryUpstreamAad(n2, proxy.generation),
    );
    const { password } = SealedRegistryUpstreamSchema.parse(
      JSON.parse(new TextDecoder().decode(opened)),
    );
    expect(bcrypt.compareSync(password, primary.registry!.pull_users![0]!.bcrypt)).toBe(true);

    // At rest only the sealed password and the hash, computed once.
    const [row] = await createDb(env.DB).select().from(nodes).where(eq(nodes.id, n2));
    expect(JSON.stringify(row!.registryPullPasswordSealed)).not.toContain(password);
    const again = await registryOf(n1);
    expect(again.registry!.pull_users![0]!.bcrypt).toBe(row!.registryPullBcrypt);
    expect(pullUserName(n2)).toMatch(/^node-[0-9a-z]{26}$/);
  });

  it("sends builds only to the designated builder", async () => {
    const c = await meshCluster(2);
    const ids = (await buildCandidates(createDb(env.DB), c.workspaceId)).map((n) => n.id);
    expect(ids).toEqual([c.members[0]!.id]);
    // The other builder keeps serving what it built, and pulls through no one.
    const other = await registryOf(c.members[1]!.id);
    expect(other.registry).toEqual({
      listen: "127.0.0.1:5000",
      storage: { type: "filesystem" },
      mode: "primary",
    });
    const primary = await registryOf(c.members[0]!.id);
    expect(primary.registry!.pull_users).toBeUndefined();
  });

  it("lets nodes pull only over a fresh handshake with the builder", async () => {
    const c = await meshCluster(3, { builders: 1 });
    const [n1, n2, n3] = c.members.map((m) => m.id) as [string, string, string];
    const db = createDb(env.DB);
    const reach = async () =>
      Object.fromEntries(
        (await schedulerSnapshot(db, { workspaceId: c.workspaceId, registryNodeId: n1 })).nodes.map(
          (n) => [n.id, n.reachesRegistry],
        ),
      );
    expect(await reach()).toEqual({ [n1]: true, [n2]: false, [n3]: false });

    await markReady([n1, n2, n3]);
    expect(await reach()).toEqual({ [n1]: true, [n2]: true, [n3]: true });

    // A stale tunnel doesn't count; a relayed pair needs both legs fresh.
    const stale = new Date(Date.now() - 10 * 60_000);
    await db
      .update(meshPaths)
      .set({ lastHandshakeAt: stale })
      .where(eq(meshPaths.pairKey, pairKey(n1, n2)));
    expect((await reach())[n2]).toBe(false);
    await db
      .update(meshPaths)
      .set({ path: "relayed", relayNodeId: n3 })
      .where(eq(meshPaths.pairKey, pairKey(n1, n2)));
    expect((await reach())[n2]).toBe(true);
    await db
      .update(meshPaths)
      .set({ lastHandshakeAt: stale })
      .where(eq(meshPaths.pairKey, pairKey(n2, n3)));
    expect((await reach())[n2]).toBe(false);
  });

  it("refuses a second builder until storage is S3", async () => {
    const c = await meshCluster(1);
    await expect(assertBuilderAllowed(createDb(env.DB), c.workspaceId)).rejects.toMatchObject({
      status: 409,
      code: "registry_requires_s3",
    });
  });
});

describe("S3 registry storage", () => {
  it("is write-only, probes both key pairs, and turns builders and nodes into primary and replicas", async () => {
    installBucket();
    const c = await meshCluster(2);
    const empty = await c.owner.json("/v1/instance/registry-storage");
    expect(empty.body).toMatchObject({ type: "filesystem", secrets_set: false });

    const bad = await c.owner.json<{ error: { code: string } }>("/v1/instance/registry-storage", {
      method: "PUT",
      json: { ...STORAGE_BODY, readonly_secret_access_key: "not-the-readonly-secret" },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe("registry_storage_unreachable");

    const set = await c.owner.json<Record<string, unknown>>("/v1/instance/registry-storage", {
      method: "PUT",
      json: STORAGE_BODY,
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({
      type: "s3",
      bucket: FAKE_S3.bucket,
      access_key_id: FAKE_S3.accessKeyId,
      readonly_access_key_id: READONLY.accessKeyId,
      secrets_set: true,
    });
    expect(JSON.stringify(set.body)).not.toContain(FAKE_S3.secretAccessKey);
    expect(JSON.stringify(set.body)).not.toContain(READONLY.secretAccessKey);

    // Both nodes are builders (the join default): both primaries on the bucket.
    const n1 = await registryOf(c.members[0]!.id);
    expect(n1.registry).toMatchObject({
      mode: "primary",
      storage: {
        type: "s3",
        access_key_id: FAKE_S3.accessKeyId,
        secret_access_key: FAKE_S3.secretAccessKey,
      },
    });
    const db = createDb(env.DB);
    await db
      .update(nodes)
      .set({ capabilities: { docker: true, gvisor: false, builder: false } })
      .where(eq(nodes.id, c.members[1]!.id));
    const n2 = await registryOf(c.members[1]!.id);
    expect(n2.registry).toMatchObject({
      mode: "replica",
      storage: {
        type: "s3",
        access_key_id: READONLY.accessKeyId,
        secret_access_key: READONLY.secretAccessKey,
      },
    });
    // With S3 every builder builds and every node pulls without the mesh.
    await db
      .update(nodes)
      .set({ capabilities: { docker: true, gvisor: false, builder: true } })
      .where(eq(nodes.id, c.members[1]!.id));
    expect((await buildCandidates(db, c.workspaceId)).length).toBe(2);
    const snap = await schedulerSnapshot(db, {
      workspaceId: c.workspaceId,
      registryNodeId: c.members[0]!.id,
    });
    expect(snap.nodes.every((n) => n.reachesRegistry)).toBe(true);
    await expect(assertBuilderAllowed(db, c.workspaceId)).resolves.toBeUndefined();

    // Two builders: filesystem storage can't serve them.
    const back = await c.owner.json<{ error: { code: string } }>("/v1/instance/registry-storage", {
      method: "DELETE",
    });
    expect(back.status).toBe(409);
    expect(back.body.error.code).toBe("registry_requires_s3");
  });

  it("is instance-admin only with a fresh session", () => {
    for (const r of Object.values(REGISTRY_ROUTES)) {
      expect(policyOf(r)).toMatchObject({ auth: "session_only", action: "instance:manage" });
    }
    expect(policyOf(REGISTRY_ROUTES.putRegistryStorage).reauth).toBe(true);
    expect(policyOf(REGISTRY_ROUTES.deleteRegistryStorage).reauth).toBe(true);
  });
});

describe("registry secrets and key rotation", () => {
  it("re-seals pull passwords and counts nothing stale once they are current", async () => {
    const c = await meshCluster(2, { builders: 1 });
    const db = createDb(env.DB);
    await registryOf(c.members[0]!.id);
    const status = await keyStatus(db, env);
    expect(status.remaining.instance_secrets).toBe(0);
    // Pretend the current KEK changed: every pull password is re-sealed and still opens.
    expect(await resealPullPasswords(db, env, "00000000", 100)).toBe(1);
    const proxy = await registryOf(c.members[1]!.id);
    expect(proxy.registry!.mode).toBe("proxy");
  });
});
