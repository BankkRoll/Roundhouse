/**
 * Data-service frames (ADR 0004): volume lifecycle, backups, restores,
 * volume migration copies and the data browser's queries. Mirrored by
 * `go/data.go`.
 *
 * Every credential travels sealed to the node (ADR 0014 §6): presigned part
 * URLs in `parts_sealed`, the download URL and age identity in
 * `secrets_sealed`, the database principal in `credential_sealed`. Every
 * frame carrying one has the 60 s credential TTL.
 *
 * Gates: `VOLUMES_PROTOCOL_VERSION` (`volume_delete`, `volume_status`),
 * `BACKUPS_PROTOCOL_VERSION` (backup, restore, copy), and
 * `DB_QUERY_PROTOCOL_VERSION` (`db_query`).
 *
 * @module
 */
import { z } from "zod";
import { SealedBoxSchema } from "./box";
import { ControlHeader, isShortLived, SHORT_LIVED_ISSUE } from "./control";
import {
  AGE_RECIPIENT_RE,
  BACKUP_PART_ALIGN_BYTES,
  boundedString,
  Count,
  DB_NAME_RE,
  ETAG_RE,
  IdString,
  MAX_BACKUP_DATABASES,
  MAX_BACKUP_PART_BYTES,
  MAX_BACKUP_PARTS,
  MAX_BACKUP_PARTS_PER_FRAME,
  MAX_BACKUP_PROGRESS_PARTS,
  MAX_BACKUP_TIMEOUT_S,
  MAX_DB_COLUMNS,
  MAX_DB_IDENTIFIER_BYTES,
  MAX_DB_PARAMS,
  MAX_DB_QUERY_RESULT_BYTES,
  MAX_DB_QUERY_ROWS,
  MAX_DB_QUERY_TIMEOUT_MS,
  MAX_DB_STATEMENT_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_VOLUMES_PER_NODE,
  MIN_BACKUP_PART_BYTES,
  REQUEST_ID_RE,
  Sha256Hex,
  utf8ByteLength,
} from "./limits";

// -----------------------------------------------------------------------------
// Vocabulary
// -----------------------------------------------------------------------------

/** Database engines the agent has dump tools and drivers for. */
export const DATABASE_ENGINES = ["postgres", "mysql", "redis", "mongodb"] as const;

/** A database engine; see {@link DATABASE_ENGINES}. */
export type DatabaseEngine = (typeof DATABASE_ENGINES)[number];

/** `dump` runs the engine's own tool in the container; `snapshot` tars the volume. */
export const BACKUP_METHODS = ["dump", "snapshot"] as const;

/** A backup method; see {@link BACKUP_METHODS}. */
export type BackupMethod = (typeof BACKUP_METHODS)[number];

/** `stop` stops the workload around a snapshot, as `stop_first` does. */
export const QUIESCE_MODES = ["none", "stop"] as const;

/** How the agent enforces a volume's quota on this node. */
export const VOLUME_QUOTA_MODES = ["xfs_project", "ext4_project", "loop", "none"] as const;

/** A quota mechanism; see {@link VOLUME_QUOTA_MODES}. */
export type VolumeQuotaMode = (typeof VOLUME_QUOTA_MODES)[number];

/** A volume's state on the node. `orphaned` means held but no longer listed. */
export const VOLUME_STATES = [
  "creating",
  "ready",
  "resizing",
  "orphaned",
  "error",
  "deleted",
] as const;

/** A volume's state; see {@link VOLUME_STATES}. */
export type VolumeState = (typeof VOLUME_STATES)[number];

const PartNumber = z.number().int().min(1).max(MAX_BACKUP_PARTS);
const AgeRecipient = z.string().regex(AGE_RECIPIENT_RE, "expected an age recipient");
const TimeoutS = z.number().int().min(60).max(MAX_BACKUP_TIMEOUT_S);
const PartSize = z
  .number()
  .int()
  .min(MIN_BACKUP_PART_BYTES)
  .max(MAX_BACKUP_PART_BYTES)
  .refine((n) => n % BACKUP_PART_ALIGN_BYTES === 0, {
    message: `must be a multiple of ${BACKUP_PART_ALIGN_BYTES}`,
  });
const ErrorText = boundedString(MAX_MESSAGE_BYTES, 1);

// -----------------------------------------------------------------------------
// Control → agent
// -----------------------------------------------------------------------------

/** Deletes a volume's data, 72 h after a soft delete. The only frame that removes data. */
export const VolumeDeleteSchema = z.object({
  type: z.literal("volume_delete"),
  ...ControlHeader,
  volume_id: IdString,
});

/** Deletes a volume's data. */
export type VolumeDelete = z.infer<typeof VolumeDeleteSchema>;

const BackupSourceFields = {
  method: z.enum(BACKUP_METHODS),
  /** Required for `dump`. */
  engine: z.enum(DATABASE_ENGINES).optional(),
  /** The container to dump from, or to stop around a quiesced snapshot. */
  workload_id: IdString.optional(),
  volume_id: IdString,
};

function checkBackupSource(
  j: { method: string; engine?: string; workload_id?: string },
  ctx: z.RefinementCtx,
) {
  if (j.method === "dump" && (!j.engine || !j.workload_id)) {
    ctx.addIssue({
      code: "custom",
      message: "dump needs engine and workload_id",
      path: ["engine"],
    });
  }
}

/**
 * Backs up a volume to a multipart object: source → RHBK1 → zstd → age →
 * fixed-size parts → presigned `PUT`s. Answered by `backup_progress`,
 * `backup_parts_request` and `backup_result`. Always credential-bearing.
 */
export const BackupJobSchema = z
  .object({
    type: z.literal("backup_job"),
    ...ControlHeader,
    backup_id: IdString,
    ...BackupSourceFields,
    /** `stop` only with `snapshot`. */
    quiesce: z.enum(QUIESCE_MODES),
    /** Databases to dump; `null` dumps all. Only with `dump`. */
    databases: z
      .array(z.string().regex(DB_NAME_RE, "expected a database name"))
      .min(1)
      .max(MAX_BACKUP_DATABASES)
      .nullable(),
    /** The project's age recipient the stream is encrypted to. */
    age_recipient: AgeRecipient,
    /** Every part but the last has exactly this size. */
    part_size_bytes: PartSize,
    /** `SealedBackupPartsSchema` with the first ≤ 16 URLs, AAD `backupPartsAad(node, backup_id)`. */
    parts_sealed: SealedBoxSchema,
    timeout_s: TimeoutS,
  })
  .superRefine((j, ctx) => {
    checkBackupSource(j, ctx);
    if (j.method === "snapshot" && j.databases !== null) {
      ctx.addIssue({
        code: "custom",
        message: "snapshots back up the whole volume",
        path: ["databases"],
      });
    }
    if (j.method === "dump" && j.quiesce !== "none") {
      ctx.addIssue({ code: "custom", message: "dumps are never quiesced", path: ["quiesce"] });
    }
    if (j.quiesce === "stop" && !j.workload_id) {
      ctx.addIssue({ code: "custom", message: "quiesce needs workload_id", path: ["workload_id"] });
    }
  })
  .refine(isShortLived, SHORT_LIVED_ISSUE);

/** Backs up a volume. */
export type BackupJob = z.infer<typeof BackupJobSchema>;

/** More presigned part URLs, answering `backup_parts_request`. Always credential-bearing. */
export const BackupPartsSchema = z
  .object({
    type: z.literal("backup_parts"),
    ...ControlHeader,
    backup_id: IdString,
    /** `SealedBackupPartsSchema` with ≤ 32 URLs, AAD `backupPartsAad(node, backup_id)`. */
    parts_sealed: SealedBoxSchema,
  })
  .refine(isShortLived, SHORT_LIVED_ISSUE);

/** More presigned part URLs. */
export type BackupParts = z.infer<typeof BackupPartsSchema>;

const RestoreFields = {
  backup_id: IdString,
  /** SHA-256 of the stored (encrypted) object; the agent verifies it while streaming. */
  sha256: Sha256Hex,
  size_bytes: z.number().int().positive(),
  /** `SealedRestoreSecretsSchema`, AAD `restoreSecretsAad(node, restore_id | migration_id)`. */
  secrets_sealed: SealedBoxSchema,
  timeout_s: TimeoutS,
};

/** Restores a backup into a volume; answered by `restore_result`. Always credential-bearing. */
export const RestoreJobSchema = z
  .object({
    type: z.literal("restore_job"),
    ...ControlHeader,
    restore_id: IdString,
    ...BackupSourceFields,
    ...RestoreFields,
  })
  .superRefine(checkBackupSource)
  .refine(isShortLived, SHORT_LIVED_ISSUE);

/** Restores a backup into a volume. */
export type RestoreJob = z.infer<typeof RestoreJobSchema>;

/**
 * Migration step 3 (ADR 0004): a quiesced snapshot of the volume to object
 * storage, answered like a backup (`backup_progress`, `backup_parts_request`,
 * `backup_result` for `backup_id`). Always credential-bearing.
 */
export const VolumeCopyOutSchema = z
  .object({
    type: z.literal("volume_copy_out"),
    ...ControlHeader,
    migration_id: IdString,
    backup_id: IdString,
    volume_id: IdString,
    /** The workload to stop for the copy, when one still runs. */
    workload_id: IdString.optional(),
    age_recipient: AgeRecipient,
    part_size_bytes: PartSize,
    parts_sealed: SealedBoxSchema,
    timeout_s: TimeoutS,
  })
  .refine(isShortLived, SHORT_LIVED_ISSUE);

/** Copies a volume out for migration. */
export type VolumeCopyOut = z.infer<typeof VolumeCopyOutSchema>;

/**
 * Migration step 4: restores the copy-out snapshot into the (new, `ready`)
 * volume on the target node, answered by `restore_result` with
 * `restore_id = migration_id`. Always credential-bearing.
 */
export const VolumeCopyInSchema = z
  .object({
    type: z.literal("volume_copy_in"),
    ...ControlHeader,
    migration_id: IdString,
    volume_id: IdString,
    ...RestoreFields,
  })
  .refine(isShortLived, SHORT_LIVED_ISSUE);

/** Copies a volume in for migration. */
export type VolumeCopyIn = z.infer<typeof VolumeCopyInSchema>;

const DbIdentifier = boundedString(MAX_DB_IDENTIFIER_BYTES, 1).refine((s) => !s.includes("\0"), {
  message: "must not contain NUL",
});

/**
 * Data-browser operations (ADR 0004, "Operations"). The agent quotes
 * identifiers with the driver; `raw` is a single statement through the
 * extended protocol (SQL), a command document (MongoDB, JSON text in
 * `statement`), or an argv (Redis).
 */
export const DbOpSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("list_namespaces") }),
  z.object({
    type: z.literal("list_tables"),
    namespace: DbIdentifier.optional(),
    /** Redis `SCAN` cursor from the previous page. */
    cursor: z
      .string()
      .regex(/^[0-9]{1,20}$/, "expected a scan cursor")
      .optional(),
    /** Redis `MATCH` pattern. */
    pattern: DbIdentifier.optional(),
  }),
  z.object({
    type: z.literal("describe"),
    namespace: DbIdentifier.optional(),
    table: DbIdentifier,
  }),
  z.object({
    type: z.literal("rows"),
    namespace: DbIdentifier.optional(),
    table: DbIdentifier,
    offset: z.number().int().min(0).max(1_000_000_000),
    order_by: DbIdentifier.optional(),
    descending: z.boolean().optional(),
  }),
  z
    .object({
      type: z.literal("raw"),
      /** SQL, or a MongoDB command document as JSON text. */
      statement: boundedString(MAX_DB_STATEMENT_BYTES, 1).optional(),
      /** Positional parameters of SQL, as text; `null` is SQL NULL. */
      params: z
        .array(boundedString(MAX_DB_STATEMENT_BYTES).nullable())
        .max(MAX_DB_PARAMS)
        .optional(),
      /** A Redis command. */
      argv: z.array(boundedString(MAX_DB_STATEMENT_BYTES)).min(1).max(MAX_DB_PARAMS).optional(),
    })
    .refine((o) => (o.statement !== undefined) !== (o.argv !== undefined), {
      message: "raw needs exactly one of statement and argv",
    })
    .refine((o) => !o.params || o.statement !== undefined, {
      message: "params only go with a statement",
      path: ["params"],
    }),
  z.object({ type: z.literal("provision_readonly") }),
]);

/** A data-browser operation. */
export type DbOp = z.infer<typeof DbOpSchema>;

/** `read` connects as `roundhouse_ro` in a read-only transaction; `write` as the admin. */
export const DB_QUERY_MODES = ["read", "write"] as const;

/**
 * Runs one data-browser operation against a database container; answered
 * by `db_query_result` with the same `request_id`. Always credential-bearing.
 */
export const DbQuerySchema = z
  .object({
    type: z.literal("db_query"),
    ...ControlHeader,
    request_id: z.string().regex(REQUEST_ID_RE, "expected a request id"),
    workload_id: IdString,
    engine: z.enum(DATABASE_ENGINES),
    /** `SealedDbCredentialSchema`, AAD `dbCredentialAad(node, request_id)`. */
    credential_sealed: SealedBoxSchema,
    mode: z.enum(DB_QUERY_MODES),
    op: DbOpSchema,
    max_rows: z.number().int().min(1).max(MAX_DB_QUERY_ROWS),
    max_bytes: z.number().int().min(1).max(MAX_DB_QUERY_RESULT_BYTES),
    timeout_ms: z.number().int().min(100).max(MAX_DB_QUERY_TIMEOUT_MS),
  })
  .refine((q) => q.op.type !== "provision_readonly" || q.mode === "write", {
    message: "provision_readonly runs as the admin",
    path: ["mode"],
  })
  .refine(isShortLived, SHORT_LIVED_ISSUE);

/** Runs one data-browser operation. */
export type DbQuery = z.infer<typeof DbQuerySchema>;

// -----------------------------------------------------------------------------
// Agent → control
// -----------------------------------------------------------------------------

/** One volume as the node holds it. */
export const VolumeStatusReportSchema = z.object({
  volume_id: IdString,
  state: z.enum(VOLUME_STATES),
  size_bytes: Count,
  used_bytes: Count,
  quota: z.enum(VOLUME_QUOTA_MODES),
  message: boundedString(MAX_MESSAGE_BYTES).optional(),
});

/** One volume as the node holds it. */
export type VolumeStatusReport = z.infer<typeof VolumeStatusReportSchema>;

/** Every volume the node holds, every 60 s and on change. */
export const VolumeStatusSchema = z.object({
  type: z.literal("volume_status"),
  volumes: z
    .array(VolumeStatusReportSchema)
    .max(MAX_VOLUMES_PER_NODE)
    .refine((vs) => new Set(vs.map((v) => v.volume_id)).size === vs.length, {
      message: "duplicate volume",
    }),
});

/** Every volume the node holds. */
export type VolumeStatus = z.infer<typeof VolumeStatusSchema>;

/** Asks for the next presigned part URLs of a running backup or copy-out. */
export const BackupPartsRequestSchema = z.object({
  type: z.literal("backup_parts_request"),
  backup_id: IdString,
  from_part: PartNumber,
  count: z.number().int().min(1).max(MAX_BACKUP_PARTS_PER_FRAME),
});

/** Asks for the next presigned part URLs. */
export type BackupPartsRequest = z.infer<typeof BackupPartsRequestSchema>;

/** One uploaded part, for `CompleteMultipartUpload`. */
export const UploadedPartSchema = z.object({
  part_number: PartNumber,
  etag: z.string().regex(ETAG_RE, "expected an etag"),
  size: z.number().int().positive(),
});

/** Uploaded parts, reported as they complete. */
export const BackupProgressSchema = z.object({
  type: z.literal("backup_progress"),
  backup_id: IdString,
  parts: z.array(UploadedPartSchema).min(1).max(MAX_BACKUP_PROGRESS_PARTS),
  /** Source bytes read so far, before compression and encryption. */
  bytes_raw: Count,
});

/** Uploaded parts, reported as they complete. */
export type BackupProgress = z.infer<typeof BackupProgressSchema>;

/** Outcome of a `backup_job` or `volume_copy_out`. */
export const BackupResultSchema = z
  .object({
    type: z.literal("backup_result"),
    backup_id: IdString,
    ok: z.boolean(),
    /** Present exactly when `ok`. */
    part_count: z.number().int().min(1).max(MAX_BACKUP_PARTS).optional(),
    bytes_raw: Count.optional(),
    bytes_stored: Count.optional(),
    /** SHA-256 of the stored (encrypted) bytes. */
    sha256: Sha256Hex.optional(),
    /** Present exactly when not `ok`, e.g. `backup_too_large`. */
    error: ErrorText.optional(),
    duration_ms: Count,
  })
  .refine(
    (r) => {
      const stats = [r.part_count, r.bytes_raw, r.bytes_stored, r.sha256];
      return r.ok
        ? stats.every((v) => v !== undefined) && r.error === undefined
        : stats.every((v) => v === undefined) && r.error !== undefined;
    },
    { message: "a successful result has its stats and no error; a failed one, only an error" },
  );

/** Outcome of a backup or copy-out. */
export type BackupResult = z.infer<typeof BackupResultSchema>;

/** Outcome of a `restore_job` or `volume_copy_in` (`restore_id` is then the migration ID). */
export const RestoreResultSchema = z
  .object({
    type: z.literal("restore_result"),
    restore_id: IdString,
    ok: z.boolean(),
    error: ErrorText.optional(),
    /** Bytes restored. */
    bytes: Count.optional(),
    duration_ms: Count,
  })
  .refine((r) => r.ok === (r.error === undefined), {
    message: "exactly the failed results carry an error",
    path: ["error"],
  });

/** Outcome of a restore or copy-in. */
export type RestoreResult = z.infer<typeof RestoreResultSchema>;

/** A result column. */
export const DbColumnSchema = z.object({
  name: boundedString(MAX_DB_IDENTIFIER_BYTES),
  /** The engine's type name, e.g. `int8`, `varchar`, `hash`. */
  type: boundedString(128),
});

/**
 * Answers `db_query`. Cells are JSON values: binary as `{"$b64": "…"}`, 64-bit
 * integers as strings. Rows are at most `max_rows` and
 * {@link MAX_DB_QUERY_RESULT_BYTES} encoded; `truncated` says more existed.
 */
export const DbQueryResultSchema = z
  .object({
    type: z.literal("db_query_result"),
    request_id: z.string().regex(REQUEST_ID_RE, "expected a request id"),
    ok: z.boolean(),
    /** Present exactly when `ok`, as are `rows` and `row_count`. */
    columns: z.array(DbColumnSchema).max(MAX_DB_COLUMNS).optional(),
    rows: z
      .array(z.array(z.unknown()).max(MAX_DB_COLUMNS))
      .max(MAX_DB_QUERY_ROWS)
      .refine((rows) => utf8ByteLength(JSON.stringify(rows)) <= MAX_DB_QUERY_RESULT_BYTES, {
        message: `at most ${MAX_DB_QUERY_RESULT_BYTES} bytes of rows`,
      })
      .optional(),
    /** Rows returned, or rows affected by a write. */
    row_count: Count.optional(),
    truncated: z.boolean().optional(),
    /** Engine notices and warnings. */
    notice: boundedString(MAX_MESSAGE_BYTES).optional(),
    error: ErrorText.optional(),
    duration_ms: Count,
  })
  .refine(
    (r) =>
      r.ok
        ? r.columns !== undefined && r.rows !== undefined && r.row_count !== undefined && !r.error
        : r.error !== undefined && r.columns === undefined && r.rows === undefined,
    { message: "a successful result has columns, rows and row_count; a failed one, an error" },
  );

/** Answers `db_query`. */
export type DbQueryResult = z.infer<typeof DbQueryResultSchema>;
