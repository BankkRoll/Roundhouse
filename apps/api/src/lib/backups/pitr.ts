/**
 * Point-in-time recovery for Postgres (ADR 0004, "Point-in-time
 * recovery"): continuous WAL archiving into the backup bucket, the
 * restorable window, and planning a restore to a timestamp.
 *
 * A service has at most one `active` WAL stream per environment, tied to
 * the volume whose database writes it. The node holding that volume is
 * told to archive (`desired_state.volumes[].wal_archive`, and the
 * `archive_*` settings on the database's command), ships each finished WAL
 * file with `wal_archive`, and gets upload URLs and acknowledgements back in
 * `wal_archive_ack`. A restore that replaces the data, a new volume, or
 * turning point-in-time recovery off retires the stream; the next one
 * starts with a fresh base backup, so file names never collide within one.
 *
 * Responsibilities:
 * - the stream lifecycle ({@link ensureWalStream}, {@link retireWalStreams})
 *   and the minute-tick reconcile that starts streams and their first base
 *   backup ({@link claimPitrStreams});
 * - which volumes archive, for the desired state ({@link walArchivesFor});
 * - recording shipped files and handing out upload and download URLs
 *   ({@link onWalArchive}, {@link onWalFetchRequest});
 * - the restorable window and restore planning ({@link pitrWindows},
 *   {@link planPitrRestore}, {@link walFetchList});
 * - retention: WAL older than a stream's oldest kept base backup, and
 *   streams with no base backup left ({@link applyWalRetention}).
 *
 * SECURITY: a node's report counts only for a stream of a volume pinned to
 * it, and URLs go only to that node, sealed under its key and bound to the
 * stream or restore, each for one object.
 *
 * @module
 */
import {
  backupPolicies,
  backups,
  createDb,
  type Db,
  nodes,
  restores,
  serviceConfigs,
  services,
  volumes,
  walSegments,
  walStreams,
} from "@roundhouse/db";
import {
  type ArchivedWalFile,
  nextWalSegment,
  PITR_PROTOCOL_VERSION,
  type SealedBox,
  SealedWalFilesSchema,
  SealedWalUploadsSchema,
  sealBox,
  WAL_SEGMENT_RE,
  type WalArchive,
  type WalFetchRequest,
  walFetchAad,
  walTimeline,
  walUploadAad,
} from "@roundhouse/protocol";
import { newId, walObjectKey } from "@roundhouse/shared";
import { and, asc, desc, eq, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { Env } from "../../env";
import { refreshNodes } from "../desired-state";
import type { KeyEnv } from "../keyring";
import {
  deleteObject,
  presignGet,
  presignPut,
  RESTORE_URL_TTL_S,
  type S3Config,
  UPLOAD_PART_URL_TTL_S,
} from "../s3";
import { volumeOf } from "../volumes";
import { createBackupRow, startBackupWorkflow } from "./backups";
import { ensureBackupRecipient } from "./keys";
import { loadBackupStorage } from "./storage";

/** A `wal_streams` row. */
export type WalStreamRow = typeof walStreams.$inferSelect;

/** How long after a failed or missing first base backup the tick asks for another. */
export const BASE_RETRY_MS = 30 * 60 * 1000;

/** WAL objects one maintenance run deletes, so it stays within its time. */
export const WAL_DELETE_BATCH = 500;

/** D1 binds at most 100 parameters; a segment row takes seven. */
const SEGMENTS_PER_STATEMENT = 14;

/** Why point-in-time recovery can't run for a service, or `null`. */
export type PitrIneligibility = string | null;

// -----------------------------------------------------------------------------
// Eligibility and streams
// -----------------------------------------------------------------------------

/**
 * Why a service can't archive WAL in an environment, or `null` when it can:
 * it must be a Postgres database without a custom start command (the
 * archive settings go on its `postgres` command line), placed on a node
 * whose agent ships WAL.
 *
 * @param db - Database client.
 * @param service - The service.
 * @param environmentId - The environment.
 * @returns A sentence for the dashboard, or `null`.
 */
export async function pitrIneligibility(
  db: Db,
  service: { id: string; databaseEngine: string | null },
  environmentId: string,
): Promise<PitrIneligibility> {
  if (service.databaseEngine !== "postgres") {
    return "Point-in-time recovery is available for Postgres databases only";
  }
  const [config] = await db
    .select({ deploy: serviceConfigs.deploy })
    .from(serviceConfigs)
    .where(
      and(
        eq(serviceConfigs.serviceId, service.id),
        eq(serviceConfigs.environmentId, environmentId),
      ),
    )
    .orderBy(desc(serviceConfigs.version))
    .limit(1);
  if (config?.deploy.start_command) {
    return "The database has a custom start command; point-in-time recovery sets its own";
  }
  const volume = await volumeOf(db, service.id, environmentId);
  if (volume?.nodeId) {
    const [node] = await db
      .select({ protocolVersion: nodes.protocolVersion, name: nodes.name })
      .from(nodes)
      .where(eq(nodes.id, volume.nodeId))
      .limit(1);
    if (node && node.protocolVersion < PITR_PROTOCOL_VERSION) {
      return `${node.name} runs an agent without WAL archiving; upgrade it`;
    }
  }
  return null;
}

/**
 * The service's active stream in an environment.
 *
 * @param db - Database client.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @returns The row, or `undefined`.
 */
export async function activeWalStream(
  db: Db,
  serviceId: string,
  environmentId: string,
): Promise<WalStreamRow | undefined> {
  const [row] = await db
    .select()
    .from(walStreams)
    .where(
      and(
        eq(walStreams.serviceId, serviceId),
        eq(walStreams.environmentId, environmentId),
        eq(walStreams.status, "active"),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Retires the service's active stream: it stops receiving WAL and is kept
 * for restores until retention removes its last base backup.
 *
 * @param db - Database client.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @param now - Unix ms.
 * @returns The retired stream's volume, whose node's desired state changes.
 */
export async function retireWalStreams(
  db: Db,
  serviceId: string,
  environmentId: string,
  now = Date.now(),
): Promise<string | null> {
  const rows = await db
    .update(walStreams)
    .set({ status: "retired", retiredAt: new Date(now), updatedAt: new Date(now) })
    .where(
      and(
        eq(walStreams.serviceId, serviceId),
        eq(walStreams.environmentId, environmentId),
        eq(walStreams.status, "active"),
      ),
    )
    .returning({ volumeId: walStreams.volumeId });
  return rows[0]?.volumeId ?? null;
}

/**
 * The active stream for a volume, starting one (and retiring one of
 * another volume) when needed.
 *
 * @param db - Database client.
 * @param volume - The service's live volume.
 * @param now - Unix ms.
 * @returns The stream and whether this call started it.
 */
export async function ensureWalStream(
  db: Db,
  volume: { id: string; projectId: string; serviceId: string; environmentId: string },
  now = Date.now(),
): Promise<{ stream: WalStreamRow; started: boolean }> {
  const current = await activeWalStream(db, volume.serviceId, volume.environmentId);
  if (current?.volumeId === volume.id) return { stream: current, started: false };
  if (current) await retireWalStreams(db, volume.serviceId, volume.environmentId, now);
  const [created] = await db
    .insert(walStreams)
    .values({
      id: newId("walStream"),
      projectId: volume.projectId,
      serviceId: volume.serviceId,
      environmentId: volume.environmentId,
      volumeId: volume.id,
      status: "active",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
    .onConflictDoNothing()
    .returning();
  if (created) return { stream: created, started: true };
  // A concurrent call started it; the partial unique index decided.
  const raced = await activeWalStream(db, volume.serviceId, volume.environmentId);
  if (!raced) throw new Error("WAL stream insert conflicted with no active stream");
  return { stream: raced, started: false };
}

/**
 * The `wal_archive` settings of the given volumes: each one whose service
 * has point-in-time recovery on and an active stream for that volume.
 *
 * @param db - Database client.
 * @param keys - Keyring, for the project's age recipient.
 * @param vols - Volumes a node holds.
 * @returns Settings by volume ID.
 */
export async function walArchivesFor(
  db: Db,
  keys: KeyEnv,
  vols: readonly { id: string; projectId: string }[],
): Promise<Map<string, { stream_id: string; age_recipient: string }>> {
  const out = new Map<string, { stream_id: string; age_recipient: string }>();
  const ids = vols.map((v) => v.id);
  const rows: { stream: WalStreamRow }[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    rows.push(
      ...(await db
        .select({ stream: walStreams })
        .from(walStreams)
        .innerJoin(
          backupPolicies,
          and(
            eq(backupPolicies.serviceId, walStreams.serviceId),
            eq(backupPolicies.environmentId, walStreams.environmentId),
          ),
        )
        .where(
          and(
            eq(walStreams.status, "active"),
            eq(backupPolicies.pitr, true),
            eq(backupPolicies.enabled, true),
            inArray(walStreams.volumeId, ids.slice(i, i + 90)),
          ),
        )),
    );
  }
  const recipients = new Map<string, string>();
  for (const { stream } of rows) {
    let recipient = recipients.get(stream.projectId);
    if (!recipient) {
      recipient = await ensureBackupRecipient(db, keys, stream.projectId);
      recipients.set(stream.projectId, recipient);
    }
    out.set(stream.volumeId!, { stream_id: stream.id, age_recipient: recipient });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Node frames
// -----------------------------------------------------------------------------

/** What the frame handlers need from the node's Durable Object. */
export interface PitrFrameContext {
  db: Db;
  env: Env;
  nodeId: string;
  /** Signs and sends a control frame to this node with the credential TTL. */
  reply(frame: WalArchiveAckBody | WalFetchBody): Promise<void>;
}

/** Body of a `wal_archive_ack`; the Durable Object adds the signed header. */
export interface WalArchiveAckBody {
  type: "wal_archive_ack";
  volume_id: string;
  stream_id: string;
  acked: string[];
  uploads_sealed?: SealedBox;
}

/** Body of a `wal_fetch`; the Durable Object adds the signed header. */
export interface WalFetchBody {
  type: "wal_fetch";
  restore_id: string;
  files_sealed: SealedBox;
}

async function nodeKey(db: Db, nodeId: string): Promise<string | null> {
  const [node] = await db
    .select({ key: nodes.encryptionPublicKey })
    .from(nodes)
    .where(eq(nodes.id, nodeId))
    .limit(1);
  return node?.key ?? null;
}

/**
 * Records the files a node shipped, acknowledges them, and hands out
 * upload URLs for the ones it spooled, for a stream of a volume on that
 * node. A retired stream's late reports are recorded but get no URLs.
 *
 * @param ctx - Database, bindings, node and reply channel.
 * @param frame - The validated `wal_archive`.
 */
export async function onWalArchive(ctx: PitrFrameContext, frame: WalArchive): Promise<void> {
  const { db } = ctx;
  const [row] = await db
    .select({ stream: walStreams })
    .from(walStreams)
    .innerJoin(volumes, eq(volumes.id, walStreams.volumeId))
    .where(
      and(
        eq(walStreams.id, frame.stream_id),
        eq(walStreams.volumeId, frame.volume_id),
        eq(volumes.nodeId, ctx.nodeId),
        ne(walStreams.status, "deleted"),
      ),
    )
    .limit(1);
  if (!row) return;
  const { stream } = row;
  const now = Date.now();
  if (frame.archived.length) await recordWalFiles(db, stream.id, frame.archived, now);
  let uploadsSealed: SealedBox | undefined;
  if (frame.pending.length && stream.status === "active") {
    const storage = await loadBackupStorage(db, ctx.env);
    const key = await nodeKey(db, ctx.nodeId);
    if (storage && key) {
      const uploads = [];
      for (const name of frame.pending) {
        uploads.push({
          name,
          url: await presignPut(storage, objectKeyOf(stream, name), UPLOAD_PART_URL_TTL_S, now),
        });
      }
      uploadsSealed = await sealBox(
        key,
        JSON.stringify(SealedWalUploadsSchema.parse({ uploads })),
        "wal-upload",
        walUploadAad(ctx.nodeId, stream.id),
      );
    }
  }
  await ctx.reply({
    type: "wal_archive_ack",
    volume_id: frame.volume_id,
    stream_id: stream.id,
    acked: frame.archived.map((f) => f.name),
    ...(uploadsSealed ? { uploads_sealed: uploadsSealed } : {}),
  });
}

function objectKeyOf(stream: WalStreamRow, name: string): string {
  return walObjectKey({
    projectId: stream.projectId,
    serviceId: stream.serviceId,
    environmentId: stream.environmentId,
    streamId: stream.id,
    name,
  });
}

async function recordWalFiles(
  db: Db,
  streamId: string,
  files: readonly ArchivedWalFile[],
  now: number,
): Promise<void> {
  const statements = [];
  for (let i = 0; i < files.length; i += SEGMENTS_PER_STATEMENT) {
    statements.push(
      db
        .insert(walSegments)
        .values(
          files.slice(i, i + SEGMENTS_PER_STATEMENT).map((f) => ({
            streamId,
            name: f.name,
            sizeRaw: f.size_raw,
            sizeStored: f.size_stored,
            sha256: f.sha256,
            archivedAt: new Date(f.archived_at),
            createdAt: new Date(now),
          })),
        )
        .onConflictDoNothing(),
    );
  }
  statements.push(refreshStreamStats(db, streamId, now));
  await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
}

function refreshStreamStats(db: Db, streamId: string, now: number) {
  return db
    .update(walStreams)
    .set({
      segmentCount: sql`(SELECT count(*) FROM ${walSegments} WHERE ${walSegments.streamId} = ${streamId})`,
      bytesStored: sql`(SELECT coalesce(sum(${walSegments.sizeStored}), 0) FROM ${walSegments} WHERE ${walSegments.streamId} = ${streamId})`,
      firstArchivedAt: sql`(SELECT min(${walSegments.archivedAt}) FROM ${walSegments} WHERE ${walSegments.streamId} = ${streamId})`,
      lastArchivedAt: sql`(SELECT max(${walSegments.archivedAt}) FROM ${walSegments} WHERE ${walSegments.streamId} = ${streamId})`,
      lastFile: sql`(SELECT ${walSegments.name} FROM ${walSegments} WHERE ${walSegments.streamId} = ${streamId} ORDER BY ${walSegments.archivedAt} DESC, ${walSegments.name} DESC LIMIT 1)`,
      updatedAt: new Date(now),
    })
    .where(eq(walStreams.id, streamId));
}

/**
 * Answers a running base restore's `wal_fetch_request` with presigned GETs
 * of its next WAL files, sealed to the restore's node.
 *
 * @param ctx - Database, bindings, node and reply channel.
 * @param frame - The validated request.
 */
export async function onWalFetchRequest(
  ctx: PitrFrameContext,
  frame: WalFetchRequest,
): Promise<void> {
  const { db } = ctx;
  const [row] = await db
    .select({ restore: restores, backup: backups })
    .from(restores)
    .innerJoin(backups, eq(backups.id, restores.backupId))
    .where(
      and(
        eq(restores.id, frame.restore_id),
        eq(restores.nodeId, ctx.nodeId),
        eq(restores.status, "running"),
      ),
    )
    .limit(1);
  if (!row?.backup.walStreamId || !row.restore.walEnd) return;
  const list = await walFetchList(db, row.backup, row.restore.walEnd);
  const slice = list.slice(frame.from, frame.from + frame.count);
  if (!slice.length) return;
  const [stream] = await db
    .select()
    .from(walStreams)
    .where(eq(walStreams.id, row.backup.walStreamId))
    .limit(1);
  const storage = await loadBackupStorage(db, ctx.env);
  const key = await nodeKey(db, ctx.nodeId);
  if (!stream || !storage || !key) return;
  const now = Date.now();
  const files = [];
  for (const [i, f] of slice.entries()) {
    files.push({
      index: frame.from + i,
      name: f.name,
      url: await presignGet(storage, objectKeyOf(stream, f.name), RESTORE_URL_TTL_S, now),
      sha256: f.sha256,
      size: f.sizeStored,
    });
  }
  await ctx.reply({
    type: "wal_fetch",
    restore_id: frame.restore_id,
    files_sealed: await sealBox(
      key,
      JSON.stringify(SealedWalFilesSchema.parse({ files })),
      "wal-fetch",
      walFetchAad(ctx.nodeId, frame.restore_id),
    ),
  });
}

// -----------------------------------------------------------------------------
// Planning
// -----------------------------------------------------------------------------

/** A segment as planning reads it. */
interface PlannedFile {
  name: string;
  archivedAt: number;
}

/** A base backup with the WAL that follows it without a gap. */
interface BaseRun {
  backup: typeof backups.$inferSelect;
  /** Segments from the base's start, consecutive, ascending. */
  run: PlannedFile[];
}

/**
 * The files a restore of `backup` through `walEnd` fetches, in order: the
 * history files of the base's timeline and those before it (never a later
 * one, since recovery stays on the base's timeline), then every segment of
 * that timeline from the base's start through `walEnd`.
 *
 * @param db - Database client.
 * @param backup - A `base` backup with its stream and start.
 * @param walEnd - The last segment.
 * @returns The list; indexes are positions in it.
 */
export async function walFetchList(
  db: Db,
  backup: { walStreamId: string | null; walStart: string | null },
  walEnd: string,
): Promise<(typeof walSegments.$inferSelect)[]> {
  if (!backup.walStreamId || !backup.walStart) return [];
  const timeline = walTimeline(backup.walStart);
  const rows = await db
    .select()
    .from(walSegments)
    .where(eq(walSegments.streamId, backup.walStreamId))
    .orderBy(asc(walSegments.name));
  const history = rows.filter((r) => r.name.endsWith(".history") && r.name.slice(0, 8) <= timeline);
  const segments = rows.filter(
    (r) =>
      WAL_SEGMENT_RE.test(r.name) &&
      walTimeline(r.name) === timeline &&
      r.name >= backup.walStart! &&
      r.name <= walEnd,
  );
  return [...history, ...segments];
}

async function baseRuns(db: Db, serviceId: string, environmentId: string): Promise<BaseRun[]> {
  const bases = await db
    .select()
    .from(backups)
    .where(
      and(
        eq(backups.serviceId, serviceId),
        eq(backups.environmentId, environmentId),
        eq(backups.method, "base"),
        eq(backups.status, "succeeded"),
        isNotNull(backups.walStreamId),
        isNotNull(backups.walStart),
        isNotNull(backups.finishedAt),
      ),
    )
    .orderBy(desc(backups.finishedAt));
  const byStream = new Map<string, PlannedFile[]>();
  const out: BaseRun[] = [];
  for (const backup of bases) {
    let files = byStream.get(backup.walStreamId!);
    if (!files) {
      const rows = await db
        .select({ name: walSegments.name, archivedAt: walSegments.archivedAt })
        .from(walSegments)
        .where(eq(walSegments.streamId, backup.walStreamId!))
        .orderBy(asc(walSegments.name));
      files = rows
        .filter((r) => WAL_SEGMENT_RE.test(r.name))
        .map((r) => ({ name: r.name, archivedAt: +r.archivedAt }));
      byStream.set(backup.walStreamId!, files);
    }
    const run: PlannedFile[] = [];
    let want = backup.walStart!;
    for (const f of files) {
      if (f.name < want) continue;
      if (f.name !== want) break;
      run.push(f);
      want = nextWalSegment(f.name);
    }
    out.push({ backup, run });
  }
  return out;
}

/** A range of restorable times, unix ms; `to` is exclusive. */
export interface PitrRange {
  from: number;
  to: number;
}

/**
 * The times a service can be restored to: for each base backup, from when
 * it finished to the last WAL segment that follows it without a gap,
 * merged.
 *
 * @param db - Database client.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @returns Ranges, oldest first.
 */
export async function pitrWindows(
  db: Db,
  serviceId: string,
  environmentId: string,
): Promise<PitrRange[]> {
  const ranges = (await baseRuns(db, serviceId, environmentId))
    .map(({ backup, run }) => ({
      from: +backup.finishedAt!,
      to: run.length ? Math.max(...run.map((f) => f.archivedAt)) : 0,
    }))
    .filter((r) => r.to > r.from)
    .sort((a, b) => a.from - b.from);
  const merged: PitrRange[] = [];
  for (const r of ranges) {
    const last = merged.at(-1);
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }
  return merged;
}

/** A planned point-in-time restore. */
export interface PitrPlan {
  backup: typeof backups.$inferSelect;
  /** How many files the agent fetches. */
  walFiles: number;
  /** The last segment it replays. */
  walEnd: string;
}

/**
 * Picks the newest base backup that finished before `target` and has
 * gapless WAL past it, and the WAL to replay: through the first segment
 * finished after `target`, which holds every record written up to it.
 *
 * @param db - Database client.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @param target - Unix ms.
 * @returns The plan, or `null` when no backup covers the time.
 */
export async function planPitrRestore(
  db: Db,
  serviceId: string,
  environmentId: string,
  target: number,
): Promise<PitrPlan | null> {
  for (const { backup, run } of await baseRuns(db, serviceId, environmentId)) {
    if (+backup.finishedAt! > target) continue;
    const end = run.find((f) => f.archivedAt > target);
    if (!end) continue;
    const files = await walFetchList(db, backup, end.name);
    return { backup, walFiles: files.length, walEnd: end.name };
  }
  return null;
}

// -----------------------------------------------------------------------------
// Minute tick
// -----------------------------------------------------------------------------

/**
 * Minute-tick claimer: for every policy with point-in-time recovery on,
 * makes sure the live volume has the active stream (starting a new one for
 * a new volume) and that the stream has a base backup, asking for one when
 * none exists or the last attempt is older than {@link BASE_RETRY_MS}.
 *
 * @param env - Worker bindings.
 * @param now - The tick's time, unix ms.
 * @returns How many streams were started or given a base backup.
 */
export async function claimPitrStreams(env: Env, now: number): Promise<number> {
  const db = createDb(env.DB);
  const policies = await db
    .select({ policy: backupPolicies, service: services })
    .from(backupPolicies)
    .innerJoin(services, eq(services.id, backupPolicies.serviceId))
    .where(and(eq(backupPolicies.pitr, true), eq(backupPolicies.enabled, true)))
    .orderBy(asc(backupPolicies.id))
    .limit(100);
  let handled = 0;
  const refresh = new Set<string>();
  for (const { policy, service } of policies) {
    if (service.deletedAt) continue;
    const volume = await volumeOf(db, service.id, policy.environmentId);
    if (!volume?.nodeId || volume.status !== "ready") continue;
    if (await pitrIneligibility(db, service, policy.environmentId)) continue;
    const { stream, started } = await ensureWalStream(db, volume, now);
    if (started) {
      handled++;
      refresh.add(volume.nodeId);
    }
    const [base] = await db
      .select({ status: backups.status, createdAt: backups.createdAt })
      .from(backups)
      .where(and(eq(backups.walStreamId, stream.id), eq(backups.method, "base")))
      .orderBy(desc(backups.createdAt))
      .limit(1);
    const hasBase = base && base.status !== "failed" && base.status !== "deleted";
    const recent = base && now - +base.createdAt < BASE_RETRY_MS;
    if (hasBase || recent) continue;
    try {
      await requestBaseBackup(env, db, { policy, service, stream, volumeId: volume.id }, now);
      handled++;
    } catch (err) {
      console.warn("base backup request failed", err instanceof Error ? err.message : "error");
    }
  }
  if (refresh.size) await refreshNodes(env, db, [...refresh]);
  return handled;
}

/**
 * Asks for a stream's base backup now, as a slot of the policy (so
 * retention treats it like any scheduled one).
 *
 * @param env - Bindings with `BACKUP_WORKFLOW`.
 * @param db - Database client.
 * @param input - The policy, service, stream and volume.
 * @param now - Unix ms; the slot.
 */
export async function requestBaseBackup(
  env: Pick<Env, "BACKUP_WORKFLOW">,
  db: Db,
  input: {
    policy: typeof backupPolicies.$inferSelect;
    service: typeof services.$inferSelect;
    stream: WalStreamRow;
    volumeId: string;
  },
  now = Date.now(),
): Promise<void> {
  const row = await createBackupRow(db, {
    projectId: input.service.projectId,
    serviceId: input.service.id,
    environmentId: input.policy.environmentId,
    trigger: "schedule",
    method: "base",
    engine: input.service.databaseEngine,
    engineVersion: input.service.databaseVersion,
    volumeId: input.volumeId,
    pinned: false,
    requestedBy: null,
    policyId: input.policy.id,
    scheduledFor: now,
  });
  await db
    .update(backups)
    .set({ walStreamId: input.stream.id })
    .where(and(eq(backups.id, row.id), eq(backups.status, "queued")));
  await startBackupWorkflow(env, row.id);
}

// -----------------------------------------------------------------------------
// Retention
// -----------------------------------------------------------------------------

/**
 * Deletes WAL no kept base backup needs (before the oldest one's start; the
 * history files stay while the stream does), and streams no longer active
 * whose last base backup is gone, with all their files. Objects first, rows
 * after, so a failed delete is retried next time.
 *
 * @param db - Database client.
 * @param s3 - The bucket.
 * @param now - Unix ms.
 * @returns How many WAL objects were deleted.
 */
export async function applyWalRetention(db: Db, s3: S3Config, now = Date.now()): Promise<number> {
  const streams = await db
    .select()
    .from(walStreams)
    .where(ne(walStreams.status, "deleted"))
    .orderBy(asc(walStreams.id))
    .limit(500);
  let deleted = 0;
  for (const stream of streams) {
    if (deleted >= WAL_DELETE_BATCH) break;
    const [oldest] = await db
      .select({ walStart: backups.walStart })
      .from(backups)
      .where(
        and(
          eq(backups.walStreamId, stream.id),
          eq(backups.method, "base"),
          inArray(backups.status, ["succeeded", "queued", "running"]),
        ),
      )
      .orderBy(asc(backups.walStart))
      .limit(1);
    if (!oldest && stream.status === "active") continue;
    const doomed = await db
      .select({ name: walSegments.name })
      .from(walSegments)
      .where(
        and(
          eq(walSegments.streamId, stream.id),
          ...(oldest?.walStart
            ? [lt(walSegments.name, oldest.walStart), sql`${walSegments.name} NOT LIKE '%.history'`]
            : []),
        ),
      )
      .limit(WAL_DELETE_BATCH - deleted);
    for (const f of doomed) {
      await deleteObject(s3, objectKeyOf(stream, f.name));
      await db
        .delete(walSegments)
        .where(and(eq(walSegments.streamId, stream.id), eq(walSegments.name, f.name)));
      deleted++;
    }
    if (doomed.length) {
      await refreshStreamStats(db, stream.id, now);
    }
    if (!oldest && stream.status === "retired") {
      const [left] = await db
        .select({ name: walSegments.name })
        .from(walSegments)
        .where(eq(walSegments.streamId, stream.id))
        .limit(1);
      if (!left) {
        await db
          .update(walStreams)
          .set({ status: "deleted", updatedAt: new Date(now) })
          .where(and(eq(walStreams.id, stream.id), eq(walStreams.status, "retired")));
      }
    }
  }
  return deleted;
}

/**
 * Runs WAL retention when backup storage is configured; for the hourly
 * maintenance.
 *
 * @param env - Bindings with `DB` and the keyring.
 * @param now - Unix ms.
 * @returns How many WAL objects were deleted.
 */
export async function runWalRetention(
  env: Pick<Env, "DB" | "MASTER_KEY" | "MASTER_KEYS_PREVIOUS">,
  now = Date.now(),
): Promise<number> {
  const db = createDb(env.DB);
  const s3 = await loadBackupStorage(db, env).catch(() => null);
  return s3 ? applyWalRetention(db, s3, now) : 0;
}
