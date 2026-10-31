/**
 * Point-in-time recovery for Postgres (ADR 0004): turning it on and off
 * through the backup policy (archive flags in the desired state, one
 * database restart), the `wal_archive` and `wal_fetch_request` frames
 * (sealed URLs, the credential TTL, acks, foreign and unknown streams),
 * the restorable window, `POST /v1/services/{id}/pitr/restore` with its
 * guards, the stream restart after an in-place base restore, and WAL
 * retention following backup retention.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { createDb } from "@roundhouse/db";
import {
  type ControlMessage,
  CREDENTIAL_FRAME_TTL_MS,
  type DesiredState,
  openBox,
  PITR_PROTOCOL_VERSION,
  type RestoreJob,
  SealedWalFilesSchema,
  SealedWalUploadsSchema,
  type WalArchive,
  type WalArchiveAck,
  type WalFetch,
  walFetchAad,
  walUploadAad,
} from "@roundhouse/protocol";
import { walObjectKey } from "@roundhouse/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyWalRetention,
  claimPitrStreams,
  onWalArchive,
  onWalFetchRequest,
  type PitrFrameContext,
  type WalArchiveAckBody,
  type WalFetchBody,
} from "../src/lib/backups/pitr";
import { runBackupMaintenance } from "../src/lib/backups/schedule";
import { setS3Transport, sha256Hex } from "../src/lib/s3";
import { auditRows, backupStage, type FakeDataAgent, waitForBackup } from "./backups-helpers";
import { type DatabaseStage, databaseStage, type StageNode, waitForState } from "./data-stage";
import { FAKE_S3 } from "./fake-s3";
import { addMember, eventually, NODE_ENCRYPTION_PRIVATE_KEY } from "./helpers";
import { settleDeployments } from "./pipeline-helpers";

let introspectors: { dispose(): Promise<void> }[] = [];
beforeEach(async () => {
  introspectors = [
    await introspectWorkflow(env.DEPLOY_WORKFLOW),
    await introspectWorkflow(env.BACKUP_WORKFLOW),
    await introspectWorkflow(env.RESTORE_WORKFLOW),
  ];
});
afterEach(async () => {
  await settleDeployments();
  for (const i of introspectors) await i.dispose();
  setS3Transport();
});

const decoder = new TextDecoder();
const MIN = 60_000;
const SEGMENT_BYTES = 16 * 1024 * 1024;

/** A timeline 1 segment name: `seg(2)` is `000000010000000000000002`. */
const seg = (n: number, timeline = 1) =>
  `${timeline.toString(16).toUpperCase().padStart(8, "0")}00000000${n
    .toString(16)
    .toUpperCase()
    .padStart(8, "0")}`;

interface PitrStatusBody {
  enabled: boolean;
  unavailable_reason: string | null;
  stream: { id: string; status: string; segment_count: number; bytes_stored: number } | null;
  windows: { from: number; to: number }[];
  base_backups: number;
}

interface RestoreBody {
  id: string;
  status: string;
  mode: string;
  backup_id: string;
  target_time: number | null;
  error: string | null;
}

type ErrorBody = { error: { code: string; message: string } };

/** A Postgres database on protocol 8 agents. */
const pitrStage = (nodes = 1) =>
  databaseStage({ nodes, hello: () => ({ protocol_version: PITR_PROTOCOL_VERSION }) });

/** Waits for the first frame of `type` that arrived at or after index `since`. */
function nextFrame<T extends ControlMessage["type"]>(
  agent: FakeDataAgent,
  type: T,
  since: number,
  match: (m: Extract<ControlMessage, { type: T }>) => boolean = () => true,
  timeoutMs = 10_000,
): Promise<Extract<ControlMessage, { type: T }>> {
  return agent.waitFor(
    (m): m is Extract<ControlMessage, { type: T }> =>
      m.type === type &&
      agent.received.indexOf(m) >= since &&
      match(m as Extract<ControlMessage, { type: T }>),
    timeoutMs,
  );
}

const setPitr = (s: DatabaseStage, pitr: boolean) =>
  s.owner.json<{ pitr: boolean; method: string } & Partial<ErrorBody>>(
    `/v1/services/${s.serviceId}/backup-policy`,
    { method: "PUT", json: { environment_id: s.envId, enabled: true, pitr } },
  );

const status = async (s: DatabaseStage) =>
  (await s.owner.json<PitrStatusBody>(`/v1/services/${s.serviceId}/pitr?environment_id=${s.envId}`))
    .body;

async function streams(serviceId: string) {
  const { results } = await env.DB.prepare(
    "SELECT id, volume_id, status FROM wal_streams WHERE service_id = ? ORDER BY created_at, id",
  )
    .bind(serviceId)
    .all<{ id: string; volume_id: string | null; status: string }>();
  return results;
}

/** The stream's first base backup, once it succeeded. */
async function firstBase(s: DatabaseStage, streamId: string) {
  const id = await eventually(async () => {
    const row = await env.DB.prepare(
      "SELECT id FROM backups WHERE wal_stream_id = ? AND method = 'base' ORDER BY created_at LIMIT 1",
    )
      .bind(streamId)
      .first<{ id: string }>();
    return row?.id;
  }, 10_000);
  return waitForBackup(s.owner, id);
}

/** The newest desired state the agent got whose volume entry passes `match`. */
function desiredFor(
  s: DatabaseStage,
  since: number,
  match: (v: NonNullable<DesiredState["volumes"]>[number]) => boolean,
) {
  return nextFrame(s.home.agent, "desired_state", since, (m) =>
    (m.volumes ?? []).some((v) => v.id === s.volumeId && match(v)),
  );
}

const workloadOf = (s: DatabaseStage, m: DesiredState) =>
  m.workloads.find((w) => w.service_id === s.serviceId)!;

async function openUploads(nodeId: string, ack: WalArchiveAck) {
  return SealedWalUploadsSchema.parse(
    JSON.parse(
      decoder.decode(
        await openBox(
          NODE_ENCRYPTION_PRIVATE_KEY,
          ack.uploads_sealed!,
          "wal-upload",
          walUploadAad(nodeId, ack.stream_id),
        ),
      ),
    ),
  ).uploads;
}

async function openFiles(nodeId: string, frame: WalFetch) {
  return SealedWalFilesSchema.parse(
    JSON.parse(
      decoder.decode(
        await openBox(
          NODE_ENCRYPTION_PRIVATE_KEY,
          frame.files_sealed,
          "wal-fetch",
          walFetchAad(nodeId, frame.restore_id),
        ),
      ),
    ),
  ).files;
}

/** Test-only WAL bytes; distinct per name so a mixed-up fetch shows. */
const walBytes = (name: string) => new TextEncoder().encode(`wal-fixture:${name}`.padEnd(256, "."));

/**
 * Plays the agent's whole archive round for `files`: asks for URLs, uploads
 * each file, reports it archived at the given time, and waits for the ack.
 */
async function archive(
  s: DatabaseStage,
  streamId: string,
  files: { name: string; at: number }[],
): Promise<WalArchiveAck> {
  const agent = s.home.agent;
  let since = agent.received.length;
  agent.send({
    type: "wal_archive",
    volume_id: s.volumeId,
    stream_id: streamId,
    archived: [],
    pending: files.map((f) => f.name),
  } satisfies WalArchive);
  const offer = await nextFrame(agent, "wal_archive_ack", since);
  const uploads = await openUploads(s.home.joined.node_id, offer);
  const archived = [];
  for (const f of files) {
    const bytes = walBytes(f.name);
    const put = await s.fake.put(uploads.find((u) => u.name === f.name)!.url, bytes);
    expect(put.ok).toBe(true);
    archived.push({
      name: f.name,
      size_raw: SEGMENT_BYTES,
      size_stored: bytes.byteLength,
      sha256: await sha256Hex(bytes),
      archived_at: f.at,
    });
  }
  since = agent.received.length;
  agent.send({
    type: "wal_archive",
    volume_id: s.volumeId,
    stream_id: streamId,
    archived,
    pending: [],
  } satisfies WalArchive);
  return nextFrame(agent, "wal_archive_ack", since, (m) => m.acked.length === files.length);
}

/**
 * Turns PITR on and waits for the stream's first base backup, which it
 * then backdates to `finishedAt` so archived WAL can lie in the past.
 */
async function archivingStage(nodes = 1, finishedAt = Date.now() - 3 * 3600_000) {
  const s = await pitrStage(nodes);
  expect((await setPitr(s, true)).status).toBe(200);
  const [stream] = await streams(s.serviceId);
  const base = await firstBase(s, stream!.id);
  expect(base.status).toBe("succeeded");
  await env.DB.prepare("UPDATE backups SET finished_at = ?, created_at = ? WHERE id = ?")
    .bind(finishedAt, finishedAt - MIN, base.id)
    .run();
  return { s, stream: stream!, baseId: base.id, t0: finishedAt };
}

const restoreUrl = (s: DatabaseStage) => `/v1/services/${s.serviceId}/pitr/restore`;

const restoreBody = (s: DatabaseStage, target: number, extra: Record<string, unknown> = {}) => ({
  environment_id: s.envId,
  target_time: target,
  mode: "in_place",
  confirm: s.serviceSlug,
  skip_safety_backup: true,
  ...extra,
});

/** Captures what a frame handler replies, for direct handler calls. */
function frameContext(nodeId: string) {
  const replies: (WalArchiveAckBody | WalFetchBody)[] = [];
  const ctx: PitrFrameContext = {
    db: createDb(env.DB),
    env,
    nodeId,
    reply: async (frame) => {
      replies.push(frame);
    },
  };
  return { ctx, replies };
}

const other = (s: DatabaseStage): StageNode => s.nodes.find((n) => n !== s.home)!;

// -----------------------------------------------------------------------------
// Turning it on and off
// -----------------------------------------------------------------------------

describe("turning point-in-time recovery on and off", () => {
  it("archives through the desired state, restarting the database once each way", async () => {
    const s = await pitrStage();
    const before = await nextFrame(s.home.agent, "desired_state", 0, (m) =>
      m.workloads.some((w) => w.service_id === s.serviceId),
    );
    const plain = workloadOf(s, before);
    expect(plain.command).toBeUndefined();
    expect(await status(s)).toMatchObject({ enabled: false, stream: null, windows: [] });

    const since = s.home.agent.received.length;
    const on = await setPitr(s, true);
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ pitr: true, method: "base" });
    const [stream] = await streams(s.serviceId);
    expect(stream).toMatchObject({ volume_id: s.volumeId, status: "active" });

    const archiving = await desiredFor(s, since, (v) => v.wal_archive?.stream_id === stream!.id);
    const volume = archiving.volumes!.find((v) => v.id === s.volumeId)!;
    expect(volume.wal_archive!.age_recipient).toMatch(/^age1/);
    const restarted = workloadOf(s, archiving);
    expect(restarted.id).toBe(plain.id);
    expect(restarted.spec_hash).not.toBe(plain.spec_hash);
    expect(restarted.command?.[0]).toBe("postgres");
    expect(restarted.command).toContain("archive_mode=on");
    expect(restarted.command?.join(" ")).toMatch(/archive_command=.*roundhouse-wal/);

    // The first base backup is asked for at once, on the new stream.
    const base = await firstBase(s, stream!.id);
    expect(base).toMatchObject({ status: "succeeded", method: "base" });
    const job = s.home.agent.received.find(
      (m) => m.type === "backup_job" && m.backup_id === base.id,
    );
    expect(job).toMatchObject({ method: "base" });
    expect(await status(s)).toMatchObject({
      enabled: true,
      unavailable_reason: null,
      stream: { id: stream!.id, status: "active", segment_count: 0 },
      base_backups: 1,
    });
    const [updated] = (await auditRows("backup.policy_updated")).slice(-1);
    expect(updated!.metadata).toMatchObject({ pitr: true });

    const offSince = s.home.agent.received.length;
    const off = await setPitr(s, false);
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ pitr: false, method: "dump" });
    const stopped = await desiredFor(s, offSince, (v) => v.wal_archive === undefined);
    expect(workloadOf(s, stopped).command).toBeUndefined();
    expect(workloadOf(s, stopped).spec_hash).not.toBe(restarted.spec_hash);
    // Retired, not deleted: its base backup and WAL still restore.
    expect(await streams(s.serviceId)).toEqual([expect.objectContaining({ status: "retired" })]);
    expect((await status(s)).stream).toBeNull();
    // The tick starts nothing while it is off.
    expect(await claimPitrStreams(env, Date.now())).toBe(0);
  }, 180_000);

  it("refuses an agent without WAL archiving, and a policy without scheduled backups", async () => {
    const s = await databaseStage();
    const old = await setPitr(s, true);
    expect(old.status).toBe(409);
    expect(old.body.error?.message).toMatch(/without WAL archiving/);
    expect((await status(s)).unavailable_reason).toMatch(/upgrade it/);
    const unscheduled = await s.owner.json<ErrorBody>(`/v1/services/${s.serviceId}/backup-policy`, {
      method: "PUT",
      json: { environment_id: s.envId, enabled: false, pitr: true },
    });
    expect(unscheduled.status).toBe(422);
    expect(await streams(s.serviceId)).toEqual([]);
  }, 120_000);
});

// -----------------------------------------------------------------------------
// Node frames
// -----------------------------------------------------------------------------

describe("wal_archive", () => {
  it("hands out sealed, short-lived upload URLs and acks what was recorded", async () => {
    const { s, stream } = await archivingStage();
    const nodeId = s.home.joined.node_id;
    const since = s.home.agent.received.length;
    s.home.agent.send({
      type: "wal_archive",
      volume_id: s.volumeId,
      stream_id: stream.id,
      archived: [],
      pending: [seg(2), "00000002.history"],
    } satisfies WalArchive);
    const offer = await nextFrame(s.home.agent, "wal_archive_ack", since);
    expect(offer.exp - offer.iat).toBeLessThanOrEqual(CREDENTIAL_FRAME_TTL_MS);
    expect(offer.acked).toEqual([]);
    // SECURITY: the URLs only open for this node and this stream.
    await expect(
      openBox(
        NODE_ENCRYPTION_PRIVATE_KEY,
        offer.uploads_sealed!,
        "wal-upload",
        walUploadAad(nodeId, "wal_other"),
      ),
    ).rejects.toThrow();
    await expect(
      openBox(
        NODE_ENCRYPTION_PRIVATE_KEY,
        offer.uploads_sealed!,
        "wal-fetch",
        walUploadAad(nodeId, stream.id),
      ),
    ).rejects.toThrow();
    const uploads = await openUploads(nodeId, offer);
    expect(uploads.map((u) => u.name)).toEqual([seg(2), "00000002.history"]);
    for (const u of uploads) {
      const url = new URL(u.url);
      expect(decodeURIComponent(url.pathname)).toContain(`/${stream.id}/${u.name}.zst.age`);
      expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    }
    expect(JSON.stringify(offer)).not.toContain("X-Amz-Signature");

    const at = Date.now() - 30 * MIN;
    const ack = await archive(s, stream.id, [{ name: seg(2), at }]);
    expect(ack.acked).toEqual([seg(2)]);
    expect(ack.uploads_sealed).toBeUndefined();
    const key = walObjectKey({
      projectId: s.project.id,
      serviceId: s.serviceId,
      environmentId: s.envId,
      streamId: stream.id,
      name: seg(2),
    });
    expect(s.fake.objects.get(key)).toEqual(walBytes(seg(2)));
    expect((await status(s)).stream).toMatchObject({
      segment_count: 1,
      bytes_stored: walBytes(seg(2)).byteLength,
    });

    // A resend after a lost ack is acked again and recorded once.
    const again = await archive(s, stream.id, [{ name: seg(2), at }]);
    expect(again.acked).toEqual([seg(2)]);
    expect((await status(s)).stream!.segment_count).toBe(1);
  }, 180_000);

  it("ignores foreign and unknown streams, and gives a retired stream no URLs", async () => {
    const { s, stream } = await archivingStage(2);
    const intruder = other(s).joined.node_id;
    const report = (streamId: string, volumeId = s.volumeId): WalArchive => ({
      type: "wal_archive",
      volume_id: volumeId,
      stream_id: streamId,
      archived: [
        {
          name: seg(9),
          size_raw: SEGMENT_BYTES,
          size_stored: 100,
          sha256: "b".repeat(64),
          archived_at: Date.now(),
        },
      ],
      pending: [seg(10)],
    });
    const foreign = frameContext(intruder);
    // SECURITY: another node can neither record WAL nor get URLs for a stream.
    await onWalArchive(foreign.ctx, report(stream.id));
    const unknown = frameContext(s.home.joined.node_id);
    await onWalArchive(unknown.ctx, report("wal_missing"));
    // The right stream ID with another volume is just as unknown.
    await onWalArchive(unknown.ctx, report(stream.id, "vol_elsewhere"));
    expect(foreign.replies).toEqual([]);
    expect(unknown.replies).toEqual([]);
    expect((await status(s)).stream!.segment_count).toBe(0);

    expect((await setPitr(s, false)).status).toBe(200);
    const late = frameContext(s.home.joined.node_id);
    await onWalArchive(late.ctx, report(stream.id));
    // Late reports of a retired stream still count; no new uploads start.
    expect(late.replies).toEqual([
      { type: "wal_archive_ack", volume_id: s.volumeId, stream_id: stream.id, acked: [seg(9)] },
    ]);
    const row = await env.DB.prepare("SELECT segment_count FROM wal_streams WHERE id = ?")
      .bind(stream.id)
      .first<{ segment_count: number }>();
    expect(row!.segment_count).toBe(1);
  }, 180_000);
});

// -----------------------------------------------------------------------------
// Windows and restores
// -----------------------------------------------------------------------------

describe("restorable windows", () => {
  it("run from a base backup to the last gapless segment, merged across bases", async () => {
    const { s, stream, t0 } = await archivingStage();
    expect((await status(s)).windows).toEqual([]);
    // 0…05 skips 04: the window stops at 03.
    await archive(s, stream.id, [
      { name: seg(2), at: t0 + 10 * MIN },
      { name: seg(3), at: t0 + 20 * MIN },
      { name: seg(5), at: t0 + 40 * MIN },
    ]);
    expect((await status(s)).windows).toEqual([{ from: t0, to: t0 + 20 * MIN }]);

    // A later base starting at 05 opens a second window after the gap.
    const later = t0 + 50 * MIN;
    await env.DB.prepare(
      `INSERT INTO backups (id, project_id, service_id, environment_id, volume_id, trigger, method,
         engine, status, object_key, sha256, bytes_stored, wal_stream_id, wal_start, finished_at,
         created_at, updated_at)
       VALUES ('bak_later', ?, ?, ?, ?, 'schedule', 'base', 'postgres', 'succeeded', 'k/later', ?, 10,
         ?, ?, ?, ?, ?)`,
    )
      .bind(
        s.project.id,
        s.serviceId,
        s.envId,
        s.volumeId,
        "c".repeat(64),
        stream.id,
        seg(5),
        later,
        later,
        later,
      )
      .run();
    await archive(s, stream.id, [
      { name: seg(6), at: t0 + 60 * MIN },
      { name: seg(7), at: t0 + 70 * MIN },
    ]);
    expect((await status(s)).windows).toEqual([
      { from: t0, to: t0 + 20 * MIN },
      { from: later, to: t0 + 70 * MIN },
    ]);
    // The missing segment arrives late: everything joins into one window.
    await archive(s, stream.id, [{ name: seg(4), at: t0 + 30 * MIN }]);
    expect((await status(s)).windows).toEqual([{ from: t0, to: t0 + 70 * MIN }]);
    expect((await status(s)).base_backups).toBe(2);
  }, 180_000);
});

describe("POST /v1/services/{id}/pitr/restore", () => {
  it("replays fetched WAL to the target, then starts a new stream", async () => {
    const { s, stream, baseId, t0 } = await archivingStage();
    await archive(s, stream.id, [
      { name: seg(2), at: t0 + 10 * MIN },
      { name: seg(3), at: t0 + 20 * MIN },
      { name: seg(4), at: t0 + 30 * MIN },
    ]);
    s.home.agent.behaviour.restore = "silent";
    const target = t0 + 15 * MIN;
    const started = await s.owner.json<RestoreBody>(restoreUrl(s), {
      method: "POST",
      json: restoreBody(s, target),
    });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({
      backup_id: baseId,
      mode: "in_place",
      target_time: target,
    });

    const job = await s.home.agent.waitFor(
      (m): m is RestoreJob => m.type === "restore_job" && m.restore_id === started.body.id,
      30_000,
    );
    // Through 03, the first segment finished after the target.
    expect(job).toMatchObject({
      method: "base",
      backup_id: baseId,
      pitr: { target_time: target, wal_files: 2, wal_end: seg(3) },
    });
    const [audited] = await auditRows("restore.started");
    expect(audited).toMatchObject({ actor_type: "user", target_id: started.body.id });
    expect(audited!.metadata).toMatchObject({
      mode: "in_place",
      service_id: s.serviceId,
      target_time: target,
      backup_id: baseId,
    });

    const since = s.home.agent.received.length;
    s.home.agent.send({
      type: "wal_fetch_request",
      restore_id: job.restore_id,
      from: 0,
      count: 32,
    });
    const fetched = await nextFrame(s.home.agent, "wal_fetch", since);
    expect(fetched.exp - fetched.iat).toBeLessThanOrEqual(CREDENTIAL_FRAME_TTL_MS);
    expect(JSON.stringify(fetched)).not.toContain("X-Amz-Signature");
    const files = await openFiles(s.home.joined.node_id, fetched);
    expect(files.map((f) => [f.index, f.name])).toEqual([
      [0, seg(2)],
      [1, seg(3)],
    ]);
    for (const f of files) {
      const got = await s.fake.fetch(new Request(f.url));
      const bytes = new Uint8Array(await got.arrayBuffer());
      expect(bytes).toEqual(walBytes(f.name));
      expect(f.sha256).toBe(await sha256Hex(bytes));
      expect(new URL(f.url).searchParams.get("X-Amz-Expires")).toBe("3600");
    }
    await expect(
      openBox(
        NODE_ENCRYPTION_PRIVATE_KEY,
        fetched.files_sealed,
        "wal-fetch",
        walFetchAad(s.home.joined.node_id, "rst_other"),
      ),
    ).rejects.toThrow();

    // Past the end, or from another node, or for an unknown restore: no answer.
    const tail = frameContext(s.home.joined.node_id);
    await onWalFetchRequest(tail.ctx, {
      type: "wal_fetch_request",
      restore_id: job.restore_id,
      from: 2,
      count: 32,
    });
    await onWalFetchRequest(tail.ctx, {
      type: "wal_fetch_request",
      restore_id: "rst_missing",
      from: 0,
      count: 1,
    });
    const foreign = frameContext("node_elsewhere");
    await onWalFetchRequest(foreign.ctx, {
      type: "wal_fetch_request",
      restore_id: job.restore_id,
      from: 0,
      count: 32,
    });
    expect(tail.replies).toEqual([]);
    expect(foreign.replies).toEqual([]);

    const restartSince = s.home.agent.received.length;
    s.home.agent.send({
      type: "restore_result",
      restore_id: job.restore_id,
      ok: true,
      bytes: 1024,
      duration_ms: 5,
    });
    const done = await waitForState(
      async () => (await s.owner.json<RestoreBody>(`/v1/restores/${job.restore_id}`)).body,
      ["succeeded", "failed"],
      60_000,
    );
    expect(done.status).toBe("succeeded");

    // The restored data has another history: a new stream for the same volume.
    const after = await eventually(async () => {
      const rows = await streams(s.serviceId);
      return rows.length === 2 ? rows : undefined;
    }, 10_000);
    expect(after).toEqual([
      expect.objectContaining({ id: stream.id, status: "retired" }),
      expect.objectContaining({ volume_id: s.volumeId, status: "active" }),
    ]);
    const fresh = after[1]!.id;
    await desiredFor(s, restartSince, (v) => v.wal_archive?.stream_id === fresh);
    // Its first base backup follows on the tick; the old window still restores.
    expect(await claimPitrStreams(env, Date.now())).toBe(1);
    expect((await firstBase(s, fresh)).status).toBe("succeeded");
    expect((await status(s)).windows).toEqual([{ from: t0, to: t0 + 30 * MIN }]);
  }, 240_000);

  it("refuses times nothing covers, future times, and a wrong slug or stale session", async () => {
    const { s, stream, t0 } = await archivingStage();
    const none = await s.owner.json<ErrorBody>(restoreUrl(s), {
      method: "POST",
      json: restoreBody(s, t0 + 5 * MIN),
    });
    expect(none.status).toBe(422);
    expect(none.body.error).toMatchObject({ code: "pitr_target_unavailable" });
    expect(none.body.error.message).toMatch(/Nothing is restorable/);

    await archive(s, stream.id, [
      { name: seg(2), at: t0 + 10 * MIN },
      { name: seg(3), at: t0 + 20 * MIN },
    ]);
    for (const target of [t0 - MIN, t0 + 20 * MIN, t0 + 25 * MIN]) {
      const res = await s.owner.json<ErrorBody>(restoreUrl(s), {
        method: "POST",
        json: restoreBody(s, target),
      });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe("pitr_target_unavailable");
      expect(res.body.error.message).toContain(new Date(t0).toISOString());
    }
    const future = await s.owner.json<ErrorBody>(restoreUrl(s), {
      method: "POST",
      json: restoreBody(s, Date.now() + 10 * MIN),
    });
    expect(future.status).toBe(400);
    expect(future.body.error.message).toMatch(/future/);
    const slug = await s.owner.json<ErrorBody>(restoreUrl(s), {
      method: "POST",
      json: restoreBody(s, t0 + 15 * MIN, { confirm: `${s.serviceSlug}-x` }),
    });
    expect(slug.status).toBe(400);
    expect(slug.body.error.message).toMatch(/slug/);

    await env.DB.prepare(
      "UPDATE sessions SET created_at = ?, reauthenticated_at = NULL WHERE user_id = ?",
    )
      .bind(Date.now() - 3600_000, s.installed.userId)
      .run();
    const stale = await s.owner.json<ErrorBody>(restoreUrl(s), {
      method: "POST",
      json: restoreBody(s, t0 + 15 * MIN),
    });
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe("reauth_required");
    expect(await auditRows("restore.started")).toEqual([]);
    const { results } = await env.DB.prepare("SELECT id FROM restores").all();
    expect(results).toEqual([]);
  }, 180_000);

  it("needs backups:restore in the service's own workspace", async () => {
    const { s, stream, t0 } = await archivingStage();
    await archive(s, stream.id, [{ name: seg(2), at: t0 + 10 * MIN }]);
    const body = restoreBody(s, t0 + 5 * MIN);
    const viewer = await addMember(s.owner, s.workspaceId, "viewer@example.com", "viewer");
    // Members are developers; production is protected for new projects.
    const developer = await addMember(s.owner, s.workspaceId, "dev@example.com", "member");
    const protection = await s.owner.json<{ protected: boolean }>(
      `/v1/environments/${s.envId}/protection`,
    );
    expect(protection.body.protected).toBe(true);
    for (const c of [viewer, developer]) {
      const res = await c.json<ErrorBody>(restoreUrl(s), { method: "POST", json: body });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("forbidden");
      // Reading the window is fine.
      const read = await c.json(`/v1/services/${s.serviceId}/pitr?environment_id=${s.envId}`);
      expect(read.status).toBe(200);
    }

    const elsewhere = await s.owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Elsewhere" },
    });
    const outsider = await addMember(s.owner, elsewhere.body.id, "out@example.com", "admin");
    const hidden = await outsider.json<ErrorBody>(restoreUrl(s), { method: "POST", json: body });
    expect(hidden.status).toBe(404);
    const unseen = await outsider.json(
      `/v1/services/${s.serviceId}/pitr?environment_id=${s.envId}`,
    );
    expect(unseen.status).toBe(404);
    expect(await auditRows("restore.started")).toEqual([]);
  }, 180_000);
});

// -----------------------------------------------------------------------------
// Retention
// -----------------------------------------------------------------------------

describe("WAL retention", () => {
  /** A stream with base backups and segments, its objects in the fake bucket. */
  async function retentionStage(
    bases: { id: string; walStart: string | null; status: string; at: number }[],
  ) {
    const s = await backupStage({ agent: false });
    const policy = await s.owner.json<{ id: string }>(`/v1/services/${s.serviceId}/backup-policy`, {
      method: "PUT",
      json: { environment_id: s.envId, enabled: true, keep_last: 1 },
    });
    expect(policy.status).toBe(200);
    const streamId = "wal_retention";
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO wal_streams (id, project_id, service_id, environment_id, volume_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
      .bind(streamId, s.project.id, s.serviceId, s.envId, s.volumeId, now, now)
      .run();
    for (const b of bases) {
      await env.DB.prepare(
        `INSERT INTO backups (id, project_id, service_id, environment_id, volume_id, policy_id, trigger,
           method, engine, status, object_key, sha256, bytes_stored, wal_stream_id, wal_start,
           finished_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'schedule', 'base', 'postgres', ?, ?, ?, 10, ?, ?, ?, ?, ?)`,
      )
        .bind(
          b.id,
          s.project.id,
          s.serviceId,
          s.envId,
          s.volumeId,
          policy.body.id,
          b.status,
          `backups/${b.id}`,
          b.status === "succeeded" ? "d".repeat(64) : null,
          streamId,
          b.walStart,
          b.status === "succeeded" ? b.at : null,
          b.at,
          b.at,
        )
        .run();
      s.fake.objects.set(`backups/${b.id}`, new Uint8Array(10));
    }
    const names = ["00000001.history", ...[2, 3, 4, 5, 6, 7].map((n) => seg(n))];
    for (const name of names) {
      await env.DB.prepare(
        `INSERT INTO wal_segments (stream_id, name, size_raw, size_stored, sha256, archived_at, created_at)
         VALUES (?, ?, ?, 10, ?, ?, ?)`,
      )
        .bind(streamId, name, SEGMENT_BYTES, "e".repeat(64), now, now)
        .run();
      s.fake.objects.set(objectKey(s, streamId, name), walBytes(name));
    }
    return { s, streamId, names };
  }

  const objectKey = (
    s: { project: { id: string }; serviceId: string; envId: string },
    streamId: string,
    name: string,
  ) =>
    walObjectKey({
      projectId: s.project.id,
      serviceId: s.serviceId,
      environmentId: s.envId,
      streamId,
      name,
    });

  async function segmentNames(streamId: string) {
    const { results } = await env.DB.prepare(
      "SELECT name FROM wal_segments WHERE stream_id = ? ORDER BY name",
    )
      .bind(streamId)
      .all<{ name: string }>();
    return results.map((r) => r.name);
  }

  it("follows backup retention: WAL before the oldest kept base goes, history stays", async () => {
    const now = Date.now();
    const { s, streamId, names } = await retentionStage([
      { id: "bak_old", walStart: seg(3), status: "succeeded", at: now - 2 * 3600_000 },
      { id: "bak_new", walStart: seg(5), status: "succeeded", at: now - 3600_000 },
    ]);
    // Both bases kept for now: only WAL before 03 is unneeded.
    expect(await applyWalRetention(createDb(env.DB), FAKE_S3, now)).toBe(1);
    expect(await segmentNames(streamId)).toEqual(names.filter((n) => n !== seg(2)));
    expect(s.fake.objects.has(objectKey(s, streamId, seg(2)))).toBe(false);

    // keep_last 1 expires the older base; its WAL follows in the same run.
    const report = await runBackupMaintenance(env, now);
    expect(report).toMatchObject({ expired: 1, walExpired: 2 });
    expect(await segmentNames(streamId)).toEqual(["00000001.history", seg(5), seg(6), seg(7)]);
    for (const n of [seg(3), seg(4)]) {
      expect(s.fake.objects.has(objectKey(s, streamId, n))).toBe(false);
    }
    expect(s.fake.objects.has(objectKey(s, streamId, seg(5)))).toBe(true);
    const row = await env.DB.prepare("SELECT segment_count FROM wal_streams WHERE id = ?")
      .bind(streamId)
      .first<{ segment_count: number }>();
    expect(row!.segment_count).toBe(4);
  }, 120_000);

  it("never deletes WAL a kept base needs while another base is still running", async () => {
    const now = Date.now();
    const { streamId, names } = await retentionStage([
      { id: "bak_kept", walStart: seg(4), status: "succeeded", at: now - 3600_000 },
      { id: "bak_running", walStart: null, status: "running", at: now },
    ]);
    expect(await applyWalRetention(createDb(env.DB), FAKE_S3, now)).toBe(2);
    expect(await segmentNames(streamId)).toEqual(names.filter((n) => n !== seg(2) && n !== seg(3)));
  }, 120_000);

  it("keeps an active stream's WAL until its first base lands, and drops a retired one with no base", async () => {
    const now = Date.now();
    const { s, streamId, names } = await retentionStage([
      { id: "bak_first", walStart: null, status: "running", at: now },
    ]);
    expect(await applyWalRetention(createDb(env.DB), FAKE_S3, now)).toBe(0);
    expect(await segmentNames(streamId)).toEqual(names);

    await env.DB.prepare(
      "UPDATE backups SET status = 'failed', error = 'test' WHERE id = 'bak_first'",
    ).run();
    await env.DB.prepare("UPDATE wal_streams SET status = 'retired' WHERE id = ?")
      .bind(streamId)
      .run();
    expect(await applyWalRetention(createDb(env.DB), FAKE_S3, now)).toBe(names.length);
    expect(await segmentNames(streamId)).toEqual([]);
    for (const n of names) expect(s.fake.objects.has(objectKey(s, streamId, n))).toBe(false);
    const row = await env.DB.prepare("SELECT status FROM wal_streams WHERE id = ?")
      .bind(streamId)
      .first<{ status: string }>();
    expect(row!.status).toBe("deleted");
  }, 120_000);
});
