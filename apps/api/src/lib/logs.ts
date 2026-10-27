/**
 * Log storage: NDJSON chunks in R2 indexed by `log_chunks`, each
 * deployment's redaction set ({@link deploymentRedaction}, applied before
 * anything is stored or streamed), and newest-first paging across chunks for
 * the log routes.
 *
 * Chunk keys follow the ADR layout
 * `logs/<project>/<service>/<yyyy>/<mm>/<dd>/<hh>/<chunk>.ndjson`, where the
 * date is the chunk's first line (UTC) and `<chunk>` its `log_chunks.id`.
 *
 * @module
 */
import { type Db, deployments, logChunks, projects, services } from "@roundhouse/db";
import type { LogStream } from "@roundhouse/protocol";
import { redactionNeedles } from "@roundhouse/shared";
import { and, desc, eq, lte } from "drizzle-orm";
import type { KeyEnv, Sealed } from "./crypto";
import { openDeploymentBuild, openDeploymentEnv } from "./desired-state";
import { ApiError } from "./errors";
import { loadEnvironmentVariables, projectKey } from "./variables";

/** One stored line, as written to NDJSON and returned by the log routes. */
export interface StoredLogLine {
  ts: number;
  stream: LogStream;
  text: string;
  /** Replica that wrote it; absent for build logs. */
  workload_id?: string;
}

/** What a deployment's logs are redacted with, and whether that can change. */
export interface DeploymentRedaction {
  /** From `redactionNeedles`: each secret and its encodings, longest first. */
  needles: string[];
  /**
   * The set is frozen with the deployment (`secret_keys` is set), so it may
   * be cached for as long as the deployment exists. `false` for rows from
   * before ADR 0014, which fall back to the current secret variables.
   */
  frozen: boolean;
}

/**
 * The redaction set of one deployment (ADR 0014 "Redaction").
 *
 * Values come from the deployment's own sealed env, selected by its frozen
 * `secret_keys`, so a secret rotated out of the variables stays redacted in
 * the logs of deployments still running with it. Build logs add the build's
 * BuildKit secrets and secret build args. Rows without `secret_keys` (sealed
 * before the column existed) use the service's and environment's current
 * secret variables.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings, to open the deployment's inputs.
 * @param deploymentId - The deployment (for build logs, the build's).
 * @param build - Whether the lines are build output.
 * @returns Needles for `redact`; none when the deployment is gone.
 */
export async function deploymentRedaction(
  db: Db,
  keys: KeyEnv,
  deploymentId: string,
  build: boolean,
): Promise<DeploymentRedaction> {
  const [row] = await db
    .select({
      envSealed: deployments.envSealed,
      secretKeys: deployments.secretKeys,
      buildEnvSealed: deployments.buildEnvSealed,
      environmentId: deployments.environmentId,
      projectId: services.projectId,
      serviceSlug: services.slug,
      workspaceId: projects.workspaceId,
    })
    .from(deployments)
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  if (!row) return { needles: [], frozen: false };
  const key = await projectKey(db, keys, row.projectId);
  const ref = { workspaceId: row.workspaceId, projectId: row.projectId, deploymentId };

  if (row.secretKeys === null) {
    const vars = await loadEnvironmentVariables(db, key, row.projectId, row.environmentId);
    return {
      needles: redactionNeedles([...(vars.secrets[row.serviceSlug] ?? []), ...vars.sharedSecrets]),
      frozen: false,
    };
  }
  const values: string[] = [];
  if (row.envSealed) {
    const { env, files } = await openDeploymentEnv(key, row.envSealed as Sealed, ref);
    for (const k of row.secretKeys) {
      const value = Object.hasOwn(files, k) ? files[k] : env[k];
      if (value !== undefined) values.push(value);
    }
  }
  if (build && row.buildEnvSealed) {
    const inputs = await openDeploymentBuild(key, row.buildEnvSealed as Sealed, ref);
    values.push(...Object.values(inputs.secrets));
    for (const name of inputs.secret_args) {
      if (Object.hasOwn(inputs.args, name)) values.push(inputs.args[name]!);
    }
  }
  return { needles: redactionNeedles(values), frozen: true };
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

/** Which lines a page reads: one deployment's runtime logs, one build's, or one cron run's. */
export type LogFilter = { deploymentId: string } | { buildId: string } | { cronRunId: string };

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
 * @param filter - Deployment, build or cron run.
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
      : "buildId" in filter
        ? eq(logChunks.buildId, filter.buildId)
        : eq(logChunks.cronRunId, filter.cronRunId);

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
