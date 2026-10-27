/**
 * Data-service tables of the mock database (ADR 0004): volumes and their moves between
 * nodes, backup policies, backups, restores, published TCP ports, credential rotations,
 * the instance's backup bucket, each project's backup key, and the rows the data browser
 * reads. Row shapes are the API's own types.
 *
 * The seed adds a PostgreSQL 18 service `postgres` to the storefront project: running in
 * production with a 5 GiB volume on hel-1, a nightly backup policy with four backups
 * (one failed), and two browsable tables in `public`.
 *
 * @module
 */
import {
  DEFAULT_BACKUP_KEEP_LAST,
  DEFAULT_BACKUP_SCHEDULE,
  databaseImage,
  renderDatabaseService,
  type ServiceDatabaseEngine,
} from "@roundhouse/shared";
import type { Backup, BackupPolicy, Restore } from "../lib/api/backups-client";
import type { CredentialRotation, TcpProxy, Volume, VolumeMigration } from "../lib/api/data-client";
import type { Service, ServiceConfig } from "../lib/api/deploy-types";
import type { DbVariable, DeployDb } from "./deploy-db";

/** A stored backup policy; next runs are computed when it is read. */
export type DbBackupPolicy = Omit<BackupPolicy, "next_run_at" | "next_runs">;

/** The instance's backup bucket, with the secret the API never returns. */
export interface DbBackupStorage {
  endpoint: string;
  bucket: string;
  region: string;
  access_key_id: string;
  secret_access_key: string;
}

/** One relation the data browser can page through. */
export interface DbMockTable {
  namespace: string;
  name: string;
  type: "table" | "view";
  columns: { name: string; type: string }[];
  rows: unknown[][];
}

/** Every data-service table. */
export interface DataDb {
  volumes: Volume[];
  policies: DbBackupPolicy[];
  backups: Backup[];
  restores: Restore[];
  migrations: VolumeMigration[];
  /** Published ports; `host`, `node_id`, `status` and `open_to_all` are derived when read. */
  tcpProxies: TcpProxy[];
  rotations: CredentialRotation[];
  storage: DbBackupStorage | null;
  /** Project age identities, created with the first backup. */
  keys: Record<string, { identity: string; recipient: string }>;
  /** Browsable relations by database service id. */
  tables: Record<string, DbMockTable[]>;
  /** Behaviour a test can switch on. */
  knobs: {
    /** Answer 403 `reauth_required` to routes that need a fresh session. */
    reauthRequired: boolean;
    /** Database services whose node is offline (503 to queries). */
    offline: Set<string>;
    /** Volume moves fail after the copy out, and roll back. */
    failMigrations: boolean;
    /** Nodes' agents can't enforce a TCP allowlist. */
    tcpProxyUnsupported: boolean;
    /** The next credential rotation times out after the engine accepts a password. */
    interruptRotation: boolean;
  };
}

function emptyKnobs(): DataDb["knobs"] {
  return {
    reauthRequired: false,
    offline: new Set(),
    failMigrations: false,
    tcpProxyUnsupported: false,
    interruptRotation: false,
  };
}

/** Ids of the seeded data-service rows, for tests. */
export const DATA_SEED = {
  database: "svc_postgres",
  databaseSlug: "postgres",
  volume: "vol_postgres_prod",
  deployment: "dep_postgres_1",
  policy: "bpl_postgres_prod",
  manualBackup: "bak_postgres_4",
  failedBackup: "bak_postgres_3",
  scheduledBackup: "bak_postgres_2",
  oldBackup: "bak_postgres_1",
} as const;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MiB = 1024 * 1024;

/**
 * Renders a database service from the shared registry with zero bytes for randomness:
 * the same keys, secrecy and config as the API, and deterministic credentials.
 *
 * @param engine - The engine.
 * @param version - Registry version; the default when omitted.
 * @param sizeMb - Volume size.
 * @returns The rendered service.
 */
export function renderMockDatabase(
  engine: ServiceDatabaseEngine,
  version?: string,
  sizeMb?: number,
) {
  return renderDatabaseService(engine, version, (n) => new Uint8Array(n), sizeMb);
}

/**
 * A volume row with defaults for a fresh, not yet placed volume.
 *
 * @param fields - Ids and overrides.
 * @returns The volume.
 */
export function makeVolume(
  fields: Pick<Volume, "id" | "project_id" | "environment_id" | "service_id" | "mount_path"> &
    Partial<Volume>,
): Volume {
  const now = Date.now();
  return {
    size_mb: 5120,
    node_id: null,
    node_name: null,
    status: "pending",
    quota_mode: null,
    used_bytes: null,
    message: null,
    reported_at: null,
    delete_after: null,
    created_at: now,
    updated_at: now,
    ...fields,
  };
}

/**
 * A backup row of the seeded database.
 *
 * @param id - Backup id.
 * @param fields - Overrides; `created_at` is required.
 * @returns The backup.
 */
function backup(id: string, fields: Partial<Backup> & Pick<Backup, "created_at">): Backup {
  return {
    id,
    project_id: "prj_store",
    service_id: DATA_SEED.database,
    environment_id: "env_store_prod",
    volume_id: DATA_SEED.volume,
    policy_id: DATA_SEED.policy,
    trigger: "schedule",
    method: "dump",
    engine: "postgres",
    engine_version: "18",
    status: "succeeded",
    node_id: "node_hel1",
    pinned: false,
    part_count: 1,
    bytes_raw: 412 * MiB,
    bytes_stored: 96 * MiB,
    sha256: "9f".repeat(32),
    error: null,
    requested_by: null,
    scheduled_for: fields.created_at,
    started_at: fields.created_at + 1_000,
    finished_at: fields.created_at + 48_000,
    ...fields,
  };
}

const FIRST_NAMES = ["Ada", "Grace", "Alan", "Edsger", "Barbara", "Donald", "Ken", "Margaret"];

/** Rows of the seeded `public.customers` table: enough for three pages. */
function customerRows(count: number, now: number): unknown[][] {
  return Array.from({ length: count }, (_, i) => {
    const name = `${FIRST_NAMES[i % FIRST_NAMES.length]} ${String.fromCharCode(65 + (i % 26))}.`;
    return [
      String(i + 1),
      `${name.split(" ")[0]!.toLowerCase()}${i + 1}@example.com`,
      name,
      i % 7 === 0 ? null : (i * 37) % 500,
      new Date(now - (count - i) * HOUR).toISOString(),
    ];
  });
}

/**
 * Adds the seeded database service to the Phase 1 tables and builds the data-service
 * tables around it.
 *
 * @param deploy - Seeded Phase 1 tables; the database's rows are pushed into them.
 * @param now - Reference time.
 * @returns The data-service tables.
 */
export function seedData(deploy: DeployDb, now = Date.now()): DataDb {
  const P = "env_store_prod";
  const project = "prj_store";
  const service: Service = {
    id: DATA_SEED.database,
    project_id: project,
    name: "postgres",
    slug: DATA_SEED.databaseSlug,
    kind: "database",
    icon: "builtin:postgres",
    health: "ok",
    health_reason: null,
    database: { engine: "postgres", version: "18" },
    created_at: now - 6 * DAY,
    updated_at: now - 6 * DAY,
  };
  const rendered = renderMockDatabase("postgres", "18");
  const config: ServiceConfig = {
    id: "cfg_svc_postgres_1",
    service_id: service.id,
    environment_id: P,
    version: 1,
    created_by: "usr_ada",
    created_at: service.created_at,
    ...rendered.config,
  } as ServiceConfig;
  deploy.services.push(service);
  deploy.configs.push(config);
  const variables: DbVariable[] = rendered.variables.map((v) => ({
    scope: "service",
    owner_id: service.id,
    environment_id: P,
    key: v.key,
    value: v.value,
    tier: v.secret ? "secret" : "plain",
    locked: false,
    available_at_build: false,
    mount_as_file: false,
    version: 1,
    updated_at: service.created_at,
    updated_by: "usr_ada",
  }));
  deploy.variables.push(...variables);
  const deployedAt = now - 6 * DAY + 5 * MINUTE;
  deploy.deployments.push({
    id: DATA_SEED.deployment,
    project_id: project,
    service_id: service.id,
    environment_id: P,
    config_version: 1,
    build_id: null,
    image: databaseImage(rendered.version),
    status: "active",
    trigger: "manual",
    triggered_by: "usr_ada",
    rollback_of: null,
    failure_reason: null,
    started_at: deployedAt + 2_000,
    finished_at: deployedAt + 24_000,
    created_at: deployedAt,
    updated_at: deployedAt + 24_000,
  });
  deploy.placements.push({
    id: "plc_postgres_0",
    deployment_id: DATA_SEED.deployment,
    replica: 0,
    node_id: "node_hel1",
    node_name: "hel-1",
    workload_id: `wl_${DATA_SEED.deployment}_0`,
    container_id: "c0pg9f2e1d",
    state: "healthy",
    last_status_at: now - 45_000,
  });

  const lastSlot = now - (now % DAY) + 3 * HOUR - (now % DAY < 3 * HOUR ? DAY : 0);
  return {
    volumes: [
      makeVolume({
        id: DATA_SEED.volume,
        project_id: project,
        environment_id: P,
        service_id: service.id,
        mount_path: rendered.version.mountPath,
        size_mb: 5120,
        node_id: "node_hel1",
        node_name: "hel-1",
        status: "ready",
        quota_mode: "xfs_project",
        used_bytes: 1_288 * MiB,
        reported_at: now - 30_000,
        created_at: service.created_at,
        updated_at: now - 30_000,
      }),
    ],
    policies: [
      {
        id: DATA_SEED.policy,
        service_id: service.id,
        environment_id: P,
        enabled: true,
        method: "dump",
        schedule: DEFAULT_BACKUP_SCHEDULE,
        timezone: "UTC",
        keep_last: DEFAULT_BACKUP_KEEP_LAST,
        max_age_days: 30,
        quiesce: "none",
        databases: null,
      },
    ],
    backups: [
      backup(DATA_SEED.manualBackup, {
        trigger: "manual",
        pinned: true,
        policy_id: null,
        requested_by: "usr_ada",
        scheduled_for: null,
        // NOTE: Stays newer than the last scheduled slot even just after 03:00 UTC.
        created_at: Math.max(now - 2 * HOUR, Math.round((now + lastSlot) / 2)),
        bytes_raw: 418 * MiB,
        bytes_stored: 98 * MiB,
      }),
      backup(DATA_SEED.failedBackup, {
        status: "failed",
        created_at: lastSlot,
        part_count: null,
        bytes_raw: null,
        bytes_stored: null,
        sha256: null,
        error: "pg_dump: connection to server lost",
        finished_at: lastSlot + 12_000,
      }),
      backup(DATA_SEED.scheduledBackup, { created_at: lastSlot - DAY }),
      backup(DATA_SEED.oldBackup, {
        created_at: lastSlot - 2 * DAY,
        bytes_raw: 401 * MiB,
        bytes_stored: 93 * MiB,
      }),
    ],
    restores: [],
    migrations: [],
    tcpProxies: [],
    rotations: [],
    storage: {
      endpoint: "https://acme.r2.cloudflarestorage.com",
      bucket: "roundhouse-backups",
      region: "auto",
      access_key_id: "AKIAMOCKBACKUPS",
      secret_access_key: "mock-secret-access-key",
    },
    keys: {
      [project]: {
        identity: `AGE-SECRET-KEY-1${"Q".repeat(58)}`,
        recipient: `age1${"q".repeat(58)}`,
      },
    },
    tables: {
      [service.id]: [
        {
          namespace: "public",
          name: "customers",
          type: "table",
          columns: [
            { name: "id", type: "bigint" },
            { name: "email", type: "text" },
            { name: "name", type: "text" },
            { name: "credit_cents", type: "integer" },
            { name: "created_at", type: "timestamp with time zone" },
          ],
          rows: customerRows(240, now),
        },
        {
          namespace: "public",
          name: "orders",
          type: "table",
          columns: [
            { name: "id", type: "bigint" },
            { name: "customer_id", type: "bigint" },
            { name: "total_cents", type: "integer" },
            { name: "meta", type: "jsonb" },
          ],
          rows: Array.from({ length: 12 }, (_, i) => [
            String(1000 + i),
            String((i % 5) + 1),
            1999 + i * 250,
            { gift: i % 3 === 0 },
          ]),
        },
        { namespace: "audit", name: "events", type: "view", columns: [], rows: [] },
      ],
    },
    knobs: emptyKnobs(),
  };
}

/**
 * Empty data-service tables, for a fresh install: no storage configured.
 *
 * @returns Tables with no rows.
 */
export function emptyData(): DataDb {
  return {
    volumes: [],
    policies: [],
    backups: [],
    restores: [],
    migrations: [],
    tcpProxies: [],
    rotations: [],
    storage: null,
    keys: {},
    tables: {},
    knobs: emptyKnobs(),
  };
}
