# 0004: Data services (databases, volumes, backups, data browser, TCP proxy)

## Status

Proposed.
- Date: 2026-10-22
- Phase: 2
- Protocol: version 4
- Depends on: 0003, 0005 (scheduler fields, mesh), 0006 (databases are
  added through change sets).

Names follow the Roundhouse rename (0013, "Naming").

## Context

Phase 1 runs stateless containers. `SERVICE_KINDS` already includes
`database`, but nothing behind it differs from an app:
- **No persistent storage.** Containers keep nothing across a replace.
- **Unsafe rollout.** The agent starts the new container before stopping
  the old one. Two Postgres processes on one data directory would corrupt
  it.
- **Wrong health probes.** Health is `http`, `tcp` or `none`, probed from
  the host. A TCP probe on 5432 passes before Postgres accepts queries.
- **No scheduled work.** The only scheduled job is the hourly retention
  cron.
- **Nothing to restore from.** There are no backups or restores, and no
  way to look at data.
- **No external access.** Ports are reachable only through Caddy routes
  (HTTP), so a database cannot be reached from outside.

Facts that constrain the design (sources at the end):
- **Docker volume quotas.** `--storage-opt size` limits only a container's
  writable layer, on overlay2 over XFS with `pquota`. The `local` volume
  driver has no size quota.
- **Project quotas.** XFS project quotas need a `prjquota` mount.
  `prjquota` on the root filesystem needs `rootflags=pquota` on the kernel
  command line. ext4 project quotas need the `project` and `quota` feature
  flags, which cannot be added to a mounted root filesystem.
- **Loop devices.** They are allocated dynamically through
  `/dev/loop-control` (Linux 3.1+).
- **Current images and tools.**
  - Postgres 18 (18.6). From 18, the image puts `PGDATA` at
    `/var/lib/postgresql/18/docker`, with the volume at
    `/var/lib/postgresql`.
  - MySQL LTS is 9.7. mysqldump is not deprecated; only `--triggers` is on
    by default.
  - Redis 8.10 is tri-licensed RSALv2/SSPLv1/AGPLv3. Valkey 9.1 is BSD.
  - MongoDB 9.0.
  - None of these official images declares a `HEALTHCHECK`.
- **Streaming dumps.** `pg_dump -Fc` streams to stdout, and `pg_restore`
  reads stdin, but not with `-j`. `redis-cli --rdb -` writes to stdout.
  `mongodump --archive` and `mongorestore --archive` stream.
- **R2 multipart.**
  - 5 MiB minimum part size. Every part except the last must be the same
    size. At most 10,000 parts.
  - Presigned URLs (GET, HEAD, PUT, DELETE) live 1 s to 7 days and work
    only on the S3 API domain.
  - Incomplete uploads auto-abort after 7 days by default.
  - The Workers binding supports multipart but cannot presign.
- **Docker exec.** Exec streams stdout and stderr over a hijacked
  connection, and an exec keeps running when its client disconnects (it
  has to be killed by PID). A bind-mount source must exist unless
  `CreateMountpoint` is set.

## Decision

### Database templates

`packages/shared/src/databases.ts` defines a static registry. The images
are pinned by **multi-arch index digest** in
`packages/shared/src/database-images.json`. `scripts/pin-database-images.mjs`
resolves the digests through the registry API. A weekly CI job re-resolves
them and fails if a pinned digest no longer exists, so drift is a reviewed
PR, never silent.

| `engine`   | Versions offered (default first) | Image                   | Port  | Mount                 | Health (`exec`)                                                 | Backup         |
| ---------- | -------------------------------- | ----------------------- | ----- | --------------------- | --------------------------------------------------------------- | -------------- |
| `postgres` | 18, 17, 16                       | `postgres:<v>-bookworm` | 5432  | `/var/lib/postgresql` | `pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"` | dump           |
| `mysql`    | 9.7, 8.4                         | `mysql:<v>`             | 3306  | `/var/lib/mysql`      | `mysqladmin ping -h 127.0.0.1 --silent`                         | dump           |
| `redis`    | 8.10                             | `redis:<v>`             | 6379  | `/data`               | `redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping`         | dump (RDB)     |
| `mongodb`  | 9.0, 8.0                         | `mongo:<v>`             | 27017 | `/data/db`            | `mongosh --quiet --eval 'db.adminCommand("ping").ok'`           | dump (archive) |

A template is a `service.create` op (0006) with `database: { engine,
version }`. `renderDatabaseService(engine, version)` expands it into the
following.

**Service and config.**
- `kind: "database"`, an `image` source with the pinned digest reference,
  `replicas: 1`, and `strategy: "recreate"`.
- Resources default to 1000 m CPU and 1024 MiB memory (512 MiB for Redis).
- `networking.port` is the engine port, with `generated_domain: false`.
- The health check is an `exec` probe with `interval_s: 5`,
  `timeout_s: 5`, `retries: 6` and `start_period_s: 30`.

**Volume.** One volume at the engine's mount path, default `size_mb:
5120`.

**Generated credentials**, set with `variable.set` as `is_secret: true`.
Values are 32 random bytes, base64url (43 characters), minted in the
Worker with `crypto.getRandomValues`.

| Engine   | Secret variables                                                                                                | Derived (reference-valued, secret)                                                                                                                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| postgres | `POSTGRES_PASSWORD`, `ROUNDHOUSE_RO_PASSWORD`; plain `POSTGRES_USER=postgres`, `POSTGRES_DB=app`                | `DATABASE_URL=postgresql://${{POSTGRES_USER}}:${{POSTGRES_PASSWORD}}@${{ROUNDHOUSE_PRIVATE_DOMAIN}}:5432/${{POSTGRES_DB}}`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` |
| mysql    | `MYSQL_ROOT_PASSWORD`, `MYSQL_PASSWORD`, `ROUNDHOUSE_RO_PASSWORD`; plain `MYSQL_USER=app`, `MYSQL_DATABASE=app` | `DATABASE_URL=mysql://…`, `MYSQL_URL`                                                                                                                                                |
| redis    | `REDIS_PASSWORD`, `ROUNDHOUSE_RO_PASSWORD`                                                                      | `REDIS_URL=redis://default:${{REDIS_PASSWORD}}@${{ROUNDHOUSE_PRIVATE_DOMAIN}}:6379`                                                                                                  |
| mongodb  | `MONGO_INITDB_ROOT_PASSWORD`, `ROUNDHOUSE_RO_PASSWORD`; plain `MONGO_INITDB_ROOT_USERNAME=root`                 | `MONGO_URL=mongodb://root:${{MONGO_INITDB_ROOT_PASSWORD}}@${{ROUNDHOUSE_PRIVATE_DOMAIN}}:27017/?authSource=admin`, `DATABASE_URL` (same)                                             |

Notes:
- **Redis** has no password environment variable in its image. The
  template sets the command to `["sh", "-c", "exec redis-server --requirepass \"$REDIS_PASSWORD\" --user \"roundhouse_ro on >$ROUNDHOUSE_RO_PASSWORD ~* &* +@read -@dangerous\" --appendonly yes"]`.
  The password is then visible to processes inside the container only.
- **The images apply credential variables only on first initialisation.**
  The dashboard locks them, and changing them goes through
  `POST /v1/services/{id}/database/rotate-credentials`. That route runs
  `ALTER ROLE` / `ALTER USER` / `db.changeUserPassword` / `ACL SETUSER`
  through the query channel with the current admin credential. It then
  writes the new values as variables in a change set, and applies it with
  `deploy: "affected"`, which redeploys every service that references
  them.
- **Read-only principal** (`roundhouse_ro`). It is created the first time
  the service is healthy, through the query channel
  (`op: provision_readonly`, below), and is idempotent:
  - postgres: `CREATE ROLE … LOGIN` and `GRANT pg_read_all_data`;
  - mysql: `CREATE USER IF NOT EXISTS` and `GRANT SELECT, SHOW VIEW ON *.*`;
  - mongodb: `createUser` with `readAnyDatabase`;
  - redis: the ACL user from the command line.

Columns added to `services`:

```sql
ALTER TABLE services ADD COLUMN database_engine TEXT;   -- postgres | mysql | redis | mongodb
ALTER TABLE services ADD COLUMN database_version TEXT;  -- "18"
```

### Protocol additions (version 4)

`WorkloadSpec` gains the fields below. "Hash" means the field is part of
`computeSpecHash`. Fields excluded from it go into
`SPEC_HASH_EXCLUDED_FIELDS`, mirrored in Go.

```ts
mounts?: { volume_id: IdString; path: string /* absolute, no '..' */; read_only: boolean }[];  // hash; ≤ 1 in Phase 2
rollout?: "start_first" | "stop_first";   // not hashed; default start_first
stop_grace_s?: number;                    // not hashed; 0..600, default 10 (databases: 60)
ports[i].publish?: { host_port: number /* 1024..65535 */; host_ip: "0.0.0.0" | "::" };  // hash
healthcheck: { type: "exec"; command: string[]; interval_s; timeout_s; retries; start_period_s }  // new variant, port omitted
```

`desired_state` gains `volumes`, the complete list of volumes this node
holds, including those of services scaled to zero:

```ts
volumes?: { id: IdString; size_mb: number; project_id: IdString; environment_id: IdString;
            service_id: IdString; owner: string | null /* "uid:gid" */ }[];   // ≤ 128
```

**Agent invariants.** These hold even if the control plane is wrong.
1. A volume missing from `volumes` is never deleted. It is reported as
   `orphaned`. Only a `volume_delete` frame deletes data.
2. At most one container mounts a volume at a time. A workload with
   `stop_first`, or any workload whose mount is held by another container,
   waits until the holder has exited: SIGTERM, `stop_grace_s`, then
   SIGKILL. Only then is it created.
3. A workload whose volume is not `ready` stays `pending` with a message.

New control → agent frames, all signed:

```ts
{ type: "volume_delete"; volume_id; }                                  // after the 72 h grace
{ type: "backup_job"; backup_id; method: "dump" | "snapshot"; engine?: Engine; workload_id?: IdString;
  volume_id: IdString; quiesce: "none" | "stop"; databases: string[] | null;
  age_recipient: string; part_size_bytes: number; parts: { part_number: number; url: string }[];  // first ≤ 16; credential
  timeout_s: number /* ≤ 43200 */ }
{ type: "backup_parts"; backup_id; parts: { part_number; url }[] }    // ≤ 32; credential
{ type: "restore_job"; restore_id; backup_id; method; engine?; workload_id?; volume_id;
  download_url: string; age_identity: string; sha256: string; size_bytes: number; timeout_s }   // credential
{ type: "volume_copy_out" | "volume_copy_in"; … }   // see "Volume migration"; same shapes as backup/restore with method "snapshot"
{ type: "db_query"; request_id: string; workload_id; engine; credential: { username; password };   // credential
  mode: "read" | "write"; op: DbOp; max_rows: number /* ≤ 1000 */; max_bytes: number /* ≤ 458752 */;
  timeout_ms: number /* ≤ 30000 */ }
```

New agent → control frames:

```ts
{ type: "volume_status"; volumes: { volume_id; state: "creating" | "ready" | "resizing" | "orphaned" | "error" | "deleted";
  size_bytes: number; used_bytes: number; quota: "xfs_project" | "ext4_project" | "loop" | "none"; message?: string }[] }  // every 60 s and on change
{ type: "backup_parts_request"; backup_id; from_part: number; count: number /* ≤ 32 */ }
{ type: "backup_progress"; backup_id; parts: { part_number; etag; size }[] /* ≤ 256 */; bytes_raw: number }
{ type: "backup_result"; backup_id; ok: boolean; part_count?: number; bytes_raw?: number; bytes_stored?: number;
  sha256?: string; error?: string; duration_ms: number }
{ type: "restore_result"; restore_id; ok: boolean; error?: string; bytes?: number; duration_ms: number }
{ type: "db_query_result"; request_id; ok: boolean; columns?: { name: string; type: string }[];
  rows?: unknown[][]; row_count?: number; truncated?: boolean; notice?: string; error?: string; duration_ms: number }
```

`LogSource` gains `{ type: "task"; task_id: IdString }` for backup,
restore and migration output. It is stored in R2 and indexed in
`log_chunks`, which gains a `task_id` column.

`carriesCredentials` covers `backup_job`, `backup_parts`, `restore_job`,
`volume_copy_*` and `db_query`, so each expires within 60 s.

### Volumes

**On the node.** The volumes root is `/var/lib/roundhouse/volumes`
(agent config `volumes.root`).
- Each volume is a filesystem, or a project-quota tree, mounted at
  `<root>/mnt/<volume_id>`.
- The container gets the bind mount `<root>/mnt/<volume_id>/data` →
  `mounts[].path`. `HostConfig.Mounts`, `Type: bind`, source created by the
  agent. The `data` subdirectory keeps `lost+found` out of the container,
  because `initdb` and `mysqld --initialize` refuse a non-empty directory.
- A fresh `data` directory is chowned to `owner` when the volume sets one,
  else to the image's numeric `User` if it has one, else left as root. The
  official database images start as root and chown it themselves.

**Quota enforcement** (agent config `volumes.quota: auto | xfs | ext4 | loop | none`):

| Mode           | When `auto` picks it                                          | Mechanism                                                                                                                                                             |
| -------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xfs_project`  | the volumes root is on XFS mounted with `prjquota`            | `quotactl(Q_XSETQLIM)` with project ID = a per-volume counter persisted in `<data-dir>/volumes.json`; resize is a new limit                                           |
| `ext4_project` | the root is on ext4 with the `project` feature and `prjquota` | `FS_IOC_FSSETXATTR` (`chattr -p ID +P`) and `quotactl(Q_SETQUOTA, PRJQUOTA)`                                                                                          |
| `loop`         | otherwise, when `/dev/loop-control` exists                    | sparse image `<root>/images/<volume_id>.img`, `mkfs.ext4 -m 0`, mounted `loop,noatime,nodev,nosuid`; grow online with `truncate`, `LOOP_SET_CAPACITY` and `resize2fs` |
| `none`         | none of the above (e.g. Docker Desktop)                       | no enforcement; usage is still reported, and the dashboard shows "quota not enforced"                                                                                 |

**Choice.** `loop` is the effective default on common cloud images: ext4
root, no project feature. It is the only mode that enforces a hard limit
on any host filesystem without remounting `/`. The project-quota modes
are preferred when present, because they have no loop or fsck overhead.
- Shrinking is refused (`422 volume_shrink_unsupported`).
- Growing applies online in every mode.
- The agent mounts every `loop` volume at start, before reconciling any
  workload. Workloads have restart policy `no`, so nothing starts first.

**Placement affinity.**
- `volumes.node_id` is null until the first deployment. The scheduler then
  places the replica with `diskMb = size_mb`, and the same `db.batch()` that
  writes the placement sets `node_id`.
- Every later deployment passes `pinnedNodeId = volumes.node_id`. An
  offline pinned node fails the deployment with `pinned_elsewhere` and the
  message "volume lives on node X (offline)". Nothing moves automatically.
- A volume service is limited to `replicas <= 1`
  (`422 volume_requires_single_replica`), and `strategy` is forced to
  `recreate`, which maps to `rollout: "stop_first"`. Deploys therefore
  have downtime for the restart. The dashboard says so.

```sql
CREATE TABLE volumes (
  id              TEXT PRIMARY KEY,                     -- vol_…
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment_id  TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  service_id      TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  mount_path      TEXT NOT NULL,
  size_mb         INTEGER NOT NULL,                     -- 256 .. 1048576
  node_id         TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  status          TEXT NOT NULL,       -- pending | ready | migrating | degraded | pending_deletion | deleted | abandoned | error
  quota_mode      TEXT,
  used_bytes      INTEGER, reported_at INTEGER,
  delete_after    INTEGER,             -- set when deleted; data removed after 72 h
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX volumes_service_env_live_uq ON volumes(service_id, environment_id)
  WHERE status NOT IN ('deleted', 'abandoned');
```

A deleted volume enters `pending_deletion` for `VOLUME_DELETE_GRACE_MS =
72 h`. It can be undone during that time
(`POST /v1/volumes/{id}/undelete`). After it, the minute tick sends
`volume_delete` and marks the volume `deleted` on `volume_status` state
`deleted`.

### Scheduled dispatch (shared by 0004, 0007, 0008, 0010)

`wrangler.jsonc` gains the cron `* * * * *`, next to the hourly
`17 * * * *`, and a queue:

```jsonc
"queues": { "producers": [{ "binding": "JOBS", "queue": "roundhouse-jobs" }],
            "consumers": [{ "queue": "roundhouse-jobs", "max_batch_size": 10, "max_retries": 5,
                            "dead_letter_queue": "roundhouse-jobs-dlq" }] }
```

`scheduled()` checks `controller.cron`.

**The minute tick** (`lib/dispatch.ts`) is a set of registered _claimers_:
- backup policies due;
- cron services due (0010);
- alert evaluation (0008);
- expired previews (0007);
- orphaned `queued` deployments (0006);
- volume deletions past grace;
- mesh path checks (0005).

Each claimer selects up to 100 rows with `next_run_at <= now`. It claims
each row with
`UPDATE … SET next_run_at = :next WHERE id = :id AND next_run_at = :seen`
and enqueues `{ kind, id, scheduled_for }` with `JOBS.sendBatch`.

**The consumer** starts the matching Workflow. The instance ID is
`<kind>-<id>-<scheduled_for>` (hyphens only, to stay within
Workflow instance ID characters), so a duplicate message is a no-op.

**Missed ticks.** Cron delivery guarantees are not documented, so a missed
tick only delays work: the next tick still sees `next_run_at <= now`.
Each kind defines its own catch-up rule; backups run once, however many
slots were missed.

### Backups

```sql
CREATE TABLE backup_policies (
  id TEXT PRIMARY KEY,                                  -- bpl_…
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  method TEXT NOT NULL,                 -- dump | snapshot
  schedule TEXT NOT NULL,               -- 5-field cron (0010 grammar), default "0 3 * * *"
  timezone TEXT NOT NULL DEFAULT 'UTC',
  keep_last INTEGER NOT NULL DEFAULT 7, -- 1..365
  max_age_days INTEGER,                 -- null | 1..3650
  quiesce TEXT NOT NULL DEFAULT 'none', -- snapshot only: none | stop
  databases TEXT,                       -- JSON string[] | null (all)
  next_run_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX backup_policies_svc_env_uq ON backup_policies(service_id, environment_id);

CREATE TABLE backups (
  id TEXT PRIMARY KEY,                                  -- bak_…
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  volume_id TEXT REFERENCES volumes(id) ON DELETE SET NULL,
  policy_id TEXT REFERENCES backup_policies(id) ON DELETE SET NULL,
  trigger TEXT NOT NULL,                -- schedule | manual | pre_restore | migration
  scheduled_for INTEGER,                -- unique with policy_id
  method TEXT NOT NULL, engine TEXT, engine_version TEXT,
  status TEXT NOT NULL,                 -- queued | running | succeeded | failed | deleted
  node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  object_key TEXT NOT NULL,             -- backups/<project>/<service>/<env>/<bak_id>.rhbk.zst.age
  upload_id TEXT, part_size_bytes INTEGER,
  bytes_raw INTEGER, bytes_stored INTEGER, sha256 TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,    -- manual backups: exempt from keep_last
  error TEXT, started_at INTEGER, finished_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX backups_policy_slot_uq ON backups(policy_id, scheduled_for) WHERE policy_id IS NOT NULL;
CREATE INDEX backups_svc_env_id_idx ON backups(service_id, environment_id, id);
CREATE TABLE backup_parts (
  backup_id TEXT NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL, etag TEXT NOT NULL, size INTEGER NOT NULL,
  PRIMARY KEY (backup_id, part_number)
);
ALTER TABLE project_keys ADD COLUMN backup_recipient TEXT;          -- age X25519 recipient
ALTER TABLE project_keys ADD COLUMN backup_identity_sealed TEXT;    -- under the project DEK, AAD "backup-identity:<project>"
```

**Storage.** Backups use the S3 API exclusively, through `aws4fetch` in
the Worker. One code path then runs against R2 in production and against
a fake S3 in tests. The Workers R2 binding would bypass the fake and
cannot presign. The instance setting `backup_storage = { endpoint,
bucket, region, access_key_id, secret_access_key (sealed) }` is set by
the setup wizard. The suggested values are a bucket named
`roundhouse-backups` and an R2 token scoped to that bucket with Object
Read & Write. Without the setting, backup routes return
`409 backup_storage_not_configured`.

**Pipeline on the agent** (`internal/backup`): source, then the RHBK1
container, then zstd, then age, then fixed-size parts, then presigned
`PUT`s, with 2 parts in flight.
- **Source** for `dump`: the engine's tool, run with `docker exec` inside
  the database container. The tool then always matches the server version,
  and credentials come from the container's own environment. The commands
  are built into the agent, never sent:

| Engine   | Command (stdout)                                                                                                   | Notes                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| postgres | `pg_dumpall -U "$POSTGRES_USER" --globals-only`, then per database `pg_dump -U "$POSTGRES_USER" -Fc -d <db>`       | databases from `psql -Atc "SELECT datname FROM pg_database WHERE NOT datistemplate"` unless `databases` is set |
| mysql    | `mysqldump --defaults-extra-file=/dev/stdin --single-transaction --routines --events --triggers --databases <dbs>` | password written to the exec's stdin as `[client]\npassword=…`; system schemas excluded                        |
| redis    | `redis-cli -a "$REDIS_PASSWORD" --no-auth-warning --rdb -`                                                         | exit code checked (SYNC transfer)                                                                              |
| mongodb  | `mongodump --archive --config=/dev/stdin`                                                                          | YAML with the password on stdin                                                                                |
- **Source** for `snapshot`: a Go `archive/tar` walk of `<root>/mnt/<vol>/data`,
  preserving owners, modes and xattrs. With `quiesce: "stop"`, the agent
  first stops the workload, as the `stop_first` rules require, and starts
  it again after the walk.
- **RHBK1** is a minimal streaming container that holds several dumps in
  one object without knowing their sizes ahead. It is the magic `RHBK1\n`,
  then entries of
  `{"name":"<db>.dump","engine":"postgres","format":"pg_custom"}\n` followed
  by chunks `u32 BE length | bytes` (≤ 1 MiB each), ended by a zero
  length, and finally a trailer entry `{"name":"_end"}`. It is specified in
  `packages/protocol/rhbk.md` with test vectors that Go and TS both verify.
  A snapshot is a single entry with format `tar`.
- **zstd** is `klauspost/compress/zstd` at `SpeedDefault`, with encoder
  concurrency 2.
- **Encryption.** `filippo.io/age` encrypts to the project's X25519
  recipient, so a leaked bucket token does not leak data. The identity is
  sealed in D1 and sent only in `restore_job`.
- **Parts.** The control plane picks
  `part_size_bytes = max(16 MiB, ceil(estimated_bytes × 1.5 / 9000))`, a
  multiple of 1 MiB, from the volume's `used_bytes`. Every part except the
  last has exactly that size, as R2 requires. A stream that would exceed
  10,000 parts fails cleanly with `backup_too_large`.
- **SHA-256** is computed over the stored (encrypted) bytes.

**Workflow** `BACKUP_WORKFLOW`, instance ID = `bak_…`:
1. Insert or claim the `backups` row.
2. `CreateMultipartUpload` and record the `upload_id`.
3. Presign the first 16 `UploadPart` URLs, each valid for 1 h, and send
   `backup_job` to the volume's node. An offline node fails the backup
   with `node_offline`.
4. The node DO answers `backup_parts_request` with fresh URLs and stores
   `backup_progress` ETags in `backup_parts`.
5. Wait for the `backup` event (`waitForEvent`, up to `timeout_s` +
   5 min).
6. `CompleteMultipartUpload` with every part, then `HeadObject` to check
   the size.
7. Mark the backup `succeeded` and apply retention. On any failure,
   `AbortMultipartUpload`.

**Retention** runs after every successful backup and hourly. It deletes
scheduled backups beyond `keep_last` (newest kept) and any backup older
than `max_age_days`. Pinned backups are exempt from `keep_last`. The S3
object is deleted first, then the row is marked `deleted`. The setup
wizard also adds an R2 lifecycle rule to abort incomplete multipart
uploads after 1 day.

### Restore

`POST /v1/backups/{id}/restore` takes
`{ mode: "in_place" | "new_service", target_environment_id?, target_node_id?, confirm }`.
`confirm` must equal the service slug.
- **`in_place`**: needs `backups:restore`.
  1. Take a safety backup (`trigger: pre_restore`), skipped only with
     `skip_safety_backup: true`.
  2. Send `restore_job`. For `dump`, the agent streams GET → age → zstd →
     RHBK1, verifies the SHA-256, and per entry runs
     `pg_restore --clean --if-exists --single-transaction -d <db>`
     (creating the database first if missing), `mysql
     --defaults-extra-file=/dev/stdin`, or `mongorestore --archive
     --drop`. For Redis, it stops the container, writes `dump.rdb`,
     removes `appendonlydir`, starts once with `--appendonly no` to load
     the RDB, runs `CONFIG SET appendonly yes` to rewrite the AOF, then
     restarts normally. For `snapshot`, it stops the workload, moves
     `data` aside to `data.pre-restore`, extracts, starts the workload, and
     deletes `data.pre-restore` only once the workload is healthy;
     otherwise it rolls back.
- **`new_service`**: needs `services:manage` and `backups:restore`. Builds
  a change set (0006) with
  `service.create { database: { engine, version: backup.engine_version } }`
  named `<slug>-restore-<yyyymmdd>` in the target environment, applies
  it, waits until healthy, then restores into it. The original is not
  touched. This is the default in the dashboard.
- **`target_node_id`**: used with `in_place` to recover a service whose
  node is gone (0005, offline handling). It creates a new volume on the
  target node, marks the old one `abandoned`, repoints the service,
  deploys, and restores.

```sql
CREATE TABLE restores (
  id TEXT PRIMARY KEY,                                  -- rst_…
  backup_id TEXT NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
  mode TEXT NOT NULL, target_service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  target_environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  safety_backup_id TEXT REFERENCES backups(id) ON DELETE SET NULL,
  status TEXT NOT NULL,                 -- queued | running | succeeded | failed
  error TEXT, requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
```

**Download.** `GET /v1/backups/{id}/download` returns a 15-minute
presigned GET for the encrypted object. `POST /v1/backups/{id}/decryption-key`
returns the age identity. It needs `variables:reveal` and is audited as
`backup.key_revealed`. The CLI's `roundhouse backups download --decrypt`
combines the two.

### Volume migration between nodes

`POST /v1/volumes/{id}/migrate { target_node_id }` (`services:manage`)
starts `VOLUME_MIGRATION_WORKFLOW`, instance ID `mig_…`. Migration copies
through object storage, so it works between any two nodes, mesh or not,
and leaves a backup behind:
1. **Check.** The target node is online with protocol 4 or later, passes
   the scheduler (disk, selector), and has `quota_mode` other than `none`,
   unless the source also has `none`.
2. Set the volume to `migrating` and stop the service. Its placements end
   and desired state is pushed, so the agent stops the container and keeps
   the volume.
3. Run `volume_copy_out`: a quiesced snapshot backup with
   `trigger: migration`.
4. Create the volume on the target (`desired_state.volumes`), wait for
   `ready`, and run `volume_copy_in` (a snapshot restore).
5. Set `volumes.node_id = target` and deploy the service's active
   deployment again (a redeploy of the same image and config version).
   Wait until healthy.
6. On the source, the volume leaves `desired_state` and becomes
   `orphaned`. The workflow sends `volume_delete` for it after 72 h. The
   migration backup is kept for 7 days.

Downtime equals copy-out plus copy-in time. The dashboard estimates it
from `used_bytes` and the last backup's throughput before the operator
confirms. Any failure before step 5 restarts the service on the source.

### Data browser and query runner

**Channel.** `POST /v1/services/{id}/database/query` calls the volume
node's DO over RPC (`runQuery`). The DO sends a signed `db_query` and
awaits `db_query_result`, correlated by `request_id`, with a 35 s timeout.
The agent connects from the host to the container's bridge IP with a
native driver: `pgx/v5`, `go-sql-driver/mysql`, `go.mongodb.org/mongo-driver/v2`,
and a minimal RESP client. It does not shell out. A driver is used
instead of `docker exec psql` because only a driver can enforce
read-only transactions, single statements, row caps and typed results.

**Operations** (`DbOp`, discriminated on `type`):

| `type`               | Engines    | Semantics                                                                                                      |
| -------------------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| `list_namespaces`    | all        | databases / schemas / Redis DB indexes                                                                         |
| `list_tables`        | all        | tables, views, collections, or a `SCAN` page of keys with type                                                 |
| `describe`           | SQL, mongo | columns and types / sampled document fields                                                                    |
| `rows`               | all        | page of a table (identifiers quoted by the driver, `LIMIT`/`OFFSET`, optional `order_by` column) or key values |
| `raw`                | all        | `statement` (≤ 64 KiB) with positional `params`; for mongo a command document; for redis an argv               |
| `provision_readonly` | all        | creates `roundhouse_ro` (system use only, never from the API)                                                  |

**Read-only by default, enforced three ways.**
1. **Principal.** `mode: "read"` connects as `roundhouse_ro`. `write` uses
   the admin credential.
2. **Transaction.**
   - Postgres: `BEGIN READ ONLY`, `SET LOCAL statement_timeout`, always
     `ROLLBACK`.
   - MySQL: `START TRANSACTION READ ONLY`, `MAX_EXECUTION_TIME`.
   - Mongo: only `find`, `aggregate` (rejecting `$out` and `$merge`),
     `count`, `distinct`, `listCollections` and `listDatabases`, with
     `maxTimeMS`.
   - Redis: a read command allowlist (`GET MGET HGET HGETALL LRANGE
     SMEMBERS ZRANGE SCAN TYPE TTL STRLEN XRANGE EXISTS DBSIZE INFO`), with
     counts capped.
3. **Protocol.** SQL runs through the extended protocol, or with
   `multiStatements=false`, so a `; DROP …` is a syntax error, not a
   second statement.

**Limits.** `max_rows` defaults to 100 and is capped at 1000. The agent
fetches `max_rows + 1` and sets `truncated`. Results are capped at
448 KiB of encoded JSON so they fit an agent frame. `bytea`/`BLOB` values
come back as `{"$b64": "…"}` and 64-bit integers as strings. At most 4
queries run per node at once, and at most 2 per second per user.

**Write mode** needs `data:write`, `mode: "write"`, and, from the
dashboard, a typed service slug once per browser session. Each statement
runs in its own transaction and is committed if it succeeds.

**Audit.**
- `database.query_executed` records every `raw` query, read or write: mode,
  the first 2 KiB of the statement, its SHA-256, row count, duration and
  outcome.
- Structured browse operations are not audited one by one. Opening the
  browser records `database.browser_opened` once per page load.
- Query results are never stored.

### TCP proxy

`PUT /v1/services/{id}/tcp-proxies` takes
`{ environment_id, container_port, allowed_cidrs: string[] }`, also
available as a staged op.
- Only single-replica services can use it.
- The control plane allocates a host port from the instance setting
  `tcp_proxy_port_range` (default `20000-29999`), unique per node, and
  sets `ports[].publish`. That changes the spec hash, so the container is
  recreated: a database restarts once.
- Docker publishes the port (kernel DNAT), so connections survive agent
  restarts. The agent's `inet roundhouse` table (0005) holds a forward
  rule at priority `filter - 1` that drops any source outside
  `allowed_cidrs`. That drop is final, so the allowlist holds whatever
  Docker accepts.
- `allowed_cidrs` must be non-empty. `0.0.0.0/0` is accepted, but only
  explicitly, and the dashboard then warns that the connection is not
  encrypted end to end unless the client and engine negotiate TLS.
- New built-ins: `ROUNDHOUSE_TCP_PROXY_DOMAIN` (the node's
  `public_hostname`, else its public IP) and `ROUNDHOUSE_TCP_PROXY_PORT`.
  Templates add `DATABASE_PUBLIC_URL` from them.

```sql
CREATE TABLE tcp_proxies (
  id TEXT PRIMARY KEY,                                  -- tcp_…
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  container_port INTEGER NOT NULL, node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  public_port INTEGER NOT NULL, allowed_cidrs TEXT NOT NULL,   -- JSON string[]
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX tcp_proxies_node_port_uq ON tcp_proxies(node_id, public_port);
ALTER TABLE nodes ADD COLUMN public_hostname TEXT;
```

### Routes, RBAC, audit

| Method and path                                                     | RBAC action                                                 | Audit                                      |
| ------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| `POST /v1/projects/{projectId}/databases`                           | `services:manage`, `variables:manage`, `deployments:create` | via 0006 apply                             |
| `POST /v1/services/{serviceId}/database/rotate-credentials`         | `variables:reveal`, `deployments:create`                    | `database.credentials_rotated`             |
| `GET /v1/services/{serviceId}/volume?environment_id=`               | `services:read`                                             | none                                       |
| `PATCH /v1/volumes/{volumeId}` `{size_mb}`                          | `services:manage`                                           | `volume.resized`                           |
| `DELETE /v1/volumes/{volumeId}`                                     | `services:manage`                                           | `volume.deleted`                           |
| `POST /v1/volumes/{volumeId}/undelete`                              | `services:manage`                                           | `volume.undeleted`                         |
| `POST /v1/volumes/{volumeId}/migrate`                               | `services:manage`                                           | `volume.migration_started`                 |
| `GET /v1/volume-migrations/{migrationId}`                           | `services:read`                                             | none                                       |
| `GET`, `PUT /v1/services/{serviceId}/backup-policy?environment_id=` | `services:read` / `backups:manage`                          | `backup.policy_updated`                    |
| `GET /v1/services/{serviceId}/backups?environment_id=`              | `services:read`                                             | none                                       |
| `POST /v1/services/{serviceId}/backups`                             | `backups:manage`                                            | `backup.requested`                         |
| `GET /v1/backups/{backupId}`                                        | `services:read`                                             | none                                       |
| `DELETE /v1/backups/{backupId}`                                     | `backups:manage`                                            | `backup.deleted`                           |
| `GET /v1/backups/{backupId}/download`                               | `backups:restore`                                           | `backup.downloaded`                        |
| `POST /v1/backups/{backupId}/decryption-key`                        | `variables:reveal`                                          | `backup.key_revealed`                      |
| `POST /v1/backups/{backupId}/restore`                               | `backups:restore` (+ `services:manage` for `new_service`)   | `restore.started`                          |
| `GET /v1/restores/{restoreId}`                                      | `services:read`                                             | none                                       |
| `GET /v1/services/{serviceId}/database/schema?environment_id=`      | `data:read`                                                 | `database.browser_opened`                  |
| `POST /v1/services/{serviceId}/database/query`                      | `data:read` (`data:write` for `mode: write`)                | `database.query_executed` (raw)            |
| `PUT`, `DELETE /v1/services/{serviceId}/tcp-proxies`                | `services:manage`                                           | `tcp_proxy.enabled` / `tcp_proxy.disabled` |

New RBAC actions:
- `data:read`, `backups:manage`: owner, admin and member.
- `data:write`, `backups:restore`: owner and admin.

Viewers get none of them, because data can be as sensitive as secrets.

System-written audit actions (actor `system`): `restore.succeeded`,
`restore.failed`, `volume.migrated`, and `backup.failed`, which also feeds
0008 alerts. Scheduled successes are not audited; they are visible in the
backup list.

New ID prefixes: `vol`, `bak`, `bpl`, `rst`, `mig`, `tcp`.

### Dashboard

- **Add → Database.** Pick an engine and version, preview the change set
  (service, volume, credentials masked), and apply. The canvas shows a
  database node with engine icon, volume usage bar and backup status.
- **Service → Data tab.** A schema tree on the left. On the right, a rows
  grid (paged, 100 per page) and a query editor (CodeMirror with SQL, JSON
  or Redis mode) with a Read-only / Write toggle. Write needs `data:write`,
  shows a red banner, and asks for the typed slug once. Truncation and
  timing appear under results. "Copy as CSV" is local only.
- **Service → Backups tab.** Policy editor (schedule with a next-runs
  preview, retention), a list with size, duration and status, "Back up
  now", and Restore (new service by default, or in place, with the typed
  slug), plus Download.
- **Service → Volume panel.** Size with a grow-only resize, usage, quota
  mode ("not enforced" warning), node, and a Migrate wizard with a
  downtime estimate.
- **Service → Networking.** TCP proxy toggle with a CIDR list, the public
  endpoint, and a copy button for `DATABASE_PUBLIC_URL`.

## Security

- Database credentials are generated server-side from a CSPRNG and stored
  as secret variables (sealed, masked, redacted from logs). Rotation is a
  first-class route.
- **Least privilege by default.** The data browser defaults to a
  read-only principal that the engine itself confines, plus read-only
  transactions and single-statement protocols. Write mode requires a
  separate admin-only action and is audited per statement.
- Credentials for queries, presigned URLs and age identities travel only
  in signed frames with a 60 s TTL. Presigned URLs are scoped to one part
  or one object and expire in at most 1 h.
- **Backups are encrypted client-side** to a per-project age key, so the
  bucket or its token alone reveals nothing. Revealing the key is
  audited.
- Agent invariants prevent data loss from a control-plane bug: a volume is
  never auto-deleted, never mounted twice, and never deleted without a
  signed `volume_delete` issued 72 h after a soft delete.
- The TCP proxy requires an explicit allowlist, which the agent enforces
  with a final nftables drop.

## Testing strategy

- **Unit (TS).** `renderDatabaseService` snapshots per engine and version;
  part-size selection; retention selection (property: the newest
  `keep_last` scheduled backups always survive); restore planning;
  scheduler `pinnedNodeId` and `diskMb`.
- **Unit (Go).**
  - The RHBK1 encoder and decoder, fuzzed, against shared vectors.
  - The part splitter (all parts equal except the last).
  - The read-only guards: multi-statement rejection, the Mongo pipeline
    stage denylist, the Redis allowlist.
  - The mount-exclusivity state machine.
- **Agent integration** (`-tags integration`, Docker):
  - Every engine: exec health check, `provision_readonly`, an `INSERT`
    refused in read mode, backup to the fake S3, restore into a fresh
    container, row-for-row equality.
  - `loop` quota: write past the quota gives `ENOSPC`, then an online grow
    lets the write succeed. This runs on Linux CI only (privileged
    container, `rshared` bind of the volumes root). On Docker Desktop it is
    skipped and `none` mode is tested instead.
- **Fake S3** (`e2e/lib/fake-s3.mjs`). It implements CreateMultipartUpload,
  presigned UploadPart and GET (SigV4 query auth verified),
  CompleteMultipartUpload, Abort, Head, Delete and ListObjectsV2, and it
  **enforces R2's rules**: 5 MiB minimum, equal non-final parts, 10,000
  parts. It is unit-tested against recorded R2 responses in
  `e2e/fixtures/r2/*.xml`.
- **Real-stack e2e** (`e2e/phase2`, two nodes from 0005):
  1. Add Postgres 18 through the API: active, `exec` health passed, volume
     `ready`.
  2. A Next.js app with `DATABASE_URL=${{db.DATABASE_URL}}` on the other
     node writes a row through its HTTP route.
  3. Manual backup succeeds; the fake S3 holds one object with
     `part_count >= 1`.
  4. Write a second row and restore the first backup into a new service:
     it has one row and the original has two. Restore in place: the
     original has one row and a `pre_restore` backup exists.
  5. The data browser lists tables. `INSERT` in read mode fails with a
     read-only error, works in write mode, and both are in the audit log.
  6. Migrate the volume from node A to node B: the service comes back
     healthy on B with the same rows, and A's volume is `orphaned`.
  7. Enable the TCP proxy with `allowed_cidrs: ["<runner IP>/32"]`: `psql`
     from the runner connects; a client from another IP in a third
     container cannot.
  8. MySQL, Redis and MongoDB: create, back up, restore into new, compare.

## Rollout and compat

- **Protocol 4.** Gates: `VOLUMES_PROTOCOL_VERSION = 4` (volumes, mounts,
  `exec` probes, `stop_first`, publish), `BACKUPS_PROTOCOL_VERSION = 4`,
  `DB_QUERY_PROTOCOL_VERSION = 4`. The scheduler's `minProtocolVersion: 4`
  keeps volume services off v3 agents, which never receive these fields.
- **Migrations** are additive. Existing `kind: "database"` services without
  a template keep running as apps; the dashboard offers no conversion.
- **Wrangler** gains the minute cron, the `JOBS` queue and DLQ, and the
  `BACKUP_WORKFLOW` and `VOLUME_MIGRATION_WORKFLOW` bindings. Queues are
  available on the Free plan with a 10,000 operations per day cap.

## Consequences

- Databases are first-class: credentials, health, backups, restore,
  browsing and external access come with the template.
- **A volume ties a service to a node.** Deploys restart it (recreate),
  and moving it means downtime proportional to its size.
- The agent gains database drivers (pgx, MySQL, Mongo) and age. This adds
  about 15 MB to the binary, accepted so that queries can be typed and
  safe.

## Open questions

- Default Redis-compatible image: `redis:8` (tri-license including AGPLv3)
  or Valkey (BSD)? The template registry supports both. The default is a
  licensing call for the maintainers.
- Server-side TLS for engines exposed through the TCP proxy (generated
  certificates inside the volume, Postgres `sslnegotiation=direct`).
  Deferred to Phase 3.
- Live-copy migration over the mesh (rsync-style passes, then a short
  stop) to cut downtime for large volumes.
- Confirm on a live R2 bucket that presigned `UploadPart` URLs (PUT with
  `partNumber` and `uploadId`) are accepted. The R2 docs show presigned
  `PutObject` only.

## Sources

- Docker `--storage-opt size` support matrix, https://docs.docker.com/reference/cli/docker/container/run/ (retrieved 2026-10-22); bind mounts and `CreateMountpoint`, https://docs.docker.com/engine/storage/bind-mounts/ (retrieved 2026-10-22)
- Exec API (hijack, resize, `Pid`; no kill on disconnect), Engine API swagger at moby tag docker-v29.9.2 (retrieved 2026-10-22)
- xfs_quota project quotas, https://man7.org/linux/man-pages/man8/xfs_quota.8.html; ext4 `project`/`prjquota`, https://man7.org/linux/man-pages/man5/ext4.5.html; `chattr -p +P`, https://man7.org/linux/man-pages/man1/chattr.1.html; `setquota -P`, https://man7.org/linux/man-pages/man8/setquota.8.html; loop-control, https://man7.org/linux/man-pages/man4/loop.4.html (all retrieved 2026-10-22)
- PostgreSQL versions (18.6 current; 19 RC1 2026-10-15), https://www.postgresql.org/support/versioning/; `pg_dump`, https://www.postgresql.org/docs/current/app-pgdump.html; `pg_restore` stdin and `-j`, https://www.postgresql.org/docs/current/app-pgrestore.html (retrieved 2026-10-22)
- Postgres 18 image `PGDATA` layout, https://hub.docker.com/_/postgres (retrieved 2026-10-22)
- mysqldump (`--single-transaction`, defaults), https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html and https://dev.mysql.com/doc/refman/8.4/en/mysqldump-stored-programs.html; 9.7 LTS and new versioning, https://dev.mysql.com/doc/refman/9.5/en/mysql-releases.html; tags, https://hub.docker.com/_/mysql (retrieved 2026-10-22)
- `redis-cli --rdb -`, https://redis.io/docs/latest/develop/tools/cli/; Redis licenses, https://redis.io/legal/licenses/; Valkey 9.1.2, https://valkey.io/ (retrieved 2026-10-22)
- mongodump/mongorestore `--archive`, https://www.mongodb.com/docs/database-tools/mongodump/ and https://www.mongodb.com/docs/database-tools/mongorestore/; versions (9.0 current), https://www.mongodb.com/docs/mongodb-versions/ (retrieved 2026-10-22)
- klauspost/compress zstd v1.20.3 (2026-10-12), https://pkg.go.dev/github.com/klauspost/compress/zstd
- R2 multipart (5 MiB min, equal parts, 7-day auto-abort), https://developers.cloudflare.com/r2/objects/multipart-objects/ (updated 2026-07-29); limits, https://developers.cloudflare.com/r2/platform/limits/ (updated 2026-06-08); presigned URLs, https://developers.cloudflare.com/r2/api/s3/presigned-urls/ (updated 2026-08-22); S3 API coverage, https://developers.cloudflare.com/r2/api/s3/api/ (updated 2026-10-14); lifecycle rules, https://developers.cloudflare.com/r2/buckets/object-lifecycles/ (retrieved 2026-10-22); Workers binding multipart, https://developers.cloudflare.com/r2/api/workers/workers-api-reference/ (updated 2026-07-31)
- Cron Triggers (`controller.cron`, UTC, account limits), https://developers.cloudflare.com/workers/configuration/cron-triggers/ (updated 2026-10-17) and https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
- Queues limits, pricing (Free plan 10k ops/day), DLQ, https://developers.cloudflare.com/queues/platform/limits/, https://developers.cloudflare.com/queues/platform/pricing/, https://developers.cloudflare.com/queues/configuration/dead-letter-queues/ (retrieved 2026-10-22)
- Workflows limits and `waitForEvent` (event type: letters, digits, `-`, `_`), https://developers.cloudflare.com/workflows/reference/limits/ (updated 2026-09-21), https://developers.cloudflare.com/workflows/build/events-and-parameters/
