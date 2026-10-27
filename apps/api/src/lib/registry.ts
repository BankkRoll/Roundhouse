/**
 * Every node pulls builds from `127.0.0.1:5000` (ADR 0005, "Registry over
 * the mesh"); this module decides what answers there on each node:
 *
 * - **S3 storage** (the `registry_storage` instance setting): builders run
 *   `primary` on the bucket with the read-write keys, every other node runs
 *   `replica` with the read-only keys. Any number of builders; no mesh
 *   needed.
 * - **Filesystem storage** (the default): one builder per workspace, the
 *   {@link designatedBuilder}, runs `primary` on its disk and publishes it
 *   on its mesh `.1:5000` with one htpasswd user per other meshed node.
 *   Those nodes run `proxy` (a pull-through cache) against it over
 *   WireGuard, each with its own password, sealed to it in the frame.
 *   Other builder-capable nodes get no builds and keep a local primary
 *   with what they built before.
 *
 * Also here: the setting itself (secrets sealed and write-only, re-wrapped
 * by key rotation), the per-node pull credentials (password sealed under
 * the KEK on the node row, bcrypt computed once at creation), and the
 * scheduler's `reachesRegistry` rule.
 *
 * @module
 */
import { type Db, meshPaths, nodeProvisions, nodes } from "@roundhouse/db";
import {
  MESH_PROTOCOL_VERSION,
  REGISTRY_LISTEN,
  type RegistryConfig,
  type RegistryPullUser,
  registryUpstreamAad,
  sealBox,
  toBase64,
} from "@roundhouse/protocol";
import bcrypt from "bcryptjs";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Sealed } from "./crypto";
import { ApiError } from "./errors";
import {
  type KeyEnv,
  SealedSchema,
  sealInstanceSecret,
  unsealInstanceSecret,
} from "./instance-secrets";
import { isMeshed, MESH_HANDSHAKE_STALE_MS, meshAddress, pairKey } from "./mesh";
import { effectiveStatus } from "./nodes";
import { ACTIVE_PROVISION_STATUSES } from "./provisioning";
import { getMeshSettings, getSetting, type MeshSettings, putSetting, SettingKey } from "./settings";

// -----------------------------------------------------------------------------
// The `registry_storage` setting
// -----------------------------------------------------------------------------

/** Field the read-write secret is sealed under. */
export const REGISTRY_SECRET_FIELD = "secret_access_key";

/** Field the read-only secret is sealed under. */
export const REGISTRY_READONLY_SECRET_FIELD = "readonly_secret_access_key";

const StoredRegistryStorageSchema = z.object({
  endpoint: z.string(),
  bucket: z.string(),
  region: z.string(),
  access_key_id: z.string(),
  secret_access_key: SealedSchema,
  readonly_access_key_id: z.string(),
  readonly_secret_access_key: SealedSchema,
  updated_at: z.number(),
});

/** The setting as stored. */
export type StoredRegistryStorage = z.infer<typeof StoredRegistryStorageSchema>;

/** The setting as an instance admin may read it: never a secret. */
export interface RegistryStorageView {
  /** `s3` once a bucket is set, else `filesystem`. */
  type: "filesystem" | "s3";
  endpoint: string | null;
  bucket: string | null;
  region: string | null;
  access_key_id: string | null;
  readonly_access_key_id: string | null;
  /** Both secrets are set; they are never returned. */
  secrets_set: boolean;
  updated_at: number | null;
}

/** The bucket with both key pairs unsealed. Never return or log it. */
export interface RegistryS3 {
  endpoint: string;
  bucket: string;
  region: string;
  readWrite: { accessKeyId: string; secretAccessKey: string };
  readOnly: { accessKeyId: string; secretAccessKey: string };
}

/** New values for the setting; omitted secrets keep the stored ones. */
export interface RegistryStorageInput {
  endpoint: string;
  bucket: string;
  region: string;
  access_key_id: string;
  secret_access_key?: string | undefined;
  readonly_access_key_id: string;
  readonly_secret_access_key?: string | undefined;
}

async function readStored(db: Db): Promise<StoredRegistryStorage | null> {
  const raw = await getSetting<unknown>(db, SettingKey.registryStorage);
  if (raw === undefined) return null;
  const parsed = StoredRegistryStorageSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Reads the setting without its secrets.
 *
 * @param db - Database client.
 * @returns What is configured.
 */
export async function getRegistryStorageView(db: Db): Promise<RegistryStorageView> {
  const s = await readStored(db);
  return {
    type: s ? "s3" : "filesystem",
    endpoint: s?.endpoint ?? null,
    bucket: s?.bucket ?? null,
    region: s?.region ?? null,
    access_key_id: s?.access_key_id ?? null,
    readonly_access_key_id: s?.readonly_access_key_id ?? null,
    secrets_set: s !== null,
    updated_at: s?.updated_at ?? null,
  };
}

/**
 * Whether builds live in a shared bucket, without unsealing anything.
 *
 * @param db - Database client.
 * @returns `true` when `registry_storage` is set.
 */
export async function usesS3Registry(db: Db): Promise<boolean> {
  return (await readStored(db)) !== null;
}

/**
 * Loads the bucket with both secrets unsealed.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @returns The bucket, or `null` for filesystem storage.
 */
export async function loadRegistryS3(db: Db, keys: KeyEnv): Promise<RegistryS3 | null> {
  const s = await readStored(db);
  if (!s) return null;
  return {
    endpoint: s.endpoint,
    bucket: s.bucket,
    region: s.region,
    readWrite: {
      accessKeyId: s.access_key_id,
      secretAccessKey: await unsealInstanceSecret(
        keys,
        s.secret_access_key,
        SettingKey.registryStorage,
        REGISTRY_SECRET_FIELD,
      ),
    },
    readOnly: {
      accessKeyId: s.readonly_access_key_id,
      secretAccessKey: await unsealInstanceSecret(
        keys,
        s.readonly_secret_access_key,
        SettingKey.registryStorage,
        REGISTRY_READONLY_SECRET_FIELD,
      ),
    },
  };
}

/**
 * Builds the stored value for new settings, sealing new secrets or keeping
 * the stored ones.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @param input - Validated values (endpoint already normalised).
 * @param now - Unix ms.
 * @returns The value to store and the bucket it describes.
 * @throws {ApiError} 400 when a secret is missing and none is stored.
 */
export async function prepareRegistryStorage(
  db: Db,
  keys: KeyEnv,
  input: RegistryStorageInput,
  now = Date.now(),
): Promise<{ stored: StoredRegistryStorage; s3: RegistryS3 }> {
  const current = await readStored(db);
  const secret = async (given: string | undefined, field: string, sealed: Sealed | undefined) => {
    if (given !== undefined) {
      return {
        plain: given,
        sealed: await sealInstanceSecret(keys, given, SettingKey.registryStorage, field),
      };
    }
    if (!sealed) throw new ApiError(400, "invalid_request", `${field} is required`);
    return {
      plain: await unsealInstanceSecret(keys, sealed, SettingKey.registryStorage, field),
      sealed,
    };
  };
  const rw = await secret(
    input.secret_access_key,
    REGISTRY_SECRET_FIELD,
    current?.secret_access_key as Sealed | undefined,
  );
  const ro = await secret(
    input.readonly_secret_access_key,
    REGISTRY_READONLY_SECRET_FIELD,
    current?.readonly_secret_access_key as Sealed | undefined,
  );
  return {
    stored: {
      endpoint: input.endpoint,
      bucket: input.bucket,
      region: input.region,
      access_key_id: input.access_key_id,
      secret_access_key: rw.sealed,
      readonly_access_key_id: input.readonly_access_key_id,
      readonly_secret_access_key: ro.sealed,
      updated_at: now,
    },
    s3: {
      endpoint: input.endpoint,
      bucket: input.bucket,
      region: input.region,
      readWrite: { accessKeyId: input.access_key_id, secretAccessKey: rw.plain },
      readOnly: { accessKeyId: input.readonly_access_key_id, secretAccessKey: ro.plain },
    },
  };
}

/**
 * Writes the setting.
 *
 * @param db - Database client.
 * @param stored - From {@link prepareRegistryStorage}, or `null` for filesystem storage.
 * @returns The statement, for `db.batch`.
 */
export function putRegistryStorage(db: Db, stored: StoredRegistryStorage | null) {
  return putSetting(db, SettingKey.registryStorage, stored);
}

/** 409 `registry_requires_s3`: filesystem storage supports one builder per workspace. */
export const registryRequiresS3 = (detail: string) =>
  new ApiError(
    409,
    "registry_requires_s3",
    `${detail} Builds are stored on the builder's disk, which serves one builder per workspace; ` +
      "set S3 registry storage under Settings → Platform → Registry first.",
  );

// -----------------------------------------------------------------------------
// Builders
// -----------------------------------------------------------------------------

/** A node row. */
type NodeRow = typeof nodes.$inferSelect;

/** Whether a node's agent runs builds and could hold a registry. */
const builderCapable = (n: NodeRow) =>
  n.deletedAt === null &&
  n.capabilities?.builder === true &&
  n.capabilities.docker === true &&
  n.encryptionPublicKey !== null;

/**
 * The builders of a workspace in the order filesystem storage designates
 * them: the first is the one whose disk holds the builds.
 *
 * @param db - Database client.
 * @param workspaceId - The workspace.
 * @returns Live builder-capable nodes, oldest first.
 */
export async function workspaceBuilders(db: Db, workspaceId: string): Promise<NodeRow[]> {
  const rows = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.workspaceId, workspaceId), isNull(nodes.deletedAt)))
    .orderBy(asc(nodes.createdAt), asc(nodes.id));
  return rows.filter(builderCapable);
}

/**
 * With filesystem storage, the one builder of a workspace whose registry
 * holds its builds: the oldest builder-capable node. Other builder-capable
 * nodes get no builds and pull through it like any other node.
 *
 * @param db - Database client.
 * @param workspaceId - The workspace.
 * @returns Its ID, or `null` without a builder.
 */
export async function designatedBuilder(db: Db, workspaceId: string): Promise<string | null> {
  return (await workspaceBuilders(db, workspaceId))[0]?.id ?? null;
}

/**
 * Whether builds must stay on one builder per workspace: the mesh is on and
 * builds live on a builder's disk, so every other node pulls through that
 * one registry (ADR 0005). Without the mesh each node runs only what its own
 * builder built, as before, so several builders (such as a dedicated fork
 * builder, ADR 0007) keep working.
 *
 * @param db - Database client.
 * @returns `true` when only the designated builder may build.
 */
async function singleBuilder(db: Db): Promise<boolean> {
  return (await getMeshSettings(db)).enabled && !(await usesS3Registry(db));
}

/**
 * The nodes a build may be sent to: only the designated builder while the
 * mesh pulls through it ({@link singleBuilder}), every online builder
 * otherwise.
 *
 * @param db - Database client.
 * @param workspaceId - The workspace.
 * @returns Online builder nodes.
 */
export async function buildCandidates(db: Db, workspaceId: string): Promise<NodeRow[]> {
  const builders = (await workspaceBuilders(db, workspaceId)).filter(
    (n) => effectiveStatus(n) === "online",
  );
  if (!(await singleBuilder(db))) return builders;
  const designated = await designatedBuilder(db, workspaceId);
  return builders.filter((n) => n.id === designated);
}

/**
 * Refuses a second builder for a workspace while the mesh is on and builds are
 * stored on the builder's disk: the point where builders are chosen is provisioning one
 * (a hand-joined agent reports the capability itself, and only the
 * {@link designatedBuilder} then gets builds).
 *
 * @param db - Database client.
 * @param workspaceId - The workspace getting a builder.
 * @throws {ApiError} 409 `registry_requires_s3`.
 */
export async function assertBuilderAllowed(db: Db, workspaceId: string): Promise<void> {
  if (!(await singleBuilder(db))) return;
  const [pending] = await db
    .select({ id: nodeProvisions.id })
    .from(nodeProvisions)
    .where(
      and(
        eq(nodeProvisions.workspaceId, workspaceId),
        eq(nodeProvisions.builder, true),
        inArray(nodeProvisions.status, [...ACTIVE_PROVISION_STATUSES]),
      ),
    )
    .limit(1);
  if (pending || (await workspaceBuilders(db, workspaceId)).length) {
    throw registryRequiresS3("This workspace already has a builder.");
  }
}

/**
 * Workspaces with more than one live builder; filesystem storage can't serve them.
 *
 * @param db - Database client.
 * @returns Workspace IDs.
 */
export async function workspacesWithSeveralBuilders(db: Db): Promise<string[]> {
  const rows = await db.select().from(nodes).where(isNull(nodes.deletedAt));
  const counts = new Map<string, number>();
  for (const n of rows.filter(builderCapable)) {
    counts.set(n.workspaceId, (counts.get(n.workspaceId) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n > 1).map(([ws]) => ws);
}

// -----------------------------------------------------------------------------
// Pull credentials
// -----------------------------------------------------------------------------

/** `instance_settings`-style key the pull passwords are sealed under (AAD). */
export const REGISTRY_PULL_SETTING = "registry_pull";

/** bcrypt cost of `pull_users`; the registry verifies once per pull session. */
const PULL_BCRYPT_COST = 10;

/**
 * The htpasswd user of a node: `node-` and the node ID's ULID, lowercase,
 * which `REGISTRY_USER_RE` accepts (it has no underscore).
 *
 * @param nodeId - The node.
 * @returns E.g. `node-01j9z6…`.
 */
export function pullUserName(nodeId: string): string {
  return `node-${nodeId.slice(nodeId.indexOf("_") + 1).toLowerCase()}`;
}

/** A node's pull credential with the password unsealed. */
export interface PullCredential {
  username: string;
  password: string;
  bcrypt: string;
}

/**
 * A node's pull credential, made the first time it is needed: 32 random
 * bytes, sealed under the KEK on the node row, with its bcrypt computed
 * once here and stored, so frames never hash again.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @param nodeId - The node.
 * @returns The credential, or `null` for a removed node.
 */
export async function ensurePullCredential(
  db: Db,
  keys: KeyEnv,
  nodeId: string,
): Promise<PullCredential | null> {
  const read = async () =>
    (
      await db
        .select({
          user: nodes.registryPullUser,
          sealed: nodes.registryPullPasswordSealed,
          bcrypt: nodes.registryPullBcrypt,
          deletedAt: nodes.deletedAt,
        })
        .from(nodes)
        .where(eq(nodes.id, nodeId))
        .limit(1)
    )[0];
  let row = await read();
  if (!row || row.deletedAt) return null;
  if (!row.user || !row.sealed || !row.bcrypt) {
    const password = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    const hash = await bcrypt.hash(password, PULL_BCRYPT_COST);
    // Conditional, so a concurrent first use keeps whichever landed first.
    await db
      .update(nodes)
      .set({
        registryPullUser: pullUserName(nodeId),
        registryPullPasswordSealed: await sealInstanceSecret(
          keys,
          password,
          REGISTRY_PULL_SETTING,
          nodeId,
        ),
        registryPullBcrypt: hash,
      })
      .where(and(eq(nodes.id, nodeId), isNull(nodes.registryPullPasswordSealed)));
    row = await read();
    if (!row?.user || !row.sealed || !row.bcrypt) return null;
  }
  return {
    username: row.user,
    password: await unsealInstanceSecret(keys, row.sealed as Sealed, REGISTRY_PULL_SETTING, nodeId),
    bcrypt: row.bcrypt,
  };
}

/**
 * Re-seals up to `limit` pull passwords not sealed under the current KEK;
 * part of the master key rotation.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @param currentKid - The current KEK id.
 * @param limit - Batch size.
 * @returns How many were re-sealed.
 */
export async function resealPullPasswords(
  db: Db,
  keys: KeyEnv,
  currentKid: string,
  limit: number,
): Promise<number> {
  const rows = await db
    .select({
      id: nodes.id,
      sealed: nodes.registryPullPasswordSealed,
      raw: sql<string>`CAST(${nodes.registryPullPasswordSealed} AS TEXT)`,
    })
    .from(nodes)
    .where(stalePullPasswords(currentKid))
    .limit(limit);
  for (const r of rows) {
    const password = await unsealInstanceSecret(
      keys,
      r.sealed as Sealed,
      REGISTRY_PULL_SETTING,
      r.id,
    );
    await db
      .update(nodes)
      .set({
        registryPullPasswordSealed: await sealInstanceSecret(
          keys,
          password,
          REGISTRY_PULL_SETTING,
          r.id,
        ),
      })
      .where(
        and(eq(nodes.id, r.id), sql`CAST(${nodes.registryPullPasswordSealed} AS TEXT) = ${r.raw}`),
      );
  }
  return rows.length;
}

/**
 * Nodes holding a pull password not sealed under `currentKid`.
 *
 * @param currentKid - The current KEK id.
 * @returns The condition.
 */
export function stalePullPasswords(currentKid: string) {
  return and(
    isNotNull(nodes.registryPullPasswordSealed),
    sql`(json_extract(${nodes.registryPullPasswordSealed}, '$.v') IS NOT 2 OR json_extract(${nodes.registryPullPasswordSealed}, '$.kid') IS NOT ${currentKid})`,
  );
}

// -----------------------------------------------------------------------------
// Desired state
// -----------------------------------------------------------------------------

/** What {@link registryConfigFor} needs about the node and its cluster. */
export interface RegistryInput {
  node: NodeRow;
  /** The node's workspace's meshed nodes (empty without the mesh). */
  meshNodes: readonly NodeRow[];
  mesh: MeshSettings;
  /** Generation of the frame; bound into the sealed upstream password's AAD. */
  generation: number;
}

/**
 * The registry a node runs, or `null` for none.
 *
 * - S3: builders `primary` on the bucket (read-write), other nodes at
 *   `MESH_PROTOCOL_VERSION` `replica` (read-only keys).
 * - Filesystem: the designated builder `primary` on disk, plus the mesh
 *   listener and its pull users once other meshed nodes exist; other
 *   meshed nodes `proxy` through it.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @param input - The node and its cluster.
 * @returns `desired_state.registry`.
 */
export async function registryConfigFor(
  db: Db,
  keys: KeyEnv,
  input: RegistryInput,
): Promise<RegistryConfig | null> {
  const { node } = input;
  const modern = node.protocolVersion >= MESH_PROTOCOL_VERSION;
  const s3 = await loadRegistryS3(db, keys);
  if (s3) {
    const storage = (k: { accessKeyId: string; secretAccessKey: string }) => ({
      type: "s3" as const,
      endpoint: s3.endpoint,
      bucket: s3.bucket,
      region: s3.region,
      access_key_id: k.accessKeyId,
      secret_access_key: k.secretAccessKey,
    });
    if (builderCapable(node)) {
      return {
        listen: REGISTRY_LISTEN,
        storage: storage(s3.readWrite),
        ...(modern ? { mode: "primary" as const } : {}),
      };
    }
    // SECURITY: a node that only pulls never holds the bucket's write keys.
    return modern
      ? { listen: REGISTRY_LISTEN, storage: storage(s3.readOnly), mode: "replica" }
      : null;
  }
  const builderId = await designatedBuilder(db, node.workspaceId);
  if (builderId === node.id) {
    const config: RegistryConfig = { listen: REGISTRY_LISTEN, storage: { type: "filesystem" } };
    const self = input.meshNodes.find((n) => n.id === node.id);
    if (!modern || !self || !isMeshed(self, input.mesh)) return config;
    const users: RegistryPullUser[] = [];
    for (const peer of input.meshNodes) {
      if (peer.id === node.id || peer.protocolVersion < MESH_PROTOCOL_VERSION) continue;
      // Other builders keep their own registry and never pull through this one.
      if (builderCapable(peer)) continue;
      const credential = await ensurePullCredential(db, keys, peer.id);
      if (credential) users.push({ username: credential.username, bcrypt: credential.bcrypt });
    }
    if (!users.length) return { ...config, mode: "primary" };
    return {
      ...config,
      mode: "primary",
      mesh_listen: `${meshAddress(input.mesh.supernet, self.meshIndex!, 1)}:5000`,
      pull_users: users.sort((a, b) => (a.username < b.username ? -1 : 1)),
    };
  }
  if (builderCapable(node)) {
    // A builder that isn't the designated one gets no new builds, but keeps
    // serving the images it built before, so their replicas still pull.
    return {
      listen: REGISTRY_LISTEN,
      storage: { type: "filesystem" },
      ...(modern ? { mode: "primary" as const } : {}),
    };
  }
  const builder = input.meshNodes.find((n) => n.id === builderId);
  const self = input.meshNodes.find((n) => n.id === node.id);
  if (!modern || !builder || !self || node.encryptionPublicKey === null) return null;
  const credential = await ensurePullCredential(db, keys, node.id);
  if (!credential) return null;
  return {
    listen: REGISTRY_LISTEN,
    storage: { type: "filesystem" },
    mode: "proxy",
    upstream: {
      // NOTE: plain HTTP on purpose: the hop runs inside WireGuard, and the
      // primary's mesh listener is reachable only from the nodes' `.1`s.
      url: `http://${meshAddress(input.mesh.supernet, builder.meshIndex!, 1)}:5000`,
      username: credential.username,
      password_sealed: await sealBox(
        node.encryptionPublicKey,
        JSON.stringify({ password: credential.password }),
        "registry-upstream",
        registryUpstreamAad(node.id, input.generation),
      ),
    },
  };
}

// -----------------------------------------------------------------------------
// Scheduler
// -----------------------------------------------------------------------------

/**
 * Which nodes can pull the builder's images (ADR 0005, `reachesRegistry`):
 * every node with a registry when storage is S3; else the builder itself,
 * and meshed nodes whose tunnel to the builder handshook within
 * {@link MESH_HANDSHAKE_STALE_MS} (a relayed pair counts when both legs did).
 *
 * @param db - Database client.
 * @param rows - The workspace's nodes, as the scheduler snapshot read them.
 * @param registryNodeId - The builder holding the image; `null` for images from elsewhere.
 * @param mesh - The mesh settings.
 * @param now - Unix ms.
 * @returns IDs of the nodes that reach it.
 */
export async function nodesReachingRegistry(
  db: Db,
  rows: readonly NodeRow[],
  registryNodeId: string | null,
  mesh: MeshSettings,
  now = Date.now(),
): Promise<Set<string>> {
  const out = new Set<string>();
  if (registryNodeId === null) return out;
  if (await usesS3Registry(db)) {
    for (const n of rows) {
      if (builderCapable(n) || n.protocolVersion >= MESH_PROTOCOL_VERSION) out.add(n.id);
    }
    return out;
  }
  out.add(registryNodeId);
  const builder = rows.find((n) => n.id === registryNodeId);
  if (!builder || !isMeshed(builder, mesh)) return out;
  const meshed = rows.filter((n) => n.id !== registryNodeId && isMeshed(n, mesh));
  if (!meshed.length) return out;
  const keys = meshed.map((n) => pairKey(n.id, registryNodeId));
  const byKey = new Map<string, typeof meshPaths.$inferSelect>();
  // D1 caps bound parameters at 100 per statement.
  for (let i = 0; i < keys.length; i += 50) {
    const rows = await db
      .select()
      .from(meshPaths)
      .where(inArray(meshPaths.pairKey, keys.slice(i, i + 50)));
    for (const r of rows) byKey.set(r.pairKey, r);
  }
  const fresh = async (a: string, b: string) => {
    const key = pairKey(a, b);
    let row = byKey.get(key);
    if (!row) {
      [row] = await db.select().from(meshPaths).where(eq(meshPaths.pairKey, key)).limit(1);
      if (row) byKey.set(key, row);
    }
    return !!row?.lastHandshakeAt && now - +row.lastHandshakeAt < MESH_HANDSHAKE_STALE_MS;
  };
  for (const n of meshed) {
    // Only proxies pull through the builder; another builder runs its own registry.
    if (n.protocolVersion < MESH_PROTOCOL_VERSION || builderCapable(n)) continue;
    const row = byKey.get(pairKey(n.id, registryNodeId));
    if (!row) continue;
    if (row.path === "direct" && (await fresh(n.id, registryNodeId))) out.add(n.id);
    if (
      row.path === "relayed" &&
      row.relayNodeId &&
      (await fresh(n.id, row.relayNodeId)) &&
      (await fresh(row.relayNodeId, registryNodeId))
    ) {
      out.add(n.id);
    }
  }
  return out;
}
