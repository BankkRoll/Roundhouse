/**
 * Log storage: NDJSON chunks in R2 indexed by `log_chunks`, secret
 * redaction before anything is stored or streamed, and newest-first paging
 * across chunks for the log routes.
 *
 * Chunk keys follow the ADR layout
 * `logs/<project>/<service>/<yyyy>/<mm>/<dd>/<hh>/<chunk>.ndjson`, where the
 * date is the chunk's first line (UTC) and `<chunk>` its `log_chunks.id`.
 *
 * @module
 */
import { type Db, logChunks } from "@roundhouse/db";
import type { LogStream } from "@roundhouse/protocol";
import { and, desc, eq, lte } from "drizzle-orm";
import { ApiError } from "./errors";

/** One stored line, as written to NDJSON and returned by the log routes. */
export interface StoredLogLine {
  ts: number;
  stream: LogStream;
  text: string;
  /** Replica that wrote it; absent for build logs. */
  workload_id?: string;
}

/** Replacement for redacted secret values. */
export const REDACTED = "[REDACTED]";

/**
 * Secrets shorter than this are not redacted: replacing every `1` or `true`
 * in a log would destroy it and a value that short protects nothing anyway.
 */
export const MIN_REDACTED_LENGTH = 4;

/**
 * Prepares secret values for {@link redact}: drops short ones and sorts
 * longest first, so a secret containing another is replaced whole.
 *
 * @param secrets - Plaintext secret values.
 * @returns Values to redact.
 */
export function redactionList(secrets: Iterable<string>): string[] {
  return [...new Set(secrets)]
    .filter((s) => s.length >= MIN_REDACTED_LENGTH)
    .sort((a, b) => b.length - a.length);
}

/**
 * Replaces every occurrence of each secret with {@link REDACTED}.
 *
 * @param text - A log line.
 * @param secrets - From {@link redactionList}.
 * @returns The line with secrets removed.
 * @example
 * redact("password=hunter22", ["hunter22"]); // "password=[REDACTED]"
 */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join(REDACTED);
  return out;
}

/**
 * R2 key of a log chunk.
 *
 * @param projectId - Owning project.
 * @param serviceId - Owning service.
 * @param firstTs - Timestamp of the chunk's first line.
 * @param chunkId - The `log_chunks.id`.
 * @returns The object key.
 */
export function logChunkKey(
  projectId: string,
  serviceId: string,
  firstTs: number,
  chunkId: string,
): string {
  const d = new Date(firstTs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `logs/${projectId}/${serviceId}/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(
    d.getUTCDate(),
  )}/${pad(d.getUTCHours())}/${chunkId}.ndjson`;
}

/**
 * Encodes lines as NDJSON.
 *
 * @param lines - Lines in arrival order.
 * @returns One JSON object per line, newline-terminated.
 */
export function toNdjson(lines: readonly StoredLogLine[]): string {
  return lines.map((l) => `${JSON.stringify(l)}\n`).join("");
}

function parseNdjson(text: string): StoredLogLine[] {
  const out: StoredLogLine[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as StoredLogLine);
    } catch {
      // A torn write would only ever lose the line it tore.
    }
  }
  return out;
}

const CURSOR_RE = /^(log_[0-9A-Za-z]{1,64})~(\d{1,7})$/;

/** Which lines a page reads: one deployment's runtime logs, or one build's. */
export type LogFilter = { deploymentId: string } | { buildId: string };

/** How many chunk index rows to read per round trip while paging. */
const CHUNK_BATCH = 16;

/**
 * Reads a page of lines, newest first across chunks, returned oldest first.
 *
 * Cursor `<chunk>~<n>` means "lines before index `n` of chunk `<chunk>`,
 * then every older chunk". Chunk IDs are ULIDs minted at flush time, so
 * their order is the order lines were stored.
 *
 * @param db - Database client.
 * @param bucket - The `LOGS` bucket.
 * @param filter - Deployment or build.
 * @param cursor - From a previous page's `next_cursor`.
 * @param limit - Most lines to return.
 * @returns Lines in chronological order and the cursor to the page before.
 * @throws {ApiError} 400 for a malformed cursor.
 */
export async function readLogPage(
  db: Db,
  bucket: R2Bucket,
  filter: LogFilter,
  cursor: string | undefined,
  limit: number,
): Promise<{ lines: StoredLogLine[]; next_cursor: string | null }> {
  let before: { chunk: string; index: number } | null = null;
  if (cursor) {
    const m = CURSOR_RE.exec(cursor);
    if (!m) throw new ApiError(400, "invalid_request", "cursor: malformed");
    before = { chunk: m[1]!, index: Number(m[2]) };
  }
  const owner =
    "deploymentId" in filter
      ? eq(logChunks.deploymentId, filter.deploymentId)
      : eq(logChunks.buildId, filter.buildId);

  const collected: StoredLogLine[] = [];
  let next: string | null = null;
  let upTo = before?.chunk ?? null;
  let skipFirst = false;
  outer: for (;;) {
    const chunks = await db
      .select({ id: logChunks.id, r2Key: logChunks.r2Key })
      .from(logChunks)
      .where(and(owner, ...(upTo ? [lte(logChunks.id, upTo)] : [])))
      .orderBy(desc(logChunks.id))
      .limit(CHUNK_BATCH + (skipFirst ? 1 : 0));
    const batch = skipFirst ? chunks.slice(1) : chunks;
    if (!batch.length) break;
    for (const chunk of batch) {
      const object = await bucket.get(chunk.r2Key);
      const lines = object ? parseNdjson(await object.text()) : [];
      const end =
        before && chunk.id === before.chunk ? Math.min(before.index, lines.length) : lines.length;
      for (let i = end - 1; i >= 0; i--) {
        if (collected.length === limit) {
          next = `${chunk.id}~${i + 1}`;
          break outer;
        }
        collected.push(lines[i]!);
      }
    }
    if (batch.length < CHUNK_BATCH) break;
    upTo = batch[batch.length - 1]!.id;
    skipFirst = true;
  }
  return { lines: collected.reverse(), next_cursor: next };
}
