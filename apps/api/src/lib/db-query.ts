/**
 * The data browser's query channel (ADR 0004, "Data browser and query
 * runner"), shared by the query routes and the node Durable Object.
 *
 * - {@link findQueryTarget}: where a database service's queries run: the
 *   node holding its volume and the healthy replica there.
 * - {@link resolveDatabaseCredential}: the read-only or admin principal,
 *   resolved server-side from the service's variables.
 * - {@link sealDatabaseCredential}: seals it to the node, bound to one
 *   request (`db-credential` box), so the frame alone reveals nothing.
 * - {@link provisionReadonlyOnNode}: creates the read-only principal once a
 *   database first runs healthy, retried until it succeeds.
 *
 * SECURITY: a credential exists in plaintext only inside the Worker call
 * that resolves and seals it. It is never returned, logged or audited.
 *
 * @module
 */
import {
  type Db,
  deployments,
  environments,
  nodes,
  placements,
  services,
  volumes,
} from "@roundhouse/db";
import {
  type DbQuery,
  type DbQueryResult,
  dbCredentialAad,
  MAX_DB_QUERY_RESULT_BYTES,
  type SealedBox,
  type SealedDbCredential,
  sealBox,
} from "@roundhouse/protocol";
import { databaseCredentialVariables, newId, type ServiceDatabaseEngine } from "@roundhouse/shared";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { KeyEnv } from "./crypto";
import { LIVE_DEPLOYMENT_STATUSES } from "./desired-state";
import { resolveServiceEnvironment } from "./resolve-env";
import { projectKey } from "./variables";

/** How long a `runQuery` call waits for `db_query_result`: the 30 s query cap plus transit. */
export const DB_QUERY_WAIT_MS = 35_000;

/** Rows a query returns when the caller doesn't say. */
export const DEFAULT_QUERY_MAX_ROWS = 100;

/** Query timeout when the caller doesn't say, in ms. */
export const DEFAULT_QUERY_TIMEOUT_MS = 10_000;

/** A `db_query` frame without its signed header. */
export type DbQueryBody = Omit<DbQuery, "type" | "id" | "node_id" | "iat" | "exp">;

/** Why a query could not run on the node. */
export type RunQueryFailure =
  | "not_connected"
  | "protocol_too_old"
  | "rate_limited"
  | "busy"
  | "timeout";

/** What the node Durable Object's `runQuery` returns. */
export type RunQueryOutcome =
  | { ok: true; result: DbQueryResult }
  | { ok: false; reason: RunQueryFailure };

/** Runs one query on a node; the node Durable Object's `runQuery`. */
export type QueryRunner = (query: DbQueryBody) => Promise<RunQueryOutcome>;

/** Statuses of a volume whose database can be queried. */
const QUERYABLE_VOLUME_STATUSES = ["pending", "ready", "degraded", "error"] as const;

/** Where a database service's queries run. */
export interface QueryTarget {
  volumeId: string;
  nodeId: string;
  /** The node's X25519 key, to seal the credential to. */
  nodePublicKey: string;
  /** The healthy (or running) replica the agent connects to. */
  workloadId: string;
}

/** Why {@link findQueryTarget} found nowhere to run a query. */
export type QueryTargetFailure = "no_volume" | "not_placed" | "no_replica" | "node_unavailable";

/**
 * Finds the node and replica a database service's queries run on.
 *
 * @param db - Database client.
 * @param serviceId - The database service.
 * @param environmentId - The environment.
 * @returns The target, or why there is none.
 */
export async function findQueryTarget(
  db: Db,
  serviceId: string,
  environmentId: string,
): Promise<{ ok: true; target: QueryTarget } | { ok: false; reason: QueryTargetFailure }> {
  const [volume] = await db
    .select({ id: volumes.id, nodeId: volumes.nodeId })
    .from(volumes)
    .where(
      and(
        eq(volumes.serviceId, serviceId),
        eq(volumes.environmentId, environmentId),
        inArray(volumes.status, [...QUERYABLE_VOLUME_STATUSES]),
      ),
    )
    .limit(1);
  if (!volume) return { ok: false, reason: "no_volume" };
  if (!volume.nodeId) return { ok: false, reason: "not_placed" };
  const [node] = await db
    .select({ key: nodes.encryptionPublicKey })
    .from(nodes)
    .where(and(eq(nodes.id, volume.nodeId), isNull(nodes.deletedAt)))
    .limit(1);
  if (!node?.key) return { ok: false, reason: "node_unavailable" };
  const [replica] = await db
    .select({ workloadId: placements.workloadId })
    .from(placements)
    .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
    .where(
      and(
        eq(placements.nodeId, volume.nodeId),
        eq(deployments.serviceId, serviceId),
        eq(deployments.environmentId, environmentId),
        inArray(deployments.status, [...LIVE_DEPLOYMENT_STATUSES]),
        inArray(placements.state, ["healthy", "running"]),
      ),
    )
    .orderBy(asc(placements.state))
    .limit(1);
  if (!replica) return { ok: false, reason: "no_replica" };
  return {
    ok: true,
    target: {
      volumeId: volume.id,
      nodeId: volume.nodeId,
      nodePublicKey: node.key,
      workloadId: replica.workloadId,
    },
  };
}

/** The database service a credential belongs to. */
export interface CredentialSource {
  projectId: string;
  serviceId: string;
  environmentId: string;
  engine: ServiceDatabaseEngine;
}

/**
 * Resolves the principal a query connects as: `roundhouse_ro` for `read`,
 * the engine's admin for `write` (and provisioning), from the service's own
 * variables as a deployment would resolve them.
 *
 * @param db - Database client.
 * @param keys - Keyring bindings, to open the project DEK.
 * @param source - The database service and environment.
 * @param mode - `read` or `write`.
 * @returns The credential, or `null` when its variables are missing or don't resolve.
 */
export async function resolveDatabaseCredential(
  db: Db,
  keys: KeyEnv,
  source: CredentialSource,
  mode: "read" | "write",
): Promise<SealedDbCredential | null> {
  const [environment] = await db
    .select()
    .from(environments)
    .where(eq(environments.id, source.environmentId))
    .limit(1);
  if (!environment) return null;
  const key = await projectKey(db, keys, source.projectId);
  const resolved = await resolveServiceEnvironment(db, key, {
    projectId: source.projectId,
    serviceId: source.serviceId,
    environment,
  });
  if (!resolved.ok) return null;
  const names = databaseCredentialVariables(source.engine, mode);
  const username =
    "literal" in names.username ? names.username.literal : resolved.env[names.username.variable];
  const password = resolved.env[names.passwordVariable];
  if (!username || !password) return null;
  return { username, password };
}

/**
 * Seals a credential to the node for one request.
 *
 * @param target - The node.
 * @param requestId - The frame's `request_id`; bound into the AAD.
 * @param credential - The principal.
 * @returns The box for `db_query.credential_sealed`.
 */
export function sealDatabaseCredential(
  target: Pick<QueryTarget, "nodeId" | "nodePublicKey">,
  requestId: string,
  credential: SealedDbCredential,
): Promise<SealedBox> {
  return sealBox(
    target.nodePublicKey,
    JSON.stringify(credential),
    "db-credential",
    dbCredentialAad(target.nodeId, requestId),
  );
}

/**
 * A new `request_id` (`dbq_…`).
 *
 * @returns The ID.
 */
export function newQueryRequestId(): string {
  return newId("dbQuery");
}

/** A database whose read-only principal is still to be created. */
export interface ReadonlyProvisionTarget extends CredentialSource {
  volumeId: string;
  workloadId: string;
}

/**
 * Database volumes on a node without a read-only principal yet, each with a
 * healthy replica to provision through.
 *
 * @param db - Database client.
 * @param nodeId - The node.
 * @returns At most one target per volume.
 */
export async function readonlyProvisionTargets(
  db: Db,
  nodeId: string,
): Promise<ReadonlyProvisionTarget[]> {
  const rows = await db
    .select({
      volumeId: volumes.id,
      projectId: volumes.projectId,
      serviceId: volumes.serviceId,
      environmentId: volumes.environmentId,
      engine: services.databaseEngine,
      workloadId: placements.workloadId,
    })
    .from(volumes)
    .innerJoin(services, eq(services.id, volumes.serviceId))
    .innerJoin(
      deployments,
      and(
        eq(deployments.serviceId, volumes.serviceId),
        eq(deployments.environmentId, volumes.environmentId),
      ),
    )
    .innerJoin(placements, eq(placements.deploymentId, deployments.id))
    .where(
      and(
        eq(volumes.nodeId, nodeId),
        isNull(volumes.readonlyProvisionedAt),
        inArray(volumes.status, [...QUERYABLE_VOLUME_STATUSES]),
        isNotNull(services.databaseEngine),
        isNull(services.deletedAt),
        eq(placements.nodeId, nodeId),
        eq(placements.state, "healthy"),
        inArray(deployments.status, [...LIVE_DEPLOYMENT_STATUSES]),
      ),
    )
    .orderBy(asc(volumes.id));
  const out = new Map<string, ReadonlyProvisionTarget>();
  for (const r of rows) {
    if (r.engine && !out.has(r.volumeId)) out.set(r.volumeId, { ...r, engine: r.engine });
  }
  return [...out.values()];
}

/**
 * Creates the read-only principal (`provision_readonly`, as the admin) of
 * one database through its healthy replica, and records it. Idempotent on
 * both sides: the agent's statements are `IF NOT EXISTS`-style, and the
 * column is only set while still `NULL`.
 *
 * @param db - Database client.
 * @param keys - Keyring bindings.
 * @param target - The database and replica.
 * @param node - The node and its encryption key.
 * @param run - Sends the query and waits for its result.
 * @returns Whether the principal now exists.
 */
export async function provisionReadonly(
  db: Db,
  keys: KeyEnv,
  target: ReadonlyProvisionTarget,
  node: { id: string; publicKey: string },
  run: QueryRunner,
): Promise<boolean> {
  const credential = await resolveDatabaseCredential(db, keys, target, "write");
  if (!credential) return false;
  const requestId = newQueryRequestId();
  const outcome = await run({
    request_id: requestId,
    workload_id: target.workloadId,
    engine: target.engine,
    credential_sealed: await sealDatabaseCredential(
      { nodeId: node.id, nodePublicKey: node.publicKey },
      requestId,
      credential,
    ),
    mode: "write",
    op: { type: "provision_readonly" },
    max_rows: 1,
    max_bytes: MAX_DB_QUERY_RESULT_BYTES,
    timeout_ms: 30_000,
  });
  if (!outcome.ok || !outcome.result.ok) return false;
  await db
    .update(volumes)
    .set({ readonlyProvisionedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(volumes.id, target.volumeId), isNull(volumes.readonlyProvisionedAt)));
  return true;
}

/**
 * Provisions every database on a node that still needs it.
 *
 * @param db - Database client.
 * @param keys - Keyring bindings.
 * @param nodeId - The node.
 * @param run - The node Durable Object's query runner.
 * @param skip - Volumes to leave alone this time (in flight or recently tried).
 * @returns Volume IDs attempted, and those that succeeded.
 */
export async function provisionReadonlyOnNode(
  db: Db,
  keys: KeyEnv,
  nodeId: string,
  run: QueryRunner,
  skip: (volumeId: string) => boolean = () => false,
): Promise<{ attempted: string[]; provisioned: string[] }> {
  const targets = (await readonlyProvisionTargets(db, nodeId)).filter((t) => !skip(t.volumeId));
  if (!targets.length) return { attempted: [], provisioned: [] };
  const [node] = await db
    .select({ key: nodes.encryptionPublicKey })
    .from(nodes)
    .where(eq(nodes.id, nodeId))
    .limit(1);
  if (!node?.key) return { attempted: [], provisioned: [] };
  const provisioned: string[] = [];
  for (const t of targets) {
    if (await provisionReadonly(db, keys, t, { id: nodeId, publicKey: node.key }, run)) {
      provisioned.push(t.volumeId);
    }
  }
  return { attempted: targets.map((t) => t.volumeId), provisioned };
}
