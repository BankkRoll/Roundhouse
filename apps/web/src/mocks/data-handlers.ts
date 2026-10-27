/**
 * MSW handlers for the data-service routes (ADR 0004): `DATABASE_ROUTES`,
 * `CREDENTIAL_ROUTES`, `DATA_BROWSER_ROUTES` and `BACKUP_ROUTES` in
 * `apps/api/src/contracts`, against the in-memory {@link db}. `contract.test.ts` validates every response against the API's
 * schemas.
 *
 * Requests are validated with the routes' own zod schemas first (400), then the API's
 * order: 401 without a session, 404 for a missing row or a non-member, 403 when the role
 * lacks the route's action (or `reauth_required` for a stale session, when a test asks
 * for it), then 409 conflicts.
 *
 * There is no agent: the data browser answers from the seeded relations in
 * `./data-db`, backups and restores advance one status each time they are read
 * (`queued` → `running` → `succeeded`), and a volume move one phase each time it is
 * read, so polling sees them finish.
 *
 * @module
 */
import {
  type Action,
  can,
  DATABASE_ENGINE_SPECS,
  DEFAULT_BACKUP_KEEP_LAST,
  DEFAULT_BACKUP_SCHEDULE,
  databasePrincipals,
  databaseVersion,
  freeSlug,
  nextCronRun,
  nextCronRuns,
  RESERVED_SERVICE_SLUGS,
  type ServiceDatabaseEngine,
  slugify,
  VOLUME_DELETE_GRACE_MS,
} from "@roundhouse/shared";
import { HttpResponse, http } from "msw";
import {
  BACKUP_ROUTES,
  CREDENTIAL_ROUTES,
  DATA_BROWSER_ROUTES,
  DATABASE_ROUTES,
  policyOf,
} from "../../../api/src/contracts";
import { isAllowlistEntry } from "../features/databases/allowlist";
import { defaultRestoreSlug } from "../features/databases/database-meta";
import type { Backup, BackupPolicy, Restore } from "../lib/api/backups-client";
import type {
  DatabasePrincipal,
  DatabaseQueryOp,
  DatabaseQueryResult,
  MigrationTargets,
  TcpProxy,
  Volume,
  VolumeMigration,
} from "../lib/api/data-client";
import type { Environment, Project, Service, ServiceConfig } from "../lib/api/deploy-types";
import {
  apiError,
  currentUser,
  type Guard,
  invalid,
  notFound,
  recordAudit,
  requireWorkspace,
  unauthorized,
} from "./common";
import { makeVolume, renderMockDatabase } from "./data-db";
import { db, nextId } from "./db";
import type { DbVariable } from "./deploy-db";
import { broadcastRealtime, startDeployment } from "./deploy-handlers";

// -----------------------------------------------------------------------------
// Validation with the contract's schemas
// -----------------------------------------------------------------------------

const ROUTES = {
  ...DATABASE_ROUTES,
  ...CREDENTIAL_ROUTES,
  ...DATA_BROWSER_ROUTES,
  ...BACKUP_ROUTES,
};
type RouteName = keyof typeof ROUTES;

interface ZodIssue {
  path: PropertyKey[];
  message: string;
}

interface Schema {
  safeParse(
    value: unknown,
  ): { success: true; data: unknown } | { success: false; error: { issues: ZodIssue[] } };
}

interface RouteRequest {
  params?: Schema;
  query?: Schema;
  body?: { content: { "application/json": { schema: Schema } } };
}

type Validated<B> =
  | { ok: true; params: Record<string, string>; query: Record<string, string>; body: B }
  | { ok: false; response: Response };

function issueResponse(issues: ZodIssue[]): Response {
  const issue = issues[0];
  const where = issue?.path.length ? `${issue.path.map(String).join(".")}: ` : "";
  return invalid(`${where}${issue?.message ?? "invalid"}`);
}

/** Validates params, query, then the JSON body, as `@hono/zod-openapi` does. */
async function validate<B = Record<string, never>>(
  name: RouteName,
  request: Request,
  params: Record<string, string | readonly string[] | undefined>,
): Promise<Validated<B>> {
  const spec = (ROUTES[name] as { request?: RouteRequest }).request ?? {};
  const parsed: unknown[] = [];
  for (const [schema, value] of [
    [spec.params, params],
    [spec.query, Object.fromEntries(new URL(request.url).searchParams)],
  ] as const) {
    if (!schema) {
      parsed.push(value);
      continue;
    }
    const result = schema.safeParse(value);
    if (!result.success) return { ok: false, response: issueResponse(result.error.issues) };
    parsed.push(result.data);
  }
  let body: unknown = {};
  const bodySchema = spec.body?.content["application/json"].schema;
  if (bodySchema) {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return { ok: false, response: invalid("Malformed JSON in request body") };
    }
    const result = bodySchema.safeParse(raw);
    if (!result.success) return { ok: false, response: issueResponse(result.error.issues) };
    body = result.data;
  }
  return {
    ok: true,
    params: parsed[0] as Record<string, string>,
    query: parsed[1] as Record<string, string>,
    body: body as B,
  };
}

function actionOf(name: RouteName): Action {
  return policyOf(ROUTES[name]).action as Action;
}

function mswPath(name: RouteName): string {
  return `*${ROUTES[name].path.replace(/\{([^}]+)\}/g, ":$1")}`;
}

const conflict = (message: string) => apiError(409, "conflict", message);
const storageNotConfigured = () =>
  apiError(
    409,
    "backup_storage_not_configured",
    "Backup storage is not configured; an instance admin sets it under Settings → Backups",
  );

/** 403 `reauth_required` while a test has switched it on. */
function staleSession(): Response | null {
  return db.data.knobs.reauthRequired
    ? apiError(403, "reauth_required", "Confirm your password to continue")
    : null;
}

// -----------------------------------------------------------------------------
// Access
// -----------------------------------------------------------------------------

type Granted<T> =
  | ({ ok: true; guard: Extract<Guard, { ok: true }> } & T)
  | { ok: false; response: Response };

function liveProject(projectId: string): Project | undefined {
  return db.deploy.projects.find((row) => row.id === projectId && !row.deleted);
}

function liveService(serviceId: string): Service | undefined {
  const service = db.deploy.services.find((row) => row.id === serviceId && !row.deleted);
  return service && liveProject(service.project_id) ? service : undefined;
}

/** Resolves the owning workspace and checks the caller, in the API's order. */
function grant(project: Project | undefined, what: string, action: Action): Granted<object> {
  if (!currentUser()) return { ok: false, response: unauthorized() };
  if (!project) return { ok: false, response: notFound(what) };
  const guard = requireWorkspace(project.workspace_id, action);
  // NOTE: Non-members get the same 404 as a missing row, so ids can't be probed.
  if (!guard.ok) {
    return { ok: false, response: guard.response.status === 404 ? notFound(what) : guard.response };
  }
  return { ok: true, guard };
}

function serviceAccess(
  serviceId: string,
  action: Action,
  what = "Service",
): Granted<{ service: Service; project: Project }> {
  const service = liveService(serviceId);
  const project = service ? liveProject(service.project_id) : undefined;
  const granted = grant(project, what, action);
  if (!granted.ok) return granted;
  return { ...granted, service: service!, project: project! };
}

function environmentOf(projectId: string, environmentId: unknown): Environment | undefined {
  return db.deploy.environments.find(
    (row) => row.id === environmentId && row.project_id === projectId,
  );
}

function volumeAccess(
  volumeId: string,
  action: Action,
): Granted<{ service: Service; project: Project; volume: Volume }> {
  const volume = db.data.volumes.find((row) => row.id === volumeId);
  if (!volume) return grant(undefined, "Volume", action) as { ok: false; response: Response };
  const granted = serviceAccess(volume.service_id, action, "Volume");
  return granted.ok ? { ...granted, volume } : granted;
}

function backupAccess(
  backupId: string,
  action: Action,
): Granted<{ service: Service; project: Project; backup: Backup }> {
  const backup = db.data.backups.find((row) => row.id === backupId);
  if (!backup) return grant(undefined, "Backup", action) as { ok: false; response: Response };
  const granted = serviceAccess(backup.service_id, action, "Backup");
  return granted.ok ? { ...granted, backup } : granted;
}

function audit(
  workspaceId: string,
  userId: string,
  action: Parameters<typeof recordAudit>[0]["action"],
  targetType: string,
  targetId: string,
  metadata?: Record<string, unknown>,
) {
  recordAudit({
    workspaceId,
    actorType: "user",
    actorId: userId,
    action,
    targetType,
    targetId,
    metadata,
  });
}

// -----------------------------------------------------------------------------
// Volumes
// -----------------------------------------------------------------------------

const GONE: readonly Volume["status"][] = ["deleted", "abandoned"];
const LIVE: readonly Volume["status"][] = ["pending", "ready", "migrating", "degraded"];

function volumeOf(serviceId: string, environmentId: string): Volume | undefined {
  return db.data.volumes.find(
    (row) =>
      row.service_id === serviceId &&
      row.environment_id === environmentId &&
      !GONE.includes(row.status),
  );
}

function runsIn(serviceId: string, environmentId: string): boolean {
  return db.deploy.deployments.some(
    (row) =>
      row.service_id === serviceId &&
      row.environment_id === environmentId &&
      (row.status === "active" || row.status === "deploying" || row.status === "queued"),
  );
}

function touch(volume: Volume, patch: Partial<Volume>): Volume {
  Object.assign(volume, patch, { updated_at: Date.now() });
  return volume;
}

// -----------------------------------------------------------------------------
// Backups
// -----------------------------------------------------------------------------

const MiB = 1024 * 1024;

/**
 * Moves an in-flight backup one status on, as the workflow would between two reads.
 * A finished one gets sizes and a checksum.
 */
function advanceBackup(backup: Backup): Backup {
  const now = Date.now();
  if (backup.status === "queued") {
    Object.assign(backup, { status: "running", started_at: now, node_id: "node_hel1" });
  } else if (backup.status === "running") {
    Object.assign(backup, {
      status: "succeeded",
      finished_at: now,
      part_count: 1,
      bytes_raw: 420 * MiB,
      bytes_stored: 99 * MiB,
      sha256: "ab".repeat(32),
    });
  }
  return backup;
}

function advanceRestore(restore: Restore): Restore {
  const now = Date.now();
  if (restore.status === "queued") Object.assign(restore, { status: "running", started_at: now });
  else if (restore.status === "running") {
    Object.assign(restore, { status: "succeeded", finished_at: now });
  }
  return restore;
}

function toPolicy(service: Service, environmentId: string): BackupPolicy {
  const stored = db.data.policies.find(
    (row) => row.service_id === service.id && row.environment_id === environmentId,
  );
  const enabled = stored?.enabled ?? false;
  const schedule = stored?.schedule ?? DEFAULT_BACKUP_SCHEDULE;
  const now = Date.now();
  return {
    id: stored?.id ?? null,
    service_id: service.id,
    environment_id: environmentId,
    enabled,
    method: stored?.method ?? (service.database ? "dump" : "snapshot"),
    schedule,
    timezone: "UTC",
    keep_last: stored?.keep_last ?? DEFAULT_BACKUP_KEEP_LAST,
    max_age_days: stored?.max_age_days ?? null,
    quiesce: stored?.quiesce ?? "none",
    databases: stored?.databases ?? null,
    next_run_at: enabled ? nextCronRun(schedule, now) : null,
    next_runs: enabled ? nextCronRuns(schedule, now, 3) : [],
  };
}

function newBackup(
  service: Service,
  environmentId: string,
  fields: Pick<Backup, "trigger" | "pinned" | "requested_by"> & Partial<Backup>,
): Backup {
  const volume = volumeOf(service.id, environmentId);
  db.counter += 1;
  const backup: Backup = {
    // NOTE: The API lists backups newest first by ULID; "z" sorts after the seeded ids.
    id: `bak_z${String(db.counter).padStart(6, "0")}`,
    project_id: service.project_id,
    service_id: service.id,
    environment_id: environmentId,
    volume_id: volume?.id ?? null,
    policy_id: null,
    method: service.database ? "dump" : "snapshot",
    engine: service.database?.engine ?? null,
    engine_version: service.database?.version ?? null,
    status: "queued",
    node_id: null,
    part_count: null,
    bytes_raw: null,
    bytes_stored: null,
    sha256: null,
    error: null,
    scheduled_for: null,
    started_at: null,
    finished_at: null,
    created_at: Date.now(),
    ...fields,
  };
  db.data.backups.push(backup);
  return backup;
}

// -----------------------------------------------------------------------------
// Adding a database
// -----------------------------------------------------------------------------

interface AddDatabaseInput {
  project: Project;
  environment: Environment;
  engine: ServiceDatabaseEngine;
  version: string;
  sizeMb: number | undefined;
  name: string;
  /** Wanted slug; suffixed when taken, as the API does. */
  slug: string;
  userId: string;
  deploy: boolean;
  /** Extra metadata on the change set's audit record, e.g. the backup a restore reads. */
  auditMetadata?: Record<string, unknown>;
}

/**
 * Adds a database service as the API's change set does: the service, its config, a
 * volume and generated credentials in every environment, the audit records, and the
 * first deployment in `environment` when asked.
 */
function addDatabase(input: AddDatabaseInput) {
  const { project, environment, userId } = input;
  const rendered = renderMockDatabase(input.engine, input.version, input.sizeMb);
  const now = Date.now();
  const taken = new Set(
    db.deploy.services
      .filter((row) => row.project_id === project.id && !row.deleted)
      .map((row) => row.slug),
  );
  const service: Service = {
    id: nextId("svc"),
    project_id: project.id,
    name: input.name,
    slug: freeSlug(taken, input.slug, RESERVED_SERVICE_SLUGS),
    kind: "database",
    icon: DATABASE_ENGINE_SPECS[input.engine].icon,
    database: { engine: input.engine, version: input.version },
    created_at: now,
    updated_at: now,
  };
  db.deploy.services.push(service);
  const environments = db.deploy.environments.filter((row) => row.project_id === project.id);
  const volumes: Volume[] = [];
  for (const env of environments) {
    const config = {
      id: nextId("cfg"),
      service_id: service.id,
      environment_id: env.id,
      version: 1,
      created_by: userId,
      created_at: now,
      ...rendered.config,
    } as ServiceConfig;
    db.deploy.configs.push(config);
    const volume = makeVolume({
      id: nextId("vol"),
      project_id: project.id,
      environment_id: env.id,
      service_id: service.id,
      mount_path: rendered.volume.mount_path,
      size_mb: rendered.volume.size_mb,
    });
    db.data.volumes.push(volume);
    volumes.push(volume);
    db.deploy.variables.push(
      ...rendered.variables.map(
        (v): DbVariable => ({
          scope: "service",
          owner_id: service.id,
          environment_id: env.id,
          key: v.key,
          value: v.value,
          tier: v.secret ? "secret" : "plain",
          locked: false,
          available_at_build: false,
          mount_as_file: false,
          version: 1,
          updated_at: now,
          updated_by: userId,
        }),
      ),
    );
  }
  const changeSetId = nextId("chg");
  const workspaceId = project.workspace_id;
  audit(workspaceId, userId, "change_set.created", "change_set", changeSetId, {
    project_id: project.id,
    environment_id: environment.id,
    source: "api",
    ops: 1,
    engine: input.engine,
    ...input.auditMetadata,
  });
  audit(workspaceId, userId, "service.created", "service", service.id, {
    name: service.name,
    project_id: project.id,
  });
  audit(workspaceId, userId, "change_set.applied", "change_set", changeSetId, {
    project_id: project.id,
    environment_id: environment.id,
  });
  const deploymentIds: string[] = [];
  if (input.deploy) {
    const config = db.deploy.configs.find(
      (row) => row.service_id === service.id && row.environment_id === environment.id,
    )!;
    const deployment = startDeployment(
      service,
      environment.id,
      config,
      undefined,
      "manual",
      userId,
    );
    deploymentIds.push(deployment.id);
    audit(workspaceId, userId, "deployment.created", "deployment", deployment.id, {
      service_id: service.id,
      environment_id: environment.id,
    });
  }
  return { service, volumes, rendered, changeSetId, deploymentIds };
}

// -----------------------------------------------------------------------------
// Volume moves
// -----------------------------------------------------------------------------

/** Statuses the API moves a volume from. */
const MOVABLE: readonly Volume["status"][] = ["ready", "degraded"];

/** Copy throughput the downtime estimate assumes without a previous backup. */
const COPY_BYTES_PER_S = 20 * MiB;

function nodeById(nodeId: string | null) {
  return db.nodes.find((row) => row.id === nodeId);
}

/** Why a node can't take a volume, in the API's words; `null` when it can. */
function ineligibility(node: (typeof db.nodes)[number], volume: Volume): string | null {
  if (node.id === volume.node_id) return "It already holds the volume";
  if (node.status !== "online") return "It isn't online";
  if (!node.capabilities?.docker) return "It doesn't run Docker workloads";
  return null;
}

/** Volume statuses a recovery replaces, as in `lib/backups/recovery.ts`. */
const RECOVERABLE: readonly Volume["status"][] = ["pending", "ready", "degraded", "error"];

/**
 * Mirrors `startVolumeRecovery`: an `in_place` restore onto another node because the
 * volume's node is lost. The old volume is abandoned and an empty one is pinned to the
 * target; the restore then advances like any other.
 */
function recoverVolume(
  found: Extract<ReturnType<typeof backupAccess>, { ok: true }>,
  targetNodeId: string,
): Response {
  const { backup, project, guard } = found;
  if (
    !can(guard.membership.role, "services:manage") ||
    !can(guard.membership.role, "deployments:create")
  ) {
    return apiError(
      403,
      "forbidden",
      "Recovering onto another server replaces the volume and redeploys: it needs services:manage and deployments:create",
    );
  }
  const volume = volumeOf(backup.service_id, backup.environment_id);
  if (!volume?.node_id) {
    return conflict("The service has no placed volume in this environment; deploy it instead");
  }
  if (!RECOVERABLE.includes(volume.status)) {
    return conflict(`The volume is ${volume.status.replace(/_/g, " ")}; it can't be recovered`);
  }
  const source = nodeById(volume.node_id);
  if (source && source.status !== "offline") {
    return conflict(
      `The volume's server ${source.name} is ${source.status}; recovery is for a lost server. Move the volume instead, which keeps every write`,
    );
  }
  const target = db.nodes.find(
    (row) => row.id === targetNodeId && row.workspace_id === project.workspace_id,
  );
  if (!target) return notFound("Node");
  const reason = ineligibility(target, volume);
  if (reason) return apiError(422, "migration_target_ineligible", `${target.name}: ${reason}`);
  const now = Date.now();
  touch(volume, { status: "abandoned" });
  const fresh: Volume = {
    ...volume,
    id: nextId("vol"),
    node_id: target.id,
    node_name: target.name,
    status: "pending",
    quota_mode: null,
    used_bytes: null,
    message: null,
    reported_at: null,
    delete_after: null,
    created_at: now,
    updated_at: now,
  };
  db.data.volumes.push(fresh);
  const restore: Restore = {
    id: nextId("rst"),
    backup_id: backup.id,
    mode: "in_place",
    target_service_id: backup.service_id,
    target_environment_id: backup.environment_id,
    safety_backup_id: null,
    target_node_id: target.id,
    status: "queued",
    error: null,
    requested_by: guard.user.id,
    started_at: null,
    finished_at: null,
    created_at: now,
  };
  db.data.restores.push(restore);
  audit(project.workspace_id, guard.user.id, "restore.started", "restore", restore.id, {
    project_id: project.id,
    backup_id: backup.id,
    mode: "in_place",
    service_id: backup.service_id,
    environment_id: backup.environment_id,
    safety_backup_id: null,
    recovery: {
      lost_node_id: volume.node_id,
      target_node_id: target.id,
      abandoned_volume_id: volume.id,
      volume_id: fresh.id,
    },
  });
  return HttpResponse.json(restore, { status: 202 });
}

function migrationTargetsOf(volume: Volume, workspaceId: string): MigrationTargets {
  const bytes = volume.used_bytes ?? volume.size_mb * MiB;
  return {
    volume_id: volume.id,
    source_node_id: volume.node_id,
    estimated_downtime_ms: Math.round(((2 * bytes) / COPY_BYTES_PER_S) * 1000) + 60_000,
    targets: db.nodes
      .filter((node) => node.workspace_id === workspaceId)
      .map((node) => {
        const reason = ineligibility(node, volume);
        return {
          node_id: node.id,
          name: node.name,
          eligible: reason === null,
          reason,
          quota_mode: node.status === "online" ? ("xfs_project" as const) : null,
        };
      }),
  };
}

/**
 * Moves a running migration one phase on, as the workflow would between two reads. With
 * `failMigrations` set it fails after the copy out and rolls back to the source.
 */
function advanceMigration(migration: VolumeMigration): VolumeMigration {
  if (migration.status === "succeeded" || migration.status === "failed") return migration;
  const volume = db.data.volumes.find((row) => row.id === migration.volume_id);
  const service = liveService(migration.service_id);
  const project = service ? liveProject(service.project_id) : undefined;
  const bytes = volume?.used_bytes ?? (volume?.size_mb ?? 0) * MiB;
  const now = Date.now();
  const system = (action: "volume.migrated" | "volume.migration_failed") => {
    if (!project) return;
    recordAudit({
      workspaceId: project.workspace_id,
      actorType: "system",
      actorId: null,
      action,
      targetType: "volume",
      targetId: migration.volume_id,
      metadata: { migration_id: migration.id, service_id: migration.service_id },
    });
  };
  switch (migration.phase) {
    case "queued":
      Object.assign(migration, { status: "running", phase: "preparing_target", started_at: now });
      break;
    case "preparing_target":
      migration.phase = "stopping";
      break;
    case "stopping":
      Object.assign(migration, { phase: "copying_out", copied_bytes: Math.round(bytes / 2) });
      break;
    case "copying_out":
      if (db.data.knobs.failMigrations) {
        Object.assign(migration, {
          phase: "rolling_back",
          error: "The copy on the target didn't match its SHA-256",
        });
      } else {
        Object.assign(migration, { phase: "copying_in", copied_bytes: bytes });
      }
      break;
    case "copying_in": {
      const snapshot = service
        ? newBackup(service, migration.environment_id, {
            trigger: "migration",
            pinned: false,
            requested_by: migration.requested_by,
            method: "snapshot",
            status: "succeeded",
            node_id: migration.source_node_id,
            started_at: migration.started_at,
            finished_at: now,
            part_count: 1,
            bytes_raw: bytes,
            bytes_stored: Math.round(bytes / 4),
            sha256: "c3".repeat(32),
          })
        : null;
      Object.assign(migration, { phase: "starting", backup_id: snapshot?.id ?? null });
      break;
    }
    case "starting": {
      const target = nodeById(migration.target_node_id);
      Object.assign(migration, {
        phase: "done",
        status: "succeeded",
        finished_at: now,
        cleanup_after: now + VOLUME_DELETE_GRACE_MS,
      });
      if (volume) {
        touch(volume, {
          status: "ready",
          node_id: migration.target_node_id,
          node_name: target?.name ?? null,
        });
      }
      system("volume.migrated");
      break;
    }
    case "rolling_back":
      Object.assign(migration, { status: "failed", finished_at: now });
      if (volume) touch(volume, { status: "ready" });
      system("volume.migration_failed");
      break;
    case "done":
      break;
  }
  return migration;
}

// -----------------------------------------------------------------------------
// TCP proxies
// -----------------------------------------------------------------------------

/** First public port the mock hands out, inside `TCP_PROXY_PORT_RANGE`. */
const FIRST_PUBLIC_PORT = 24_101;

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);
}

function intToIpv4(n: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join(".");
}

/**
 * Validates and normalises an allowlist as the API does: a bare address becomes a /32
 * (or /128), IPv4 host bits are cleared, duplicates dropped.
 */
function normalizeAllowlist(
  input: readonly string[],
  acknowledgeOpen: boolean,
): string[] | Response {
  const out: string[] = [];
  const invalid: string[] = [];
  for (const raw of input) {
    const entry = raw.trim().toLowerCase();
    if (!isAllowlistEntry(entry)) {
      invalid.push(raw);
      continue;
    }
    const [address = "", bits] = entry.split("/");
    const v4 = !address.includes(":");
    let normalized = `${address}/${bits ?? (v4 ? "32" : "128")}`;
    if (v4) {
      const size = 2 ** (32 - Number(bits ?? 32));
      normalized = `${intToIpv4(Math.floor(ipv4ToInt(address) / size) * size)}/${bits ?? 32}`;
    }
    if (!out.includes(normalized)) out.push(normalized);
  }
  if (invalid.length > 0) {
    return apiError(
      422,
      "invalid_request",
      `Not an IP address or CIDR block: ${invalid.slice(0, 5).join(", ")}`,
      invalid.map((value) => ({ field: "allowed_cidrs", code: "invalid_cidr", message: value })),
    );
  }
  if (out.some((cidr) => cidr.endsWith("/0")) && !acknowledgeOpen) {
    return apiError(
      422,
      "confirmation_required",
      "0.0.0.0/0 opens the port to the whole internet, unencrypted unless the client and the database negotiate TLS; send acknowledge_open to continue",
    );
  }
  return out;
}

/** The node running a service's active replica in an environment. */
function replicaNode(serviceId: string, environmentId: string) {
  const deployment = db.deploy.deployments.find(
    (row) =>
      row.service_id === serviceId &&
      row.environment_id === environmentId &&
      row.status === "active",
  );
  const placement = deployment
    ? db.deploy.placements.find((row) => row.deployment_id === deployment.id)
    : undefined;
  return placement ? nodeById(placement.node_id) : undefined;
}

function presentTcpProxy(proxy: TcpProxy): TcpProxy {
  const node = replicaNode(proxy.service_id, proxy.environment_id);
  return {
    ...proxy,
    host: node ? (node.hostname ?? node.public_ip) : null,
    node_id: node?.id ?? null,
    status: !node ? "pending" : db.data.knobs.tcpProxyUnsupported ? "unsupported" : "active",
    open_to_all: proxy.allowed_cidrs.some((cidr) => cidr.endsWith("/0")),
  };
}

function tcpProxyOf(serviceId: string, environmentId: string): TcpProxy | undefined {
  return db.data.tcpProxies.find(
    (row) => row.service_id === serviceId && row.environment_id === environmentId,
  );
}

// -----------------------------------------------------------------------------
// Credential rotations
// -----------------------------------------------------------------------------

/** Services of the project whose variables reference one of this service's. */
function servicesReferencing(service: Service, environmentId: string): Service[] {
  const marker = `\${{${service.slug}.`;
  const ids = new Set(
    db.deploy.variables
      .filter(
        (row) =>
          row.scope === "service" &&
          row.owner_id !== service.id &&
          row.environment_id === environmentId &&
          row.value.includes(marker),
      )
      .map((row) => row.owner_id),
  );
  return db.deploy.services.filter(
    (row) => ids.has(row.id) && row.project_id === service.project_id && !row.deleted,
  );
}

// -----------------------------------------------------------------------------
// Data browser
// -----------------------------------------------------------------------------

type Result = Omit<DatabaseQueryResult, "request_id" | "duration_ms">;

const column = (name: string, type = "text") => ({ name, type });

function engineError(error: string): Result {
  return { ok: false, error };
}

/**
 * Answers one data-browser operation from the seeded relations. Raw statements
 * understand `SELECT … FROM [ns.]table` and literal `SELECT`s; anything that writes is
 * refused in read mode as PostgreSQL would.
 */
function runOp(
  serviceId: string,
  op: DatabaseQueryOp,
  mode: "read" | "write",
  maxRows: number,
): Result {
  const tables = db.data.tables[serviceId] ?? [];
  const find = (namespace: string | undefined, table: string) =>
    tables.find((t) => t.name === table && t.namespace === (namespace ?? "public"));
  switch (op.type) {
    case "list_namespaces": {
      const names = [...new Set(tables.map((t) => t.namespace))].sort();
      const rows = names.map((name) => [name, "postgres"]);
      return { ok: true, columns: [column("name"), column("owner")], rows, row_count: rows.length };
    }
    case "list_tables": {
      const rows = tables
        .filter((t) => t.namespace === (op.namespace ?? "public"))
        .map((t) => [t.name, t.type, String(t.rows.length)]);
      return {
        ok: true,
        columns: [column("name"), column("type"), column("estimated_rows", "bigint")],
        rows,
        row_count: rows.length,
      };
    }
    case "describe": {
      const table = find(op.namespace, op.table);
      if (!table) return engineError(`relation "${op.table}" does not exist`);
      const rows = table.columns.map((c, i) => [c.name, c.type, i !== 0, null, i === 0]);
      return {
        ok: true,
        columns: [
          column("name"),
          column("type"),
          column("nullable", "boolean"),
          column("default"),
          column("primary_key", "boolean"),
        ],
        rows,
        row_count: rows.length,
      };
    }
    case "rows": {
      const table = find(op.namespace, op.table);
      if (!table)
        return engineError(`relation "${op.namespace ?? "public"}.${op.table}" does not exist`);
      let rows = [...table.rows];
      if (op.order_by) {
        const index = table.columns.findIndex((c) => c.name === op.order_by);
        if (index < 0) return engineError(`column "${op.order_by}" does not exist`);
        rows.sort((a, b) =>
          String(a[index]).localeCompare(String(b[index]), undefined, { numeric: true }),
        );
        if (op.descending) rows.reverse();
      }
      rows = rows.slice(op.offset);
      const page = rows.slice(0, maxRows);
      return {
        ok: true,
        columns: table.columns,
        rows: page,
        row_count: page.length,
        truncated: rows.length > maxRows,
      };
    }
    case "raw": {
      const statement = (op.statement ?? op.argv?.join(" ") ?? "").trim();
      const verb = statement.split(/\s+/)[0]?.toUpperCase() ?? "";
      if (verb !== "SELECT" && verb !== "WITH" && verb !== "SHOW" && verb !== "EXPLAIN") {
        if (mode === "read") {
          return engineError(`cannot execute ${verb} in a read-only transaction`);
        }
        return { ok: true, columns: [], rows: [], row_count: 0, notice: `${verb} 0` };
      }
      const from = /\bfrom\s+(?:"?(\w+)"?\.)?"?(\w+)"?/i.exec(statement);
      if (from) {
        const table = find(from[1], from[2]!);
        if (!table) return engineError(`relation "${from[2]}" does not exist`);
        const page = table.rows.slice(0, maxRows);
        return {
          ok: true,
          columns: table.columns,
          rows: page,
          row_count: page.length,
          truncated: table.rows.length > maxRows,
        };
      }
      return {
        ok: true,
        columns: [column("?column?", "integer")],
        rows: [[1]],
        row_count: 1,
      };
    }
  }
}

/** Shared checks of both data-browser routes after access: a running database. */
function queryTarget(service: Service, environmentId: string): Response | null {
  if (!service.database) return conflict("This service is not a database");
  if (db.data.knobs.offline.has(service.id)) {
    return apiError(503, "node_offline", "The database's server is unavailable");
  }
  const active = db.deploy.deployments.some(
    (row) =>
      row.service_id === service.id &&
      row.environment_id === environmentId &&
      row.status === "active",
  );
  if (!active) return conflict("The database is not running in this environment");
  return null;
}

let requestSequence = 0;

function queryResult(result: Result, started: number): DatabaseQueryResult {
  requestSequence += 1;
  return {
    request_id: `q${String(requestSequence).padStart(12, "0")}`,
    ...result,
    duration_ms: Math.max(1, Math.round(performance.now() - started)) + 3,
  };
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

interface CreateDatabaseInput {
  engine: keyof typeof DATABASE_ENGINE_SPECS;
  version?: string;
  size_mb?: number;
  environment_id: string;
  name?: string;
  slug?: string;
  deploy: boolean;
}

interface QueryInput {
  environment_id: string;
  mode: "read" | "write";
  op: DatabaseQueryOp;
  max_rows?: number;
  timeout_ms?: number;
}

interface PolicyInput {
  environment_id: string;
  enabled?: boolean;
  schedule?: string;
  keep_last?: number;
  max_age_days?: number | null;
  quiesce?: "none" | "stop";
  databases?: string[] | null;
}

interface RestoreInput {
  mode: "in_place" | "new_service";
  target_environment_id?: string;
  slug?: string;
  confirm: string;
  skip_safety_backup?: boolean;
  target_node_id?: string;
}

interface StorageInput {
  endpoint: string;
  bucket: string;
  region?: string;
  access_key_id: string;
  secret_access_key?: string;
}

function storageView() {
  const s = db.data.storage;
  return {
    configured: s !== null,
    endpoint: s?.endpoint ?? null,
    bucket: s?.bucket ?? null,
    region: s?.region ?? null,
    access_key_id: s?.access_key_id ?? null,
    secret_access_key_set: Boolean(s?.secret_access_key),
  };
}

function requireInstanceAdmin(): Response | null {
  const user = currentUser();
  if (!user) return unauthorized();
  return user.instance_admin
    ? null
    : apiError(403, "forbidden", "Only instance admins can perform instance:manage");
}

/** Data-service route handlers: databases and volumes, the data browser, backups. */
export const dataHandlers = [
  // ---------------------------------------------------------------------------
  // Databases and volumes
  // ---------------------------------------------------------------------------
  http.post(mswPath("createDatabase"), async ({ request, params }) => {
    const input = await validate<CreateDatabaseInput>("createDatabase", request, params);
    if (!input.ok) return input.response;
    const body = input.body;
    const project = liveProject(input.params.projectId ?? "");
    const granted = grant(project, "Project", actionOf("createDatabase"));
    if (!granted.ok) return granted.response;
    const environment = environmentOf(project!.id, body.environment_id);
    if (!environment) return notFound("Environment");
    const role = granted.guard.membership.role;
    for (const action of ["variables:manage", ...(body.deploy ? ["deployments:create"] : [])]) {
      if (!can(role, action as Action)) {
        return apiError(403, "forbidden", `Adding a database needs ${action}, which you lack here`);
      }
    }
    const version = databaseVersion(body.engine, body.version);
    if (!version) {
      return apiError(
        404,
        "not_found",
        `${DATABASE_ENGINE_SPECS[body.engine].name} has no version ${body.version}`,
      );
    }
    const added = addDatabase({
      project: project!,
      environment,
      engine: body.engine,
      version: version.version,
      sizeMb: body.size_mb,
      name: body.name ?? DATABASE_ENGINE_SPECS[body.engine].name,
      slug:
        body.slug ?? slugify(body.name ?? DATABASE_ENGINE_SPECS[body.engine].name, 40, "service"),
      userId: granted.guard.user.id,
      deploy: body.deploy,
    });
    const { service } = added;
    broadcastRealtime(project!.id, { type: "service.updated", service });
    return HttpResponse.json(
      {
        change_set_id: added.changeSetId,
        service,
        engine: body.engine,
        version: version.version,
        volumes: added.volumes,
        variables: added.rendered.variables
          .map((v) => ({ key: v.key, secret: v.secret }))
          .sort((a, b) => (a.key < b.key ? -1 : 1)),
        deployment_ids: added.deploymentIds,
        skipped: [],
      },
      { status: 201 },
    );
  }),

  http.get(mswPath("getServiceVolume"), async ({ request, params }) => {
    const input = await validate("getServiceVolume", request, params);
    if (!input.ok) return input.response;
    const found = serviceAccess(input.params.serviceId ?? "", actionOf("getServiceVolume"));
    if (!found.ok) return found.response;
    if (!environmentOf(found.project.id, input.query.environment_id)) {
      return notFound("Environment");
    }
    const volume = volumeOf(found.service.id, input.query.environment_id!);
    return volume ? HttpResponse.json(volume) : notFound("Volume");
  }),

  http.patch(mswPath("resizeVolume"), async ({ request, params }) => {
    const input = await validate<{ size_mb: number }>("resizeVolume", request, params);
    if (!input.ok) return input.response;
    const found = volumeAccess(input.params.volumeId ?? "", actionOf("resizeVolume"));
    if (!found.ok) return found.response;
    const volume = found.volume;
    if (!LIVE.includes(volume.status)) {
      return conflict(`The volume is ${volume.status.replace(/_/g, " ")}`);
    }
    if (input.body.size_mb < volume.size_mb) {
      return apiError(
        422,
        "volume_shrink_unsupported",
        `Volumes only grow; it is ${volume.size_mb} MiB`,
      );
    }
    const from = volume.size_mb;
    touch(volume, { size_mb: input.body.size_mb });
    audit(found.project.workspace_id, found.guard.user.id, "volume.resized", "volume", volume.id, {
      service_id: volume.service_id,
      environment_id: volume.environment_id,
      from_mb: from,
      to_mb: volume.size_mb,
    });
    return HttpResponse.json(volume);
  }),

  http.delete(mswPath("deleteVolume"), async ({ request, params }) => {
    const input = await validate("deleteVolume", request, params);
    if (!input.ok) return input.response;
    const found = volumeAccess(input.params.volumeId ?? "", actionOf("deleteVolume"));
    if (!found.ok) return found.response;
    const volume = found.volume;
    if (!LIVE.includes(volume.status)) {
      return conflict(`The volume is ${volume.status.replace(/_/g, " ")}`);
    }
    if (runsIn(volume.service_id, volume.environment_id)) {
      return conflict("The service still runs here; scale it to 0 or delete it first");
    }
    touch(volume, {
      status: "pending_deletion",
      delete_after: Date.now() + VOLUME_DELETE_GRACE_MS,
    });
    audit(found.project.workspace_id, found.guard.user.id, "volume.deleted", "volume", volume.id, {
      service_id: volume.service_id,
      environment_id: volume.environment_id,
      delete_after: volume.delete_after,
    });
    return HttpResponse.json(volume);
  }),

  http.post(mswPath("undeleteVolume"), async ({ request, params }) => {
    const input = await validate("undeleteVolume", request, params);
    if (!input.ok) return input.response;
    const found = volumeAccess(input.params.volumeId ?? "", actionOf("undeleteVolume"));
    if (!found.ok) return found.response;
    const volume = found.volume;
    if (volume.status !== "pending_deletion") return conflict("The volume is not deleted");
    touch(volume, { status: volume.node_id ? "ready" : "pending", delete_after: null });
    audit(
      found.project.workspace_id,
      found.guard.user.id,
      "volume.undeleted",
      "volume",
      volume.id,
      {
        service_id: volume.service_id,
        environment_id: volume.environment_id,
      },
    );
    return HttpResponse.json(volume);
  }),

  // ---------------------------------------------------------------------------
  // Volume moves
  // ---------------------------------------------------------------------------
  http.get(mswPath("listMigrationTargets"), async ({ request, params }) => {
    const input = await validate("listMigrationTargets", request, params);
    if (!input.ok) return input.response;
    const found = volumeAccess(input.params.volumeId ?? "", actionOf("listMigrationTargets"));
    if (!found.ok) return found.response;
    return HttpResponse.json(migrationTargetsOf(found.volume, found.project.workspace_id));
  }),

  http.post(mswPath("migrateVolume"), async ({ request, params }) => {
    const input = await validate<{ target_node_id: string; confirm: string }>(
      "migrateVolume",
      request,
      params,
    );
    if (!input.ok) return input.response;
    const found = volumeAccess(input.params.volumeId ?? "", actionOf("migrateVolume"));
    if (!found.ok) return found.response;
    if (!can(found.guard.membership.role, "deployments:create")) {
      return apiError(
        403,
        "forbidden",
        "Moving a volume redeploys its service: it needs deployments:create",
      );
    }
    const stale = staleSession();
    if (stale) return stale;
    const { volume, service, project } = found;
    if (input.body.confirm !== service.slug) {
      return invalid("confirm must equal the service's slug");
    }
    if (!db.data.storage) return storageNotConfigured();
    if (!volume.node_id || !MOVABLE.includes(volume.status)) {
      return conflict(
        `The volume is ${volume.status.replace(/_/g, " ")}; only a ready volume moves`,
      );
    }
    const target = db.nodes.find(
      (row) => row.id === input.body.target_node_id && row.workspace_id === project.workspace_id,
    );
    if (!target) return notFound("Node");
    const reason = ineligibility(target, volume);
    if (reason) {
      return apiError(422, "migration_target_ineligible", `${target.name}: ${reason}`);
    }
    const now = Date.now();
    const migration: VolumeMigration = {
      id: nextId("mig"),
      volume_id: volume.id,
      service_id: volume.service_id,
      environment_id: volume.environment_id,
      source_node_id: volume.node_id,
      target_node_id: target.id,
      status: "queued",
      phase: "queued",
      backup_id: null,
      deployment_id: null,
      copied_bytes: null,
      error: null,
      requested_by: found.guard.user.id,
      cleanup_after: null,
      started_at: null,
      finished_at: null,
      created_at: now,
    };
    db.data.migrations.push(migration);
    touch(volume, { status: "migrating" });
    audit(
      project.workspace_id,
      found.guard.user.id,
      "volume.migration_started",
      "volume",
      volume.id,
      {
        project_id: project.id,
        service_id: volume.service_id,
        environment_id: volume.environment_id,
        migration_id: migration.id,
        source_node_id: volume.node_id,
        target_node_id: target.id,
        size_mb: volume.size_mb,
      },
    );
    return HttpResponse.json(migration, { status: 202 });
  }),

  http.get(mswPath("listVolumeMigrations"), async ({ request, params }) => {
    const input = await validate("listVolumeMigrations", request, params);
    if (!input.ok) return input.response;
    const found = volumeAccess(input.params.volumeId ?? "", actionOf("listVolumeMigrations"));
    if (!found.ok) return found.response;
    const migrations = db.data.migrations
      .filter((row) => row.volume_id === found.volume.id)
      .reverse()
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 20);
    return HttpResponse.json({ migrations });
  }),

  http.get(mswPath("getVolumeMigration"), async ({ request, params }) => {
    const input = await validate("getVolumeMigration", request, params);
    if (!input.ok) return input.response;
    const migration = db.data.migrations.find((row) => row.id === input.params.migrationId);
    if (!migration) return currentUser() ? notFound("Volume migration") : unauthorized();
    const found = volumeAccess(migration.volume_id, actionOf("getVolumeMigration"));
    if (!found.ok) {
      return found.response.status === 404 ? notFound("Volume migration") : found.response;
    }
    return HttpResponse.json(advanceMigration(migration));
  }),

  // ---------------------------------------------------------------------------
  // TCP proxies
  // ---------------------------------------------------------------------------
  http.get(mswPath("getTcpProxy"), async ({ request, params }) => {
    const input = await validate("getTcpProxy", request, params);
    if (!input.ok) return input.response;
    const found = serviceAccess(input.params.serviceId ?? "", actionOf("getTcpProxy"));
    if (!found.ok) return found.response;
    const env = environmentOf(found.project.id, input.query.environment_id);
    if (!env) return notFound("Environment");
    const proxy = tcpProxyOf(found.service.id, env.id);
    return proxy ? HttpResponse.json(presentTcpProxy(proxy)) : notFound("TCP proxy");
  }),

  http.put(mswPath("putTcpProxy"), async ({ request, params }) => {
    const input = await validate<{
      environment_id: string;
      container_port?: number;
      allowed_cidrs: string[];
      acknowledge_open?: boolean;
    }>("putTcpProxy", request, params);
    if (!input.ok) return input.response;
    const body = input.body;
    const found = serviceAccess(input.params.serviceId ?? "", actionOf("putTcpProxy"));
    if (!found.ok) return found.response;
    const env = environmentOf(found.project.id, body.environment_id);
    if (!env) return notFound("Environment");
    const stale = staleSession();
    if (stale) return stale;
    const { service, project } = found;
    const allowed = normalizeAllowlist(body.allowed_cidrs, body.acknowledge_open ?? false);
    if (allowed instanceof Response) return allowed;
    const config = db.deploy.configs
      .filter((row) => row.service_id === service.id && row.environment_id === env.id)
      .sort((a, b) => b.version - a.version)[0];
    if (!config) return conflict(`${service.name} has no config in ${env.name}`);
    if (config.deploy.replicas > 1) {
      return apiError(
        422,
        "volume_requires_single_replica",
        "Only a single-replica service can publish a TCP port; scale it to one replica first",
      );
    }
    const node = replicaNode(service.id, env.id);
    if (node && db.data.knobs.tcpProxyUnsupported) {
      return apiError(
        409,
        "tcp_proxy_unsupported",
        `The agent on ${node.name} can't enforce a source allowlist; upgrade it to publish ports`,
      );
    }
    const containerPort =
      body.container_port ??
      config.networking.port ??
      (service.database ? DATABASE_ENGINE_SPECS[service.database.engine].port : 8080);
    const existing = tcpProxyOf(service.id, env.id);
    const now = Date.now();
    let saved: TcpProxy;
    if (existing) {
      saved = Object.assign(existing, {
        container_port: containerPort,
        allowed_cidrs: allowed,
        updated_at: now,
      });
    } else {
      const used = new Set(db.data.tcpProxies.map((row) => row.public_port));
      let port = FIRST_PUBLIC_PORT;
      while (used.has(port)) port += 1;
      saved = {
        id: nextId("tcp"),
        service_id: service.id,
        environment_id: env.id,
        container_port: containerPort,
        public_port: port,
        allowed_cidrs: allowed,
        host: null,
        node_id: null,
        status: "pending",
        open_to_all: false,
        created_at: now,
        updated_at: now,
      };
      db.data.tcpProxies.push(saved);
    }
    audit(
      project.workspace_id,
      found.guard.user.id,
      existing ? "tcp_proxy.updated" : "tcp_proxy.enabled",
      "service",
      service.id,
      {
        project_id: project.id,
        environment_id: env.id,
        tcp_proxy_id: saved.id,
        container_port: containerPort,
        public_port: saved.public_port,
        allowed_cidrs: allowed,
        open_to_all: allowed.some((cidr) => cidr.endsWith("/0")),
      },
    );
    return HttpResponse.json(presentTcpProxy(saved));
  }),

  http.delete(mswPath("deleteTcpProxy"), async ({ request, params }) => {
    const input = await validate("deleteTcpProxy", request, params);
    if (!input.ok) return input.response;
    const found = serviceAccess(input.params.serviceId ?? "", actionOf("deleteTcpProxy"));
    if (!found.ok) return found.response;
    const env = environmentOf(found.project.id, input.query.environment_id);
    if (!env) return notFound("Environment");
    const proxy = tcpProxyOf(found.service.id, env.id);
    if (!proxy) return notFound("TCP proxy");
    db.data.tcpProxies = db.data.tcpProxies.filter((row) => row !== proxy);
    audit(
      found.project.workspace_id,
      found.guard.user.id,
      "tcp_proxy.disabled",
      "service",
      found.service.id,
      {
        project_id: found.project.id,
        environment_id: env.id,
        tcp_proxy_id: proxy.id,
        public_port: proxy.public_port,
      },
    );
    return new HttpResponse(null, { status: 204 });
  }),

  // ---------------------------------------------------------------------------
  // Credential rotations
  // ---------------------------------------------------------------------------
  http.post(mswPath("rotateDatabaseCredentials"), async ({ request, params }) => {
    const input = await validate<{
      environment_id: string;
      principals?: DatabasePrincipal[];
      confirm: string;
    }>("rotateDatabaseCredentials", request, params);
    if (!input.ok) return input.response;
    const body = input.body;
    const found = serviceAccess(
      input.params.serviceId ?? "",
      actionOf("rotateDatabaseCredentials"),
    );
    if (!found.ok) return found.response;
    const { service, project } = found;
    const userId = found.guard.user.id;
    for (const action of ["variables:manage", "deployments:create"] as const) {
      if (!can(found.guard.membership.role, action)) {
        return apiError(
          403,
          "forbidden",
          `Rotating credentials stores variables and redeploys: it needs ${action}`,
        );
      }
    }
    const env = environmentOf(project.id, body.environment_id);
    if (!env) return notFound("Environment");
    const stale = staleSession();
    if (stale) return stale;
    if (body.confirm !== service.slug) return invalid("confirm must equal the service's slug");
    if (!service.database) return conflict("This service is not a database");
    const engine = service.database.engine;
    const available = databasePrincipals(engine).map((p) => p.principal);
    const unknown = body.principals?.find((principal) => !available.includes(principal));
    if (unknown) {
      return apiError(
        422,
        "invalid_request",
        `${DATABASE_ENGINE_SPECS[engine].name} has no ${unknown} principal`,
      );
    }
    const refused = queryTarget(service, env.id);
    if (refused) return refused;
    const now = Date.now();
    let rotation = db.data.rotations.find(
      (row) =>
        row.service_id === service.id && row.environment_id === env.id && row.status === "running",
    );
    if (!rotation) {
      const wanted = body.principals ?? available;
      rotation = {
        id: nextId("rot"),
        service_id: service.id,
        environment_id: env.id,
        status: "running",
        principals: available.filter((principal) => wanted.includes(principal)),
        applied: [],
        change_set_id: null,
        deployment_ids: [],
        error: null,
        requested_by: userId,
        created_at: now,
        finished_at: null,
      };
      db.data.rotations.push(rotation);
    }
    if (db.data.knobs.interruptRotation) {
      db.data.knobs.interruptRotation = false;
      Object.assign(rotation, {
        applied: rotation.principals.slice(0, 1),
        error: "The database's server didn't answer in time",
      });
      return apiError(
        504,
        "query_timeout",
        "The database's server didn't answer; the rotation is kept and the next request finishes it",
      );
    }
    const changeSetId = nextId("chg");
    const deploymentIds = [service, ...servicesReferencing(service, env.id)].flatMap((target) => {
      const config = db.deploy.configs
        .filter((row) => row.service_id === target.id && row.environment_id === env.id)
        .sort((a, b) => b.version - a.version)[0];
      return config
        ? [startDeployment(target, env.id, config, undefined, "change_set", userId).id]
        : [];
    });
    Object.assign(rotation, {
      status: "succeeded",
      applied: [...rotation.principals],
      change_set_id: changeSetId,
      deployment_ids: deploymentIds,
      error: null,
      finished_at: now,
    });
    audit(project.workspace_id, userId, "change_set.created", "change_set", changeSetId, {
      project_id: project.id,
      environment_id: env.id,
      source: "api",
    });
    audit(project.workspace_id, userId, "change_set.applied", "change_set", changeSetId, {
      project_id: project.id,
      environment_id: env.id,
    });
    audit(project.workspace_id, userId, "database.credentials_rotated", "service", service.id, {
      environment_id: env.id,
      rotation_id: rotation.id,
      principals: rotation.principals,
      deployment_ids: deploymentIds,
    });
    return HttpResponse.json(rotation);
  }),

  http.get(mswPath("listCredentialRotations"), async ({ request, params }) => {
    const input = await validate("listCredentialRotations", request, params);
    if (!input.ok) return input.response;
    const found = serviceAccess(input.params.serviceId ?? "", actionOf("listCredentialRotations"));
    if (!found.ok) return found.response;
    const env = environmentOf(found.project.id, input.query.environment_id);
    if (!env) return notFound("Environment");
    const rotations = db.data.rotations
      .filter((row) => row.service_id === found.service.id && row.environment_id === env.id)
      .reverse()
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 20);
    return HttpResponse.json({ rotations });
  }),

  // ---------------------------------------------------------------------------
  // Data browser
  // ---------------------------------------------------------------------------
  http.post(mswPath("runDatabaseQuery"), async ({ request, params }) => {
    const started = performance.now();
    const input = await validate<QueryInput>("runDatabaseQuery", request, params);
    if (!input.ok) return input.response;
    const body = input.body;
    const found = serviceAccess(input.params.serviceId ?? "", actionOf("runDatabaseQuery"));
    if (!found.ok) return found.response;
    if (!environmentOf(found.project.id, body.environment_id)) return notFound("Environment");
    if (body.mode === "write") {
      if (!can(found.guard.membership.role, "data:write")) {
        return apiError(
          403,
          "forbidden",
          `Your role (${found.guard.membership.role}) cannot perform data:write`,
        );
      }
      const stale = staleSession();
      if (stale) return stale;
    }
    const refused = queryTarget(found.service, body.environment_id);
    if (refused) return refused;
    const result = runOp(found.service.id, body.op, body.mode, body.max_rows ?? 100);
    if (body.op.type === "raw") {
      const statement = body.op.statement ?? body.op.argv?.join(" ") ?? "";
      audit(
        found.project.workspace_id,
        found.guard.user.id,
        "database.query_executed",
        "service",
        found.service.id,
        {
          environment_id: body.environment_id,
          mode: body.mode,
          statement: statement.slice(0, 2048),
        },
      );
    }
    return HttpResponse.json(queryResult(result, started));
  }),

  http.get(mswPath("getDatabaseSchema"), async ({ request, params }) => {
    const started = performance.now();
    const input = await validate("getDatabaseSchema", request, params);
    if (!input.ok) return input.response;
    const found = serviceAccess(input.params.serviceId ?? "", actionOf("getDatabaseSchema"));
    if (!found.ok) return found.response;
    const environmentId = input.query.environment_id!;
    if (!environmentOf(found.project.id, environmentId)) return notFound("Environment");
    const refused = queryTarget(found.service, environmentId);
    if (refused) return refused;
    audit(
      found.project.workspace_id,
      found.guard.user.id,
      "database.browser_opened",
      "service",
      found.service.id,
      { environment_id: environmentId },
    );
    return HttpResponse.json({
      engine: found.service.database!.engine,
      version: found.service.database!.version,
      namespaces: queryResult(
        runOp(found.service.id, { type: "list_namespaces" }, "read", 100),
        started,
      ),
    });
  }),

  // ---------------------------------------------------------------------------
  // Backup policies and backups
  // ---------------------------------------------------------------------------
  http.get(mswPath("getBackupPolicy"), async ({ request, params }) => {
    const input = await validate("getBackupPolicy", request, params);
    if (!input.ok) return input.response;
    const found = serviceAccess(input.params.serviceId ?? "", actionOf("getBackupPolicy"));
    if (!found.ok) return found.response;
    const env = environmentOf(found.project.id, input.query.environment_id);
    if (!env) return notFound("Environment");
    return HttpResponse.json(toPolicy(found.service, env.id));
  }),

  http.put(mswPath("putBackupPolicy"), async ({ request, params }) => {
    const input = await validate<PolicyInput>("putBackupPolicy", request, params);
    if (!input.ok) return input.response;
    const body = input.body;
    const found = serviceAccess(input.params.serviceId ?? "", actionOf("putBackupPolicy"));
    if (!found.ok) return found.response;
    const env = environmentOf(found.project.id, body.environment_id);
    if (!env) return notFound("Environment");
    const service = found.service;
    if (!volumeOf(service.id, env.id)) {
      return conflict(`${service.name} has no volume in ${env.name} to back up`);
    }
    if (service.database && body.quiesce === "stop") {
      return apiError(422, "invalid_request", "quiesce: stop applies to snapshots only");
    }
    if (!service.database && body.databases) {
      return apiError(422, "invalid_request", "databases applies to database services only");
    }
    const current = db.data.policies.find(
      (row) => row.service_id === service.id && row.environment_id === env.id,
    );
    const enabled = body.enabled ?? current?.enabled ?? true;
    if (enabled && !db.data.storage) return storageNotConfigured();
    const next = {
      id: current?.id ?? nextId("bpl"),
      service_id: service.id,
      environment_id: env.id,
      enabled,
      method: service.database ? ("dump" as const) : ("snapshot" as const),
      schedule: body.schedule ?? current?.schedule ?? DEFAULT_BACKUP_SCHEDULE,
      timezone: "UTC",
      keep_last: body.keep_last ?? current?.keep_last ?? DEFAULT_BACKUP_KEEP_LAST,
      max_age_days:
        body.max_age_days !== undefined ? body.max_age_days : (current?.max_age_days ?? null),
      quiesce: body.quiesce ?? current?.quiesce ?? "none",
      databases: body.databases !== undefined ? body.databases : (current?.databases ?? null),
    };
    if (current) Object.assign(current, next);
    else db.data.policies.push(next);
    audit(
      found.project.workspace_id,
      found.guard.user.id,
      "backup.policy_updated",
      "backup_policy",
      next.id,
      {
        service_id: service.id,
        environment_id: env.id,
        changed: Object.keys(body).filter((key) => key !== "environment_id"),
      },
    );
    return HttpResponse.json(toPolicy(service, env.id));
  }),

  http.get(mswPath("listBackups"), async ({ request, params }) => {
    const input = await validate("listBackups", request, params);
    if (!input.ok) return input.response;
    const found = serviceAccess(input.params.serviceId ?? "", actionOf("listBackups"));
    if (!found.ok) return found.response;
    const env = environmentOf(found.project.id, input.query.environment_id);
    if (!env) return notFound("Environment");
    const limit = Number(input.query.limit ?? 50);
    const cursor = input.query.cursor;
    const rows = db.data.backups
      .filter(
        (row) =>
          row.service_id === found.service.id &&
          row.environment_id === env.id &&
          row.status !== "deleted",
      )
      .map(advanceBackup)
      .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
    const start = cursor ? rows.findIndex((row) => row.id === cursor) + 1 : 0;
    const page = rows.slice(start, start + limit);
    return HttpResponse.json({
      backups: page,
      next_cursor: rows.length > start + limit ? page.at(-1)!.id : null,
    });
  }),

  http.post(mswPath("createBackup"), async ({ request, params }) => {
    const input = await validate<{ environment_id: string }>("createBackup", request, params);
    if (!input.ok) return input.response;
    const found = serviceAccess(input.params.serviceId ?? "", actionOf("createBackup"));
    if (!found.ok) return found.response;
    const env = environmentOf(found.project.id, input.body.environment_id);
    if (!env) return notFound("Environment");
    if (!db.data.storage) return storageNotConfigured();
    if (!volumeOf(found.service.id, env.id)) {
      return conflict(`${found.service.name} has no volume in ${env.name} to back up`);
    }
    const backup = newBackup(found.service, env.id, {
      trigger: "manual",
      pinned: true,
      requested_by: found.guard.user.id,
    });
    audit(
      found.project.workspace_id,
      found.guard.user.id,
      "backup.requested",
      "backup",
      backup.id,
      {
        project_id: found.project.id,
        service_id: found.service.id,
        environment_id: env.id,
      },
    );
    return HttpResponse.json(backup, { status: 202 });
  }),

  http.get(mswPath("getBackup"), async ({ request, params }) => {
    const input = await validate("getBackup", request, params);
    if (!input.ok) return input.response;
    const found = backupAccess(input.params.backupId ?? "", actionOf("getBackup"));
    if (!found.ok) return found.response;
    return HttpResponse.json(advanceBackup(found.backup));
  }),

  http.delete(mswPath("removeBackup"), async ({ request, params }) => {
    const input = await validate("removeBackup", request, params);
    if (!input.ok) return input.response;
    const found = backupAccess(input.params.backupId ?? "", actionOf("removeBackup"));
    if (!found.ok) return found.response;
    const backup = found.backup;
    if (backup.status === "deleted") return new HttpResponse(null, { status: 204 });
    if (backup.status === "queued" || backup.status === "running") {
      return conflict("The backup is still running");
    }
    const reading = db.data.restores.find(
      (row) => row.backup_id === backup.id && (row.status === "queued" || row.status === "running"),
    );
    if (reading) return conflict(`Restore ${reading.id} is reading this backup`);
    if (!db.data.storage) return storageNotConfigured();
    backup.status = "deleted";
    audit(found.project.workspace_id, found.guard.user.id, "backup.deleted", "backup", backup.id, {
      project_id: found.project.id,
      service_id: backup.service_id,
      environment_id: backup.environment_id,
      trigger: backup.trigger,
    });
    return new HttpResponse(null, { status: 204 });
  }),

  http.get(mswPath("downloadBackup"), async ({ request, params }) => {
    const input = await validate("downloadBackup", request, params);
    if (!input.ok) return input.response;
    const found = backupAccess(input.params.backupId ?? "", actionOf("downloadBackup"));
    if (!found.ok) return found.response;
    const backup = found.backup;
    if (backup.status !== "succeeded") {
      return conflict("Only a succeeded backup can be downloaded");
    }
    if (!db.data.storage) return storageNotConfigured();
    audit(
      found.project.workspace_id,
      found.guard.user.id,
      "backup.downloaded",
      "backup",
      backup.id,
      {
        project_id: found.project.id,
        service_id: backup.service_id,
        environment_id: backup.environment_id,
      },
    );
    return HttpResponse.json({
      url: `${db.data.storage.endpoint}/${db.data.storage.bucket}/${backup.id}?X-Amz-Signature=mock`,
      expires_at: Date.now() + 15 * 60_000,
      filename: `${backup.id}.rhbk.zst.age`,
      sha256: backup.sha256,
    });
  }),

  http.post(mswPath("getBackupDecryptionKey"), async ({ request, params }) => {
    const input = await validate("getBackupDecryptionKey", request, params);
    if (!input.ok) return input.response;
    const found = backupAccess(input.params.backupId ?? "", actionOf("getBackupDecryptionKey"));
    if (!found.ok) return found.response;
    const stale = staleSession();
    if (stale) return stale;
    const key = db.data.keys[found.project.id];
    if (!key) return conflict("This project has no backup key yet");
    audit(
      found.project.workspace_id,
      found.guard.user.id,
      "backup.key_revealed",
      "backup",
      found.backup.id,
      {
        project_id: found.project.id,
        service_id: found.backup.service_id,
      },
    );
    return HttpResponse.json(key);
  }),

  http.post(mswPath("restoreBackup"), async ({ request, params }) => {
    const input = await validate<RestoreInput>("restoreBackup", request, params);
    if (!input.ok) return input.response;
    const body = input.body;
    const found = backupAccess(input.params.backupId ?? "", actionOf("restoreBackup"));
    if (!found.ok) return found.response;
    const stale = staleSession();
    if (stale) return stale;
    const { backup, service, project } = found;
    if (body.confirm !== service.slug) {
      return invalid("confirm must equal the service's slug");
    }
    if (body.target_node_id !== undefined && body.mode !== "in_place") {
      return invalid("target_node_id applies to in_place restores only");
    }
    if (body.mode === "new_service") {
      const target = environmentOf(project.id, body.target_environment_id ?? backup.environment_id);
      if (!target) return notFound("Environment");
      for (const action of ["services:manage", "variables:manage", "deployments:create"] as const) {
        if (!can(found.guard.membership.role, action)) {
          return apiError(
            403,
            "forbidden",
            `Restoring into a new service creates and deploys a database: it needs ${action}`,
          );
        }
      }
      const engine = (backup.engine as ServiceDatabaseEngine | null) ?? service.database?.engine;
      if (!engine || backup.method !== "dump") {
        return apiError(
          422,
          "restore_mode_unsupported",
          engine
            ? "A snapshot of a database carries its passwords; restore it in place, or restore a dump into a new service"
            : "Only a database backup can be restored into a new service; restore this snapshot in place",
        );
      }
      if (backup.status !== "succeeded") return conflict("Only a succeeded backup can be restored");
      if (!db.data.storage) return storageNotConfigured();
      const now = Date.now();
      const added = addDatabase({
        project,
        environment: target,
        engine,
        version: databaseVersion(engine, backup.engine_version ?? service.database?.version)!
          .version,
        sizeMb: volumeOf(backup.service_id, backup.environment_id)?.size_mb,
        name: `${service.name} restore ${new Date(now).toISOString().slice(0, 10)}`.slice(0, 100),
        slug: body.slug ?? defaultRestoreSlug(service.slug, now),
        userId: found.guard.user.id,
        deploy: true,
        auditMetadata: { backup_id: backup.id },
      });
      const restore: Restore = {
        id: nextId("rst"),
        backup_id: backup.id,
        mode: "new_service",
        target_service_id: added.service.id,
        target_environment_id: target.id,
        safety_backup_id: null,
        target_node_id: null,
        status: "queued",
        error: null,
        requested_by: found.guard.user.id,
        started_at: null,
        finished_at: null,
        created_at: now,
      };
      db.data.restores.push(restore);
      audit(project.workspace_id, found.guard.user.id, "restore.started", "restore", restore.id, {
        project_id: project.id,
        backup_id: backup.id,
        mode: "new_service",
        source_service_id: backup.service_id,
        service_id: added.service.id,
        environment_id: target.id,
      });
      broadcastRealtime(project.id, { type: "service.updated", service: added.service });
      return HttpResponse.json(restore, { status: 202 });
    }
    if (body.target_environment_id && body.target_environment_id !== backup.environment_id) {
      return invalid("in_place restores into the backup's environment");
    }
    if (backup.status !== "succeeded") return conflict("Only a succeeded backup can be restored");
    if (!db.data.storage) return storageNotConfigured();
    const busy = db.data.restores.find(
      (row) =>
        row.target_service_id === backup.service_id &&
        row.target_environment_id === backup.environment_id &&
        (row.status === "queued" || row.status === "running"),
    );
    if (busy) return conflict(`Restore ${busy.id} is already running for this service`);
    if (body.target_node_id !== undefined) {
      return recoverVolume(found, body.target_node_id);
    }
    const safety = body.skip_safety_backup
      ? null
      : newBackup(service, backup.environment_id, {
          trigger: "pre_restore",
          pinned: false,
          requested_by: found.guard.user.id,
        });
    const restore: Restore = {
      id: nextId("rst"),
      backup_id: backup.id,
      mode: "in_place",
      target_service_id: backup.service_id,
      target_environment_id: backup.environment_id,
      safety_backup_id: safety?.id ?? null,
      target_node_id: null,
      status: "queued",
      error: null,
      requested_by: found.guard.user.id,
      started_at: null,
      finished_at: null,
      created_at: Date.now(),
    };
    db.data.restores.push(restore);
    audit(project.workspace_id, found.guard.user.id, "restore.started", "restore", restore.id, {
      project_id: project.id,
      backup_id: backup.id,
      mode: "in_place",
      service_id: backup.service_id,
      environment_id: backup.environment_id,
      safety_backup_id: restore.safety_backup_id,
    });
    return HttpResponse.json(restore, { status: 202 });
  }),

  http.get(mswPath("getRestore"), async ({ request, params }) => {
    const input = await validate("getRestore", request, params);
    if (!input.ok) return input.response;
    const restore = db.data.restores.find((row) => row.id === input.params.restoreId);
    if (!restore) {
      return currentUser() ? notFound("Restore") : unauthorized();
    }
    const found = backupAccess(restore.backup_id, actionOf("getRestore"));
    if (!found.ok) {
      return found.response.status === 404 ? notFound("Restore") : found.response;
    }
    return HttpResponse.json(advanceRestore(restore));
  }),

  // ---------------------------------------------------------------------------
  // Backup storage
  // ---------------------------------------------------------------------------
  http.get(mswPath("getBackupStorage"), () => {
    const denied = requireInstanceAdmin();
    if (denied) return denied;
    return HttpResponse.json(storageView());
  }),

  http.put(mswPath("putBackupStorage"), async ({ request, params }) => {
    const input = await validate<StorageInput>("putBackupStorage", request, params);
    if (!input.ok) return input.response;
    const denied = requireInstanceAdmin();
    if (denied) return denied;
    const stale = staleSession();
    if (stale) return stale;
    const body = input.body;
    let endpoint: URL | null = null;
    try {
      endpoint = new URL(body.endpoint);
    } catch {
      endpoint = null;
    }
    if (
      endpoint?.protocol !== "https:" ||
      (endpoint.pathname !== "/" && endpoint.pathname !== "") ||
      endpoint.search ||
      endpoint.username
    ) {
      return invalid("endpoint must be an https:// origin with no path, query or credentials");
    }
    const secret = body.secret_access_key ?? db.data.storage?.secret_access_key;
    if (!secret) return invalid("secret_access_key is required");
    if (body.bucket.includes("unreachable")) {
      return apiError(422, "backup_storage_unreachable", "The bucket could not be reached");
    }
    db.data.storage = {
      endpoint: endpoint.origin,
      bucket: body.bucket,
      region: body.region ?? "auto",
      access_key_id: body.access_key_id,
      secret_access_key: secret,
    };
    const user = currentUser();
    for (const membership of db.memberships.filter(
      (row) => row.user_id === user?.id && row.role === "owner",
    )) {
      audit(
        membership.workspace_id,
        user!.id,
        "instance.settings_updated",
        "instance",
        "instance",
        {
          setting: "backup_storage",
        },
      );
    }
    return HttpResponse.json(storageView());
  }),
];
