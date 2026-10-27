/**
 * Point-in-time recovery for Postgres (ADR 0004, "Point-in-time
 * recovery"), from `PITR_PROTOCOL_VERSION`: continuous WAL archiving and
 * the WAL a `base` restore replays. Mirrored by `go/pitr.go`.
 *
 * Archiving: the database runs with an `archive_command` that copies each
 * finished WAL file into {@link WAL_SPOOL_DIR} on its volume. The agent
 * ships the spool for every volume whose `desired_state.volumes[].wal_archive`
 * is set: it asks for upload URLs with `wal_archive` (`pending`), uploads each
 * file compressed with zstd and encrypted to the project's age recipient,
 * reports it (`archived`), and deletes it from the spool once
 * `wal_archive_ack` lists it in `acked`. The control plane records a file
 * before it acks it, so a lost frame only costs a re-upload.
 *
 * Restoring: a `restore_job` with `method: "base"` carries `pitr`; the agent
 * fetches its `wal_files` with `wal_fetch_request` / `wal_fetch` and replays
 * them in a server it runs on the restored data with no network.
 *
 * Every URL travels sealed to the node (`wal-upload`, `wal-fetch` boxes)
 * in frames with the 60 s credential TTL.
 *
 * @module
 */
import { z } from "zod";
import { boxInfo, PresignedUrlString, SealedBoxSchema } from "./box";
import { ControlHeader, isShortLived, SHORT_LIVED_ISSUE } from "./control";
import {
  IdString,
  MAX_PITR_WAL_FILES,
  MAX_WAL_ARCHIVED_PER_FRAME,
  MAX_WAL_FETCH_PER_FRAME,
  MAX_WAL_FILE_BYTES,
  MAX_WAL_UPLOADS_PER_FRAME,
  Sha256Hex,
  WAL_FILE_RE,
  WAL_SEGMENT_RE,
} from "./limits";

/**
 * Directory, relative to the volume's mount path, that `archive_command`
 * copies finished WAL files into and the agent ships from.
 */
export const WAL_SPOOL_DIR = "roundhouse-wal";

/**
 * `archive_timeout`: the longest a quiet database's last writes wait in an
 * unfinished WAL segment before Postgres switches segments, so the newest
 * restorable point trails the database by about this much.
 */
export const WAL_ARCHIVE_TIMEOUT_S = 60;

/** A file `archive_command` archives; see `WAL_FILE_RE`. */
export const WalFileName = z.string().regex(WAL_FILE_RE, "expected a WAL file name");

const unique = (names: readonly string[]) => new Set(names).size === names.length;

// -----------------------------------------------------------------------------
// Segment names
// -----------------------------------------------------------------------------

/** Segments per WAL "log" (the middle eight hex digits) at the default 16 MiB `wal_segment_size`. */
const SEGMENTS_PER_LOG = 0x100;

/**
 * The timeline of a WAL file: the first eight hex digits.
 *
 * @param name - A WAL file name.
 * @returns E.g. `00000001`.
 */
export function walTimeline(name: string): string {
  return name.slice(0, 8);
}

/**
 * The segment that follows `name` on the same timeline, at the default 16 MiB
 * `wal_segment_size` (the templates never change it).
 *
 * @param name - A segment name (no suffix).
 * @returns The next segment's name.
 * @example
 * nextWalSegment("0000000100000000000000FF"); // "000000010000000100000000"
 */
export function nextWalSegment(name: string): string {
  if (!WAL_SEGMENT_RE.test(name)) throw new Error(`not a WAL segment: ${name}`);
  let log = Number.parseInt(name.slice(8, 16), 16);
  let seg = Number.parseInt(name.slice(16, 24), 16) + 1;
  if (seg >= SEGMENTS_PER_LOG) {
    seg = 0;
    log += 1;
  }
  const hex8 = (n: number) => n.toString(16).toUpperCase().padStart(8, "0");
  return `${walTimeline(name)}${hex8(log)}${hex8(seg)}`;
}

// -----------------------------------------------------------------------------
// Sealed payloads
// -----------------------------------------------------------------------------

/**
 * AAD of a stream's upload URLs (`wal_archive_ack.uploads_sealed`).
 *
 * @param nodeId - Node the box is sealed to.
 * @param streamId - `wal_archive_ack.stream_id`.
 * @returns E.g. `roundhouse-box:v1:wal-upload:node_1:wal_1`.
 */
export function walUploadAad(nodeId: string, streamId: string): string {
  return `${boxInfo("wal-upload")}:${nodeId}:${streamId}`;
}

/**
 * AAD of a restore's WAL download URLs (`wal_fetch.files_sealed`).
 *
 * @param nodeId - Node the box is sealed to.
 * @param restoreId - `wal_fetch.restore_id`.
 * @returns E.g. `roundhouse-box:v1:wal-fetch:node_1:rst_1`.
 */
export function walFetchAad(nodeId: string, restoreId: string): string {
  return `${boxInfo("wal-fetch")}:${nodeId}:${restoreId}`;
}

/** Plaintext of `wal_archive_ack.uploads_sealed`: one presigned `PUT` per file. */
export const SealedWalUploadsSchema = z.object({
  uploads: z
    .array(z.object({ name: WalFileName, url: PresignedUrlString }))
    .min(1)
    .max(MAX_WAL_UPLOADS_PER_FRAME)
    .refine((u) => unique(u.map((f) => f.name)), { message: "duplicate WAL file" }),
});

/** Plaintext of `wal_archive_ack.uploads_sealed`. */
export type SealedWalUploads = z.infer<typeof SealedWalUploadsSchema>;

/** One archived WAL file a restore fetches. */
export const WalFetchFileSchema = z.object({
  /** Index in the restore's file list. */
  index: z
    .number()
    .int()
    .min(0)
    .max(MAX_PITR_WAL_FILES - 1),
  name: WalFileName,
  /** Presigned `GET` of the stored (compressed, encrypted) file. */
  url: PresignedUrlString,
  /** SHA-256 of the stored bytes; checked before anything is decrypted. */
  sha256: Sha256Hex,
  size: z.number().int().positive(),
});

/** One archived WAL file a restore fetches. */
export type WalFetchFile = z.infer<typeof WalFetchFileSchema>;

/** Plaintext of `wal_fetch.files_sealed`: consecutive files, ascending. */
export const SealedWalFilesSchema = z.object({
  files: z
    .array(WalFetchFileSchema)
    .min(1)
    .max(MAX_WAL_FETCH_PER_FRAME)
    .refine((fs) => fs.every((f, i) => i === 0 || f.index === fs[i - 1]!.index + 1), {
      message: "indexes must be consecutive and ascending",
    }),
});

/** Plaintext of `wal_fetch.files_sealed`. */
export type SealedWalFiles = z.infer<typeof SealedWalFilesSchema>;

// -----------------------------------------------------------------------------
// Agent → control
// -----------------------------------------------------------------------------

/** A WAL file the agent uploaded. */
export const ArchivedWalFileSchema = z.object({
  name: WalFileName,
  /** Bytes Postgres archived. */
  size_raw: z.number().int().positive().max(MAX_WAL_FILE_BYTES),
  /** Bytes stored, compressed and encrypted. */
  size_stored: z.number().int().positive(),
  /** SHA-256 of the stored bytes. */
  sha256: Sha256Hex,
  /**
   * Unix ms when Postgres finished the file (its spool copy's mtime): every
   * WAL record written before this is in this file or an earlier one.
   */
  archived_at: z.number().int().positive(),
});

/** A WAL file the agent uploaded. */
export type ArchivedWalFile = z.infer<typeof ArchivedWalFileSchema>;

/**
 * Reports uploaded WAL files and asks for upload URLs for spooled ones.
 * Sent whenever the spool changes, and every 30 s while anything is
 * pending or unacknowledged.
 */
export const WalArchiveSchema = z
  .object({
    type: z.literal("wal_archive"),
    volume_id: IdString,
    stream_id: IdString,
    archived: z.array(ArchivedWalFileSchema).max(MAX_WAL_ARCHIVED_PER_FRAME),
    /** Spooled files waiting for an upload URL, oldest first. */
    pending: z.array(WalFileName).max(MAX_WAL_UPLOADS_PER_FRAME),
  })
  .refine((m) => unique([...m.archived.map((f) => f.name), ...m.pending]), {
    message: "a WAL file is listed twice",
  });

/** Reports uploaded WAL files and asks for upload URLs. */
export type WalArchive = z.infer<typeof WalArchiveSchema>;

/** Asks for the download URLs of a `base` restore's WAL files. */
export const WalFetchRequestSchema = z.object({
  type: z.literal("wal_fetch_request"),
  restore_id: IdString,
  /** First index wanted. */
  from: z
    .number()
    .int()
    .min(0)
    .max(MAX_PITR_WAL_FILES - 1),
  count: z.number().int().min(1).max(MAX_WAL_FETCH_PER_FRAME),
});

/** Asks for a restore's WAL download URLs. */
export type WalFetchRequest = z.infer<typeof WalFetchRequestSchema>;

// -----------------------------------------------------------------------------
// Control → agent
// -----------------------------------------------------------------------------

/**
 * Answers `wal_archive`: the files now recorded, which the agent removes
 * from its spool, and upload URLs for pending ones. Always
 * credential-bearing (the URLs, when present, are sealed under
 * `walUploadAad(node, stream_id)`).
 */
export const WalArchiveAckSchema = z
  .object({
    type: z.literal("wal_archive_ack"),
    ...ControlHeader,
    volume_id: IdString,
    stream_id: IdString,
    acked: z.array(WalFileName).max(MAX_WAL_ARCHIVED_PER_FRAME),
    /** `SealedWalUploadsSchema`; absent when nothing is pending. */
    uploads_sealed: SealedBoxSchema.optional(),
  })
  .refine(isShortLived, SHORT_LIVED_ISSUE);

/** Answers `wal_archive`. */
export type WalArchiveAck = z.infer<typeof WalArchiveAckSchema>;

/** Answers `wal_fetch_request`. Always credential-bearing. */
export const WalFetchSchema = z
  .object({
    type: z.literal("wal_fetch"),
    ...ControlHeader,
    restore_id: IdString,
    /** `SealedWalFilesSchema`, AAD `walFetchAad(node, restore_id)`. */
    files_sealed: SealedBoxSchema,
  })
  .refine(isShortLived, SHORT_LIVED_ISSUE);

/** Answers `wal_fetch_request`. */
export type WalFetch = z.infer<typeof WalFetchSchema>;

/**
 * The `postgres` arguments that turn on WAL archiving into the volume's
 * spool. `archive_command` copies each file under a dot-name, syncs it and
 * renames it into place, so the agent never ships a half-written file and
 * Postgres never recycles a segment whose copy isn't on disk. A file already
 * spooled, or uploaded and awaiting its ack (`<name>.done`), counts as
 * archived, so a retry after a crash succeeds without copying twice.
 *
 * @param mountPath - The volume's mount path in the container.
 * @returns Arguments to append after `postgres`.
 * @example
 * postgresArchiveArgs("/var/lib/postgresql");
 */
export function postgresArchiveArgs(mountPath: string): string[] {
  const d = `${mountPath.replace(/\/+$/, "")}/${WAL_SPOOL_DIR}`;
  const command =
    `[ -f "${d}/%f" ] || [ -f "${d}/%f.done" ] || ` +
    `{ cp "%p" "${d}/.%f.tmp" && sync "${d}/.%f.tmp" && mv "${d}/.%f.tmp" "${d}/%f" && sync "${d}"; }`;
  return [
    "-c",
    "archive_mode=on",
    "-c",
    `archive_command=${command}`,
    "-c",
    `archive_timeout=${WAL_ARCHIVE_TIMEOUT_S}`,
  ];
}
