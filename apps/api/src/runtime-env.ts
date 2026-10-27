/**
 * The control plane's side of the runtime Worker contract (ADR 0011
 * "Runtime Worker" and "Observability"):
 * - {@link RuntimeEnv}: the `WorkerEntrypoint` runtime scripts reach through
 *   their `CONTROL` service binding; `resolveEnv(token)` hands a cold-starting
 *   container its deployment's resolved variables;
 * - {@link resolveRuntimeEnv}: the check and unseal behind it;
 * - {@link storeRuntimeTail}: the `tail()` handler's work, filing runtime
 *   scripts' console output and exceptions as `system` log lines of the
 *   deployment they ran for.
 *
 * SECURITY: `RuntimeEnv` is reachable only through a service binding from a
 * script in the same account, never over HTTP routes, and is the one place
 * resolved values leave the control plane for Cloudflare. The token must
 * verify (`lib/cloudflare/runtime-token.ts`), name the runtime's current
 * generation, and the runtime must be `active`; nothing here logs a value
 * or a token.
 *
 * @module
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  cfDeployments,
  cfRuntimes,
  createDb,
  type Db,
  deployments,
  logChunks,
  projects,
  services,
} from "@roundhouse/db";
import type { LogLine } from "@roundhouse/protocol";
import { newId, redact } from "@roundhouse/shared";
import { and, desc, eq } from "drizzle-orm";
import type { RuntimeEnvResolution } from "./cf-runtime";
import type { Env } from "./env";
import { verifyRuntimeToken } from "./lib/cloudflare/runtime-token";
import type { Sealed } from "./lib/crypto";
import { openDeploymentEnv } from "./lib/desired-state";
import { deploymentRedaction, logChunkKey, type StoredLogLine, toNdjson } from "./lib/logs";
import { projectRoom } from "./lib/realtime";
import { projectKey } from "./lib/variables";

/** Thrown to the runtime for any refused token; the reason stays here. */
const REFUSED = "runtime token refused";

/** Longest stored line from a tail event. */
const MAX_TAIL_LINE = 4096;

/** The Cloudflare deployment a runtime's current generation runs. */
async function currentCfDeployment(
  db: Db,
  serviceId: string,
  environmentId: string,
  generation: number,
) {
  const [row] = await db
    .select({ deploymentId: cfDeployments.deploymentId })
    .from(cfDeployments)
    .where(
      and(
        eq(cfDeployments.serviceId, serviceId),
        eq(cfDeployments.environmentId, environmentId),
        eq(cfDeployments.runtimeGeneration, generation),
      ),
    )
    .orderBy(desc(cfDeployments.updatedAt))
    .limit(1);
  return row;
}

/**
 * Verifies a runtime token and returns the environment of the deployment
 * its generation runs.
 *
 * @param env - Bindings (database, master keyring).
 * @param token - The script's `RH_RUNTIME_TOKEN`, as presented.
 * @returns The variables and the deployment ID.
 * @throws {Error} `runtime token refused` for a malformed, forged or stale
 *   token, or a runtime that is not serving.
 */
export async function resolveRuntimeEnv(env: Env, token: unknown): Promise<RuntimeEnvResolution> {
  const claims = await verifyRuntimeToken(env, token);
  if (!claims) throw new Error(REFUSED);
  const db = createDb(env.DB);
  const runtime = await db.query.cfRuntimes.findFirst({
    where: and(
      eq(cfRuntimes.serviceId, claims.serviceId),
      eq(cfRuntimes.environmentId, claims.environmentId),
    ),
  });
  if (runtime?.status !== "active" || runtime.generation !== claims.generation) {
    throw new Error(REFUSED);
  }
  const cfd = await currentCfDeployment(
    db,
    claims.serviceId,
    claims.environmentId,
    claims.generation,
  );
  if (!cfd) throw new Error(REFUSED);
  const [row] = await db
    .select({
      envSealed: deployments.envSealed,
      projectId: projects.id,
      workspaceId: projects.workspaceId,
    })
    .from(deployments)
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .where(eq(deployments.id, cfd.deploymentId))
    .limit(1);
  if (!row?.envSealed) throw new Error(REFUSED);
  const key = await projectKey(db, env, row.projectId);
  const opened = await openDeploymentEnv(key, row.envSealed as Sealed, {
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    deploymentId: cfd.deploymentId,
  });
  // NOTE: \`mount_as_file\` variables have no file mount on Cloudflare; they
  // are not passed (docs/cloudflare-containers.md, "Limitations").
  return { env: opened.env, deployment_id: cfd.deploymentId };
}

/**
 * The entrypoint runtime scripts bind as `CONTROL` (ADR 0011). Exported from
 * the Worker's main module by name; it has no `fetch`, so it can't be
 * reached over HTTP.
 */
export class RuntimeEnv extends WorkerEntrypoint<Env> {
  /**
   * Resolves a cold-starting container's environment.
   *
   * @param token - The script's `RH_RUNTIME_TOKEN`.
   * @returns The variables and the deployment ID.
   */
  async resolveEnv(token: string): Promise<RuntimeEnvResolution> {
    return resolveRuntimeEnv(this.env, token);
  }
}

// -----------------------------------------------------------------------------
// Tail
// -----------------------------------------------------------------------------

/** The parts of a tail event this handler reads (`TraceItem`). */
export interface RuntimeTraceItem {
  scriptName: string | null;
  eventTimestamp?: number | null;
  logs: { timestamp: number; level: string; message: unknown }[];
  exceptions: { timestamp: number; name: string; message: string }[];
}

function textOf(message: unknown): string {
  const parts = Array.isArray(message) ? message : [message];
  return parts
    .map((p) =>
      typeof p === "string"
        ? p
        : (() => {
            try {
              return JSON.stringify(p);
            } catch {
              return String(p);
            }
          })(),
    )
    .join(" ")
    .slice(0, MAX_TAIL_LINE);
}

/**
 * Stores runtime scripts' console output and exceptions as `system` log
 * lines of the deployment each script currently runs, redacted with that
 * deployment's secret set, and fans them out to the project's sockets.
 * Events of scripts that aren't runtime scripts are ignored.
 *
 * @param env - Bindings.
 * @param events - Tail events.
 * @returns Lines stored.
 */
export async function storeRuntimeTail(
  env: Env,
  events: readonly RuntimeTraceItem[],
): Promise<number> {
  const db = createDb(env.DB);
  const byScript = new Map<string, StoredLogLine[]>();
  for (const e of events) {
    if (!e.scriptName?.startsWith("rh-")) continue;
    const lines = byScript.get(e.scriptName) ?? [];
    for (const l of e.logs) {
      lines.push({ ts: l.timestamp, stream: "system", text: `[${l.level}] ${textOf(l.message)}` });
    }
    for (const x of e.exceptions) {
      lines.push({
        ts: x.timestamp,
        stream: "system",
        text: `[exception] ${x.name}: ${x.message}`.slice(0, MAX_TAIL_LINE),
      });
    }
    byScript.set(e.scriptName, lines);
  }
  let stored = 0;
  for (const [scriptName, raw] of byScript) {
    if (!raw.length) continue;
    const runtime = await db.query.cfRuntimes.findFirst({
      where: eq(cfRuntimes.scriptName, scriptName),
    });
    if (!runtime) continue;
    const cfd = await currentCfDeployment(
      db,
      runtime.serviceId,
      runtime.environmentId,
      runtime.generation,
    );
    const deploymentId = cfd?.deploymentId ?? runtime.activeDeploymentId;
    if (!deploymentId) continue;
    const [owner] = await db
      .select({ projectId: services.projectId })
      .from(services)
      .where(eq(services.id, runtime.serviceId))
      .limit(1);
    if (!owner) continue;
    const { needles } = env.MASTER_KEY?.trim()
      ? await deploymentRedaction(db, env, deploymentId, false)
      : { needles: [] as string[] };
    const lines = raw
      .map((l) => ({ ...l, text: redact(l.text, needles) }))
      .sort((a, b) => a.ts - b.ts);
    const id = newId("logChunk");
    const r2Key = logChunkKey(owner.projectId, runtime.serviceId, lines[0]!.ts, id);
    const body = toNdjson(lines);
    await env.LOGS.put(r2Key, body, { httpMetadata: { contentType: "application/x-ndjson" } });
    await db.insert(logChunks).values({
      id,
      projectId: owner.projectId,
      serviceId: runtime.serviceId,
      deploymentId,
      buildId: null,
      cronRunId: null,
      r2Key,
      firstTs: new Date(lines[0]!.ts),
      lastTs: new Date(lines[lines.length - 1]!.ts),
      lineCount: lines.length,
      bytes: new TextEncoder().encode(body).byteLength,
    });
    stored += lines.length;
    try {
      await projectRoom(env, owner.projectId).publishLogs(
        runtime.serviceId,
        {
          type: "runtime",
          deployment_id: deploymentId,
          workload_id: scriptName.replace(/^rh-/, "cfw_"),
        },
        lines as LogLine[],
      );
    } catch (err) {
      console.warn("runtime log fan-out failed", err instanceof Error ? err.name : "error");
    }
  }
  return stored;
}
