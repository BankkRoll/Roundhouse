/**
 * Recording web shell sessions inside a node's `NodeConnection` (ADR 0012
 * "Recording"), for the relay in `./shell.ts`.
 *
 * Responsibilities:
 * - turning a session's output, input and resizes into asciicast v2 event
 *   lines (`[t, "o"|"i"|"r", text]`, `t` in seconds since the session opened,
 *   text decoded as UTF-8 with one streaming decoder per direction so a
 *   character split across frames survives);
 * - keeping them in the Durable Object's transactional storage, never only
 *   in memory: lines collect in a small in-memory buffer that is written as
 *   chunks (each value at most {@link RECORDING_VALUE_BYTES}) every
 *   {@link RecordingLimits.flushBytes} bytes and at least every
 *   {@link RecordingLimits.flushMs}, so an evicted object loses at most that
 *   much;
 * - closing a part once it holds {@link RecordingLimits.partBytes} raw bytes
 *   and at the session's end: header and lines, gzip, age-encrypted to the
 *   project's recipient, written to R2 at `shellRecordingKey`, then its
 *   chunks deleted and the row's part count bumped;
 * - finishing recordings whose session was lost to an eviction or restart
 *   ({@link ShellRecorder.sweep}).
 *
 * Storage layout: `recmeta:<session>` holds what a part needs to be stored
 * ({@link RecordingMeta}); `rec:<session>:<part>:<seq>` holds the chunks, in
 * order.
 *
 * A failure to store never breaks the session and never leaves plaintext
 * behind: the recording stops, its chunks are deleted, and the row says
 * `failed`.
 *
 * SECURITY: recordings hold keystrokes and output, and so secrets. They are
 * never logged or audited; plaintext lives only in this object's storage
 * until it is encrypted, and is deleted right after.
 *
 * @module
 */
import { type Db, shellSessions } from "@roundhouse/db";
import { eq, sql } from "drizzle-orm";
import { ageEncrypt } from "../../lib/age-file";
import {
  SHELL_RECORDING_PART_BYTES,
  setShellRecordingState,
  shellRecordingKey,
} from "../../lib/shell-recording";

/** Largest storage value a chunk takes; Durable Object values are capped at 128 KiB. */
export const RECORDING_VALUE_BYTES = 64 * 1024;

/** Keys one storage `delete` takes. */
const DELETE_KEYS = 128;

const META_PREFIX = "recmeta:";
const CHUNK_PREFIX = "rec:";

/** When the recorder writes and cuts; tests lower them. */
export interface RecordingLimits {
  /** Raw bytes after which a part is closed and stored. */
  partBytes: number;
  /** Buffered bytes that trigger a write to storage. */
  flushBytes: number;
  /** Longest a line waits in memory, ms. */
  flushMs: number;
}

/** The limits in production. */
export const RECORDING_LIMITS: RecordingLimits = {
  partBytes: SHELL_RECORDING_PART_BYTES,
  flushBytes: RECORDING_VALUE_BYTES,
  flushMs: 2_000,
};

/** What storing a part needs, kept in storage so a lost session can still be stored. */
export interface RecordingMeta {
  session_id: string;
  project_id: string;
  /** `age1…`, the project's recipient. */
  recipient: string;
  /** The session's start, unix ms, which dates its R2 keys. */
  started_at: number;
  /** The asciicast header line, without its newline. */
  header: string;
}

/**
 * A recorded session's position, kept in its socket's attachment so it
 * survives hibernation.
 */
export interface RecordingState {
  /** Unix ms of event time 0. */
  t0: number;
  /** The part being written, from 1. */
  part: number;
  /** The next chunk's sequence number in that part. */
  seq: number;
  /** Raw bytes written to that part so far. */
  bytes: number;
  /** Storing failed; nothing more is recorded. */
  failed: boolean;
}

/** What the recorder needs from the relay. */
export interface RecorderHost {
  ctx: DurableObjectState;
  db: Db;
  bucket: R2Bucket;
}

/** How the recorder reads and writes a session's {@link RecordingState}. */
export interface RecordingSlot {
  get(): RecordingState | null;
  set(state: RecordingState): void;
}

interface Buffer {
  lines: string[];
  bytes: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  output: TextDecoder;
  input: TextDecoder;
}

const encoder = new TextEncoder();

function metaKey(sessionId: string): string {
  return `${META_PREFIX}${sessionId}`;
}

function partPrefix(sessionId: string, part: number): string {
  return `${CHUNK_PREFIX}${sessionId}:${String(part).padStart(4, "0")}:`;
}

function chunkKey(sessionId: string, part: number, seq: number): string {
  return `${partPrefix(sessionId, part)}${String(seq).padStart(8, "0")}`;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The recorder of one node's shell sessions. */
export class ShellRecorder {
  private buffers = new Map<string, Buffer>();
  /**
   * Per session, so its parts are stored one after the other. Each link
   * resolves to whether the recording is still intact; it never rejects.
   */
  private chains = new Map<string, Promise<boolean>>();
  /** Sessions being finished here, which {@link sweep} leaves alone. */
  private finishing = new Set<string>();

  constructor(
    private readonly host: RecorderHost,
    /** Mutable so tests can shrink parts and flushes. */
    readonly limits: RecordingLimits = { ...RECORDING_LIMITS },
  ) {}

  /**
   * Starts recording a session: stores its {@link RecordingMeta}.
   *
   * @param meta - The session's project, recipient, start and size.
   * @param now - Event time 0, unix ms.
   * @returns The state to keep in the socket's attachment.
   */
  async start(
    meta: Omit<RecordingMeta, "header"> & { cols: number; rows: number; term: string },
    now: number,
  ): Promise<RecordingState> {
    const header = JSON.stringify({
      version: 2,
      width: meta.cols,
      height: meta.rows,
      timestamp: Math.floor(now / 1000),
      env: { TERM: meta.term },
    });
    const stored: RecordingMeta = {
      session_id: meta.session_id,
      project_id: meta.project_id,
      recipient: meta.recipient,
      started_at: meta.started_at,
      header,
    };
    await this.host.ctx.storage.put(metaKey(meta.session_id), stored);
    return { t0: now, part: 1, seq: 0, bytes: 0, failed: false };
  }

  /**
   * Records output or input bytes. Synchronous: the line is buffered now and
   * written to storage by the next flush.
   *
   * @param sessionId - `shl_…`.
   * @param slot - The session's recording state.
   * @param kind - `o` for output, `i` for input.
   * @param bytes - The raw bytes.
   * @param now - Unix ms.
   */
  recordBytes(
    sessionId: string,
    slot: RecordingSlot,
    kind: "o" | "i",
    bytes: Uint8Array,
    now = Date.now(),
  ): void {
    const state = slot.get();
    if (!state || state.failed) return;
    const buffer = this.buffer(sessionId);
    const text = (kind === "o" ? buffer.output : buffer.input).decode(bytes, { stream: true });
    if (text) this.push(sessionId, slot, state, kind, text, now);
  }

  /**
   * Records a resize.
   *
   * @param sessionId - `shl_…`.
   * @param slot - The session's recording state.
   * @param cols - New width.
   * @param rows - New height.
   * @param now - Unix ms.
   */
  recordResize(
    sessionId: string,
    slot: RecordingSlot,
    cols: number,
    rows: number,
    now = Date.now(),
  ): void {
    const state = slot.get();
    if (!state || state.failed) return;
    this.push(sessionId, slot, state, "r", `${cols}x${rows}`, now);
  }

  /**
   * Stores what is left of a session's recording and marks the row
   * `stored` (or `failed`). Never throws.
   *
   * @param sessionId - `shl_…`.
   * @param slot - The session's recording state.
   */
  async finish(sessionId: string, slot: RecordingSlot): Promise<void> {
    this.finishing.add(sessionId);
    try {
      if (!slot.get()) return;
      const buffer = this.buffers.get(sessionId);
      const before = slot.get();
      const tail = buffer?.output.decode() ?? "";
      if (tail && before && !before.failed) {
        this.push(sessionId, slot, before, "o", tail, Date.now());
      }
      await this.flush(sessionId, slot);
      this.buffers.delete(sessionId);
      const state = slot.get();
      if (!state || state.failed) return;
      // A part cut exactly at the end has nothing left to store.
      const intact =
        state.seq > 0 || state.part === 1
          ? await this.enqueue(sessionId, slot, () => this.storePart(sessionId, state.part))
          : await (this.chains.get(sessionId) ?? true);
      if (!intact) return;
      await this.host.ctx.storage.delete(metaKey(sessionId));
      await setShellRecordingState(this.host.db, sessionId, "stored");
    } catch (err) {
      await this.fail(sessionId, slot, err);
    } finally {
      this.chains.delete(sessionId);
      this.finishing.delete(sessionId);
    }
  }

  /**
   * Keeps {@link sweep} away from a session that is ending, until
   * {@link finish} is done with it.
   *
   * @param sessionId - `shl_…`.
   */
  hold(sessionId: string): void {
    this.finishing.add(sessionId);
  }

  /**
   * Gives up on a recording that couldn't start: its meta goes, and the row
   * says `none`. Never throws.
   *
   * @param sessionId - `shl_…`.
   */
  async abandon(sessionId: string): Promise<void> {
    try {
      await this.host.ctx.storage.delete(metaKey(sessionId));
      await setShellRecordingState(this.host.db, sessionId, "none");
    } catch (err) {
      console.error("shell recording abandon failed", err instanceof Error ? err.name : "error");
    }
  }

  /**
   * Stores the recordings of sessions this object no longer runs (it was
   * evicted or restarted while they were open, so their sockets are gone).
   *
   * @param live - Sessions still open here.
   * @returns Recordings finished. Never throws.
   */
  async sweep(live: ReadonlySet<string>): Promise<number> {
    let metas: Map<string, RecordingMeta>;
    try {
      metas = await this.host.ctx.storage.list<RecordingMeta>({ prefix: META_PREFIX });
    } catch (err) {
      console.error("shell recording sweep failed", err instanceof Error ? err.name : "error");
      return 0;
    }
    let done = 0;
    for (const meta of metas.values()) {
      const id = meta.session_id;
      if (live.has(id) || this.finishing.has(id)) continue;
      this.finishing.add(id);
      try {
        const keys = await this.host.ctx.storage.list({ prefix: `${CHUNK_PREFIX}${id}:` });
        const parts = [
          ...new Set(
            [...keys.keys()].map((k) => Number(k.slice(CHUNK_PREFIX.length).split(":")[1])),
          ),
        ].sort((a, b) => a - b);
        if (!parts.length) {
          const [row] = await this.host.db
            .select({ parts: shellSessions.recordingParts })
            .from(shellSessions)
            .where(eq(shellSessions.id, id))
            .limit(1);
          // Nothing reached storage: a header-only recording still says the session ran.
          if (!row?.parts) parts.push(1);
        }
        for (const part of parts) await this.storePart(id, part);
        await this.host.ctx.storage.delete(metaKey(id));
        await setShellRecordingState(this.host.db, id, "stored");
        done++;
      } catch (err) {
        await this.fail(id, null, err);
      } finally {
        this.finishing.delete(id);
      }
    }
    return done;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private buffer(sessionId: string): Buffer {
    let buffer = this.buffers.get(sessionId);
    if (!buffer) {
      buffer = {
        lines: [],
        bytes: 0,
        timer: undefined,
        output: new TextDecoder("utf-8"),
        input: new TextDecoder("utf-8"),
      };
      this.buffers.set(sessionId, buffer);
    }
    return buffer;
  }

  private push(
    sessionId: string,
    slot: RecordingSlot,
    state: RecordingState,
    kind: "o" | "i" | "r",
    text: string,
    now: number,
  ): void {
    const buffer = this.buffer(sessionId);
    const t = Math.max(0, Math.round(now - state.t0)) / 1000;
    const line = `${JSON.stringify([t, kind, text])}\n`;
    buffer.lines.push(line);
    buffer.bytes += line.length;
    if (buffer.bytes >= this.limits.flushBytes) {
      void this.flush(sessionId, slot);
    } else {
      buffer.timer ??= setTimeout(() => {
        buffer.timer = undefined;
        void this.flush(sessionId, slot);
      }, this.limits.flushMs);
    }
  }

  /**
   * Writes the buffered lines to storage as chunks and, when the part is
   * full, starts the next one and stores the full part in the background.
   * The state is updated before any await, so lines buffered meanwhile land
   * in the right part.
   */
  private async flush(sessionId: string, slot: RecordingSlot): Promise<void> {
    const buffer = this.buffers.get(sessionId);
    if (buffer?.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = undefined;
    }
    const state = slot.get();
    if (!buffer?.lines.length || !state || state.failed) return;
    const data = encoder.encode(buffer.lines.join(""));
    buffer.lines = [];
    buffer.bytes = 0;
    const entries: Record<string, Uint8Array> = {};
    let seq = state.seq;
    for (let offset = 0; offset < data.byteLength; offset += RECORDING_VALUE_BYTES) {
      entries[chunkKey(sessionId, state.part, seq++)] = data.slice(
        offset,
        offset + RECORDING_VALUE_BYTES,
      );
    }
    const bytes = state.bytes + data.byteLength;
    const full = bytes >= this.limits.partBytes;
    slot.set(
      full ? { ...state, part: state.part + 1, seq: 0, bytes: 0 } : { ...state, seq, bytes },
    );
    try {
      await this.host.ctx.storage.put(entries);
    } catch (err) {
      await this.fail(sessionId, slot, err);
      return;
    }
    if (full) {
      const part = state.part;
      void this.enqueue(sessionId, slot, () => this.storePart(sessionId, part));
    }
  }

  /** Runs a task after the session's earlier ones, unless one of them failed. */
  private enqueue(
    sessionId: string,
    slot: RecordingSlot,
    task: () => Promise<void>,
  ): Promise<boolean> {
    const next = (this.chains.get(sessionId) ?? Promise.resolve(true)).then(async (intact) => {
      if (!intact) return false;
      try {
        await task();
        return true;
      } catch (err) {
        await this.fail(sessionId, slot, err);
        return false;
      }
    });
    this.chains.set(sessionId, next);
    return next;
  }

  /** Encrypts and uploads one part, then deletes its chunks and counts it on the row. */
  private async storePart(sessionId: string, part: number): Promise<void> {
    const storage = this.host.ctx.storage;
    const meta = await storage.get<RecordingMeta>(metaKey(sessionId));
    if (!meta) return;
    const chunks = await storage.list<Uint8Array>({ prefix: partPrefix(sessionId, part) });
    const plain = concat([encoder.encode(`${meta.header}\n`), ...chunks.values()]);
    const sealed = await ageEncrypt(meta.recipient, await gzip(plain));
    plain.fill(0);
    await this.host.bucket.put(
      shellRecordingKey(meta.project_id, meta.started_at, sessionId, part),
      sealed,
      { httpMetadata: { contentType: "application/octet-stream" } },
    );
    await this.deleteKeys([...chunks.keys()]);
    await this.host.db
      .update(shellSessions)
      .set({
        recordingParts: sql`${shellSessions.recordingParts} + 1`,
        recordingBytes: sql`${shellSessions.recordingBytes} + ${sealed.byteLength}`,
      })
      .where(eq(shellSessions.id, sessionId));
  }

  /** Stops a recording after a failure: every chunk and the meta go, the row says `failed`. */
  private async fail(sessionId: string, slot: RecordingSlot | null, err: unknown): Promise<void> {
    console.error("shell recording failed", err instanceof Error ? err.name : "error");
    const state = slot?.get();
    if (slot && state && !state.failed) slot.set({ ...state, failed: true });
    const buffer = this.buffers.get(sessionId);
    if (buffer?.timer) clearTimeout(buffer.timer);
    this.buffers.delete(sessionId);
    try {
      const keys = await this.host.ctx.storage.list({ prefix: `${CHUNK_PREFIX}${sessionId}:` });
      await this.deleteKeys([...keys.keys(), metaKey(sessionId)]);
    } catch (cleanup) {
      console.error(
        "shell recording cleanup failed",
        cleanup instanceof Error ? cleanup.name : "error",
      );
    }
    try {
      await setShellRecordingState(this.host.db, sessionId, "failed");
    } catch {
      // The row keeps `recording`; there is nothing to play back either way.
    }
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_KEYS) {
      await this.host.ctx.storage.delete(keys.slice(i, i + DELETE_KEYS));
    }
  }
}
