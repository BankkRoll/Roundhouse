/**
 * Web shell recordings (ADR 0012 "Recording", ADR 0014 §15 point 3) outside
 * the relay: where they live, whether a new session is recorded, reading
 * one back for playback, and deleting expired ones.
 *
 * A recording is asciicast v2 (a JSON header line, then `[t, "o"|"i"|"r",
 * text]` event lines), cut into parts of about {@link SHELL_RECORDING_PART_BYTES}
 * raw bytes. Each part repeats the header, is gzipped, encrypted to the
 * project's age recipient (the backup keypair, `./backups/keys`) and stored
 * in the `LOGS` bucket under {@link shellRecordingKey}. The relay writes them
 * (`durable/node/recording.ts`).
 *
 * Responsibilities:
 * - {@link shellRecordingKey}: a part's R2 key;
 * - {@link shellRecordingRecipient}: whether a session opening now is
 *   recorded, and to which recipient;
 * - {@link readShellRecording}: the decrypted parts as one asciicast stream;
 * - {@link pruneShellRecordings}: the hourly retention of recordings.
 *
 * SECURITY: recordings hold keystrokes, output and so secrets. Nothing here
 * logs their contents, and plaintext only exists while a part is being
 * encrypted or played back.
 *
 * @module
 */
import { type Db, shellSessions } from "@roundhouse/db";
import { and, eq, gt, inArray, lt } from "drizzle-orm";
import type { Env } from "../env";
import { ageDecrypt } from "./age-file";
import { ensureBackupRecipient, loadBackupIdentity } from "./backups/keys";
import type { KeyEnv } from "./keyring";
import { getShellRecordingSettings } from "./settings";

/** Raw bytes after which the relay closes a part and starts the next. */
export const SHELL_RECORDING_PART_BYTES = 16 * 1024 * 1024;

/** Sessions whose recordings one retention batch deletes; D1 binds at most 100 values. */
const PRUNE_BATCH = 50;

/** R2's `delete` takes at most 1000 keys. */
const R2_DELETE_KEYS = 1000;

/**
 * The R2 key of one part of a session's recording, dated by the session's
 * start (UTC).
 *
 * @param projectId - The session's project.
 * @param startedAt - When the session started, unix ms.
 * @param sessionId - `shl_…`.
 * @param part - From 1.
 * @returns `shell/<project>/<yyyy>/<mm>/<session>.<part>.cast.gz.age`.
 * @example
 * shellRecordingKey("prj_1", Date.UTC(2026, 9, 27), "shl_1", 1);
 * // "shell/prj_1/2026/10/shl_1.1.cast.gz.age"
 */
export function shellRecordingKey(
  projectId: string,
  startedAt: number,
  sessionId: string,
  part: number,
): string {
  const at = new Date(startedAt);
  const yyyy = String(at.getUTCFullYear()).padStart(4, "0");
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `shell/${projectId}/${yyyy}/${mm}/${sessionId}.${part}.cast.gz.age`;
}

/**
 * Decides whether a session opening now is recorded: only with
 * `shell_recording = full`, and only to the project's age recipient, which
 * is created on first use as for a first backup. When the project's key
 * can't be had, the session opens unrecorded (logged, without data).
 *
 * @param env - The keyring bindings.
 * @param db - Database client.
 * @param projectId - The session's project.
 * @returns `age1…` to encrypt to, or `null` for metadata only.
 */
export async function shellRecordingRecipient(
  env: KeyEnv,
  db: Db,
  projectId: string,
): Promise<string | null> {
  const { mode } = await getShellRecordingSettings(db);
  if (mode !== "full") return null;
  try {
    return await ensureBackupRecipient(db, env, projectId);
  } catch (err) {
    console.warn(
      "shell recording off for this session: the project has no age key",
      err instanceof Error ? err.name : "error",
    );
    return null;
  }
}

/** The stored parts of a session, as {@link readShellRecording} needs them. */
export interface StoredShellRecording {
  id: string;
  projectId: string;
  startedAt: Date;
  recordingParts: number;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Reads a session's recording back as one asciicast stream: the first
 * part whole, then every later part without its repeated header. The first
 * part is decrypted before this returns, so a missing object or a wrong key
 * is an error here rather than a broken stream; later parts are decrypted
 * as the stream is read, one at a time.
 *
 * @param env - `LOGS` and the keyring.
 * @param db - Database client.
 * @param session - The session row; `recordingParts` ≥ 1.
 * @returns The asciicast as a UTF-8 byte stream.
 * @throws {Error} When a part is missing or doesn't decrypt.
 */
export async function readShellRecording(
  env: Pick<Env, "LOGS"> & KeyEnv,
  db: Db,
  session: StoredShellRecording,
): Promise<ReadableStream<Uint8Array>> {
  const identity = await loadBackupIdentity(db, env, session.projectId);
  if (!identity) throw new Error("the project has no age identity");
  const readPart = async (part: number): Promise<Uint8Array> => {
    const key = shellRecordingKey(session.projectId, +session.startedAt, session.id, part);
    const object = await env.LOGS.get(key);
    if (!object) throw new Error(`recording part ${part} is missing`);
    const plain = await gunzip(
      await ageDecrypt(identity, new Uint8Array(await object.arrayBuffer())),
    );
    if (part === 1) return plain;
    const headerEnd = plain.indexOf(0x0a);
    return headerEnd < 0 ? new Uint8Array(0) : plain.subarray(headerEnd + 1);
  };
  const first = await readPart(1);
  let next = 2;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first);
    },
    async pull(controller) {
      if (next > session.recordingParts) {
        controller.close();
        return;
      }
      controller.enqueue(await readPart(next++));
    },
  });
}

/**
 * Deletes the recordings of sessions that ended before `cutoff`: the R2
 * objects first, then the row's recording columns (the row itself stays, it
 * is audit metadata). A failed R2 delete leaves the row for the next run.
 *
 * @param db - Database client.
 * @param bucket - The `LOGS` bucket.
 * @param cutoff - Sessions that ended before this lose their recording.
 * @param maxBatches - Batches per run.
 * @returns Sessions whose recording was deleted.
 */
export async function pruneShellRecordings(
  db: Db,
  bucket: R2Bucket,
  cutoff: Date,
  maxBatches: number,
): Promise<number> {
  let pruned = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const rows = await db
      .select({
        id: shellSessions.id,
        projectId: shellSessions.projectId,
        startedAt: shellSessions.startedAt,
        parts: shellSessions.recordingParts,
      })
      .from(shellSessions)
      .where(and(gt(shellSessions.recordingParts, 0), lt(shellSessions.endedAt, cutoff)))
      .orderBy(shellSessions.endedAt)
      .limit(PRUNE_BATCH);
    if (!rows.length) break;
    const keys = rows.flatMap((r) =>
      Array.from({ length: r.parts }, (_, i) =>
        shellRecordingKey(r.projectId, +r.startedAt, r.id, i + 1),
      ),
    );
    for (let i = 0; i < keys.length; i += R2_DELETE_KEYS) {
      await bucket.delete(keys.slice(i, i + R2_DELETE_KEYS));
    }
    await db
      .update(shellSessions)
      .set({ recording: "none", recordingParts: 0, recordingBytes: 0 })
      .where(
        inArray(
          shellSessions.id,
          rows.map((r) => r.id),
        ),
      );
    pruned += rows.length;
    if (rows.length < PRUNE_BATCH) break;
  }
  return pruned;
}

/**
 * Marks a session's recording state, for the relay.
 *
 * @param db - Database client.
 * @param sessionId - `shl_…`.
 * @param state - `stored`, `failed`, or `none` when recording never started.
 */
export async function setShellRecordingState(
  db: Db,
  sessionId: string,
  state: "stored" | "failed" | "none",
): Promise<void> {
  await db.update(shellSessions).set({ recording: state }).where(eq(shellSessions.id, sessionId));
}
