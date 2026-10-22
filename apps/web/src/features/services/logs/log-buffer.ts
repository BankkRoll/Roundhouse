/**
 * The log viewer's data model: an append-mostly array of lines merged from paged
 * history (older pages prepended) and live socket batches (appended), bounded so a
 * service that logs for days can't exhaust the tab's memory.
 *
 * Pure functions over immutable arrays; the hook in `use-log-stream.ts` holds the state.
 *
 * @module
 */
import { stripAnsi } from "@openrail/ui/controls";
import type { LogEntry } from "../../../lib/api/deploy-types";

/** Lines kept in memory; older ones are dropped as live lines arrive. */
export const MAX_LOG_LINES = 50_000;

/** Output streams a line can come from. */
export type LogStream = LogEntry["stream"];

/** Every stream, in filter order. */
export const LOG_STREAMS: readonly LogStream[] = ["stdout", "stderr", "system"];

/** A line as the viewer holds it. */
export interface LogLine {
  /** Monotonic key, unique within one buffer. */
  id: number;
  ts: number;
  stream: LogStream;
  /** Raw text, possibly with ANSI escapes. */
  text: string;
  /** Visible text without escapes, for search and copy. */
  plain: string;
  workloadId?: string;
}

/** The buffer and what is known about lines before it. */
export interface LogBuffer {
  lines: LogLine[];
  /** Cursor to the page before the oldest loaded line; `null` at the beginning. */
  olderCursor: string | null;
  /** Lines were dropped from the start to stay under {@link MAX_LOG_LINES}. */
  trimmed: boolean;
  nextId: number;
}

/** An empty buffer. */
export const EMPTY_BUFFER: LogBuffer = { lines: [], olderCursor: null, trimmed: false, nextId: 1 };

type IncomingLine = Pick<LogEntry, "ts" | "stream" | "text"> & { workload_id?: string };

function toLines(entries: readonly IncomingLine[], firstId: number): LogLine[] {
  return entries.map((entry, index) => ({
    id: firstId + index,
    ts: entry.ts,
    stream: entry.stream,
    text: entry.text,
    plain: stripAnsi(entry.text),
    workloadId: entry.workload_id,
  }));
}

function sameLine(a: Pick<LogLine, "ts" | "stream" | "text">, b: IncomingLine): boolean {
  return a.ts === b.ts && a.stream === b.stream && a.text === b.text;
}

function trim(buffer: LogBuffer, max: number): LogBuffer {
  if (buffer.lines.length <= max) return buffer;
  return {
    ...buffer,
    lines: buffer.lines.slice(buffer.lines.length - max),
    olderCursor: null,
    trimmed: true,
  };
}

/**
 * Replaces the buffer with the newest page, keeping live lines that arrived while the
 * page was loading unless the page already contains them.
 *
 * @param buffer - Current buffer (possibly holding early live lines).
 * @param lines - The newest page, oldest first.
 * @param cursor - The page's `next_cursor`.
 * @returns The new buffer.
 */
export function withNewestPage(
  buffer: LogBuffer,
  lines: readonly IncomingLine[],
  cursor: string | null,
): LogBuffer {
  const lastTs = lines.at(-1)?.ts ?? Number.NEGATIVE_INFINITY;
  const tail = lines.slice(-200);
  const early = buffer.lines.filter(
    (line) => line.ts >= lastTs && !tail.some((entry) => sameLine(line, entry)),
  );
  const page = toLines(lines, buffer.nextId);
  const nextId = buffer.nextId + page.length;
  const kept = early.map((line, index) => ({ ...line, id: nextId + index }));
  return trim(
    {
      lines: [...page, ...kept],
      olderCursor: cursor,
      trimmed: false,
      nextId: nextId + kept.length,
    },
    MAX_LOG_LINES,
  );
}

/**
 * Prepends an older page.
 *
 * @param buffer - Current buffer.
 * @param lines - The older page, oldest first.
 * @param cursor - Its `next_cursor`, for the page before it.
 * @returns The new buffer. Its line ids stay unique: older lines get fresh ids too.
 */
export function withOlderPage(
  buffer: LogBuffer,
  lines: readonly IncomingLine[],
  cursor: string | null,
): LogBuffer {
  const older = toLines(lines, buffer.nextId);
  return {
    lines: [...older, ...buffer.lines],
    olderCursor: cursor,
    trimmed: buffer.trimmed,
    nextId: buffer.nextId + older.length,
  };
}

/**
 * Appends live lines, skipping any already at the end of the buffer (a batch can overlap
 * the newest page), and trims the start past `max`.
 *
 * @param buffer - Current buffer.
 * @param lines - A live batch, oldest first.
 * @param max - Line cap. Defaults to {@link MAX_LOG_LINES}.
 * @returns The new buffer.
 */
export function withLiveLines(
  buffer: LogBuffer,
  lines: readonly IncomingLine[],
  max = MAX_LOG_LINES,
): LogBuffer {
  const recent = buffer.lines.slice(-lines.length - 50);
  const fresh = lines.filter((entry) => !recent.some((line) => sameLine(line, entry)));
  if (fresh.length === 0) return buffer;
  const added = toLines(fresh, buffer.nextId);
  return trim(
    { ...buffer, lines: [...buffer.lines, ...added], nextId: buffer.nextId + added.length },
    max,
  );
}

/** What the viewer shows. */
export interface LogFilter {
  streams: ReadonlySet<LogStream>;
  /** Case-insensitive substring of the visible text. */
  query: string;
}

/**
 * Applies the stream filter and search.
 *
 * @param lines - Every loaded line.
 * @param filter - Streams to show and the search text.
 * @returns Matching lines; the input array itself when nothing is filtered.
 */
export function filterLines(lines: readonly LogLine[], filter: LogFilter): readonly LogLine[] {
  const needle = filter.query.trim().toLowerCase();
  if (!needle && filter.streams.size === LOG_STREAMS.length) return lines;
  return lines.filter(
    (line) =>
      filter.streams.has(line.stream) && (!needle || line.plain.toLowerCase().includes(needle)),
  );
}

/**
 * Formats lines for the clipboard: visible text only, never escape sequences.
 *
 * @param lines - Lines to copy.
 * @param timestamps - Prefix each with an ISO timestamp.
 * @returns Newline-separated text.
 */
export function linesToText(lines: readonly LogLine[], timestamps: boolean): string {
  return lines
    .map((line) => (timestamps ? `${new Date(line.ts).toISOString()} ${line.plain}` : line.plain))
    .join("\n");
}
