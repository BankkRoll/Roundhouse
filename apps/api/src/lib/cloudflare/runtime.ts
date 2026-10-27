/**
 * Operations on the Cloudflare resources of one service-environment (ADR
 * 0011 "Runtime Worker" and "Deploy and switching"), shared by the deploy
 * workflow, change-set apply, the status route and the minute tick:
 * - {@link ensureRuntimeRow}: the `cf_runtimes` row, created on first use;
 * - {@link runtimeHostnames}: the hostnames Worker routes send to the script;
 * - {@link uploadRuntime}: the runtime script with this generation's
 *   `RH_CONFIG` and token, `workers.dev` on, and its Durable Object namespace;
 * - {@link switchRoutes} / {@link removeRoutes}: list-then-create Worker routes;
 * - {@link disableRuntime}: routes removed, `max_instances` 0, generation
 *   bumped (switch back to nodes, or `deploy.replicas = 0`);
 * - {@link claimCloudflareDeletions}: the minute tick deletes script and
 *   application of runtimes disabled for 24 h;
 * - {@link collectImageTags}: keeps the newest tags of a script's repository.
 *
 * SECURITY: the runtime token is minted here on demand and only ever sent
 * to Cloudflare as the script's `secret_text`; nothing here logs it.
 *
 * @module
 */
import { cfDeployments, cfRuntimes, createDb, type Db, domains } from "@roundhouse/db";
import { and, desc, eq, isNotNull, lte, ne } from "drizzle-orm";
import {
  RUNTIME_BINDINGS,
  RUNTIME_DO_CLASS,
  RUNTIME_MAIN_MODULE,
  RUNTIME_WORKER_SOURCE,
  type RuntimeConfig,
} from "../../cf-runtime";
import type { Env } from "../../env";
import { CLOUDFLARE_REGISTRY_HOST, type CloudflareClient, CloudflareProviderError } from "./client";
import { mintRuntimeToken } from "./runtime-token";
import { clientFor, loadCloudflareAccount } from "./settings";

/**
 * The control plane's Worker name (`name` in `wrangler.jsonc`): the runtime
 * script's `CONTROL` service binding and tail consumer point at it.
 */
export const CONTROL_PLANE_WORKER_NAME = "roundhouse";

/** Entrypoint of the control plane the `CONTROL` binding targets. */
export const RUNTIME_ENV_ENTRYPOINT = "RuntimeEnv";

/** `compatibility_date` of the runtime script; matches the control plane's. */
export const RUNTIME_COMPATIBILITY_DATE = "2026-10-19";

/** Analytics Engine dataset the runtime writes `edge_request` rows to (ADR 0008). */
export const RUNTIME_METRICS_DATASET = "roundhouse_metrics";

/** How long a disabled runtime is kept for a quick switch back (ADR 0011). */
export const CLOUDFLARE_DELETE_GRACE_MS = 24 * 60 * 60 * 1000;

/** Least drain after a route change, for route propagation (ADR 0011). */
export const MIN_CLOUDFLARE_DRAIN_S = 30;

/** Image tags kept per script, which is what rollback needs (ADR 0011 "Garbage"). */
export const KEEP_IMAGE_TAGS = 5;

/** Runtimes one tick deletes; matches the dispatch batch size. */
const DELETIONS_PER_TICK = 100;

/** Lease a claimed deletion holds before another tick may retry it. */
const DELETION_LEASE_MS = 10 * 60 * 1000;

/** A `cf_runtimes` row. */
export type CfRuntimeRow = typeof cfRuntimes.$inferSelect;

/** A `cf_deployments` row. */
export type CfDeploymentRow = typeof cfDeployments.$inferSelect;

/**
 * The runtime row of a service-environment, created (disabled, generation
 * 0) when missing.
 *
 * @param db - Database client.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @param scriptName - From `cloudflareScriptName`.
 * @returns The row.
 */
export async function ensureRuntimeRow(
  db: Db,
  serviceId: string,
  environmentId: string,
  scriptName: string,
): Promise<CfRuntimeRow> {
  await db
    .insert(cfRuntimes)
    .values({ serviceId, environmentId, scriptName, status: "disabled" })
    .onConflictDoNothing();
  const row = await runtimeOf(db, serviceId, environmentId);
  if (!row) throw new Error("cf_runtimes row vanished");
  return row;
}

/**
 * The runtime row of a service-environment.
 *
 * @param db - Database client.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @returns The row, or `undefined`.
 */
export async function runtimeOf(
  db: Db,
  serviceId: string,
  environmentId: string,
): Promise<CfRuntimeRow | undefined> {
  return db.query.cfRuntimes.findFirst({
    where: and(eq(cfRuntimes.serviceId, serviceId), eq(cfRuntimes.environmentId, environmentId)),
  });
}

/**
 * Hostnames Worker routes send to the runtime: the generated hostname and
 * every verified Cloudflare-for-SaaS custom domain. Direct-mode custom
 * domains are refused by eligibility.
 *
 * @param db - Database client.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @returns Lowercased hostnames, sorted.
 */
export async function runtimeHostnames(
  db: Db,
  serviceId: string,
  environmentId: string,
): Promise<string[]> {
  const rows = await db
    .select({
      hostname: domains.hostname,
      type: domains.type,
      mode: domains.mode,
      verification: domains.verificationStatus,
    })
    .from(domains)
    .where(and(eq(domains.serviceId, serviceId), eq(domains.environmentId, environmentId)));
  return rows
    .filter(
      (d) =>
        d.type === "generated" || (d.mode === "cloudflare_saas" && d.verification === "verified"),
    )
    .map((d) => d.hostname.toLowerCase())
    .sort();
}

/**
 * The script's `workers.dev` URL.
 *
 * @param scriptName - The runtime script.
 * @param subdomain - The account's `workers.dev` subdomain.
 * @param path - Path to request, starting with `/`.
 * @returns e.g. `https://rh-abc.acme.workers.dev/healthz`.
 */
export function workersDevUrl(scriptName: string, subdomain: string, path = "/"): string {
  return `https://${scriptName}.${subdomain}.workers.dev${path}`;
}

/**
 * Uploads the runtime script for one generation and makes sure its
 * Durable Object namespace exists.
 *
 * The `AppContainer` migration is sent only when the namespace does not
 * exist yet, so it is sent exactly once per script even when a step retries
 * after a successful upload.
 *
 * @param client - Client of the configured account.
 * @param env - Bindings with the master key (for the runtime token).
 * @param input - Script name, `RH_CONFIG`, and the namespace when known.
 * @returns The Durable Object namespace ID of `(script, AppContainer)`.
 * @throws {CloudflareProviderError} When Cloudflare refuses a call.
 */
export async function uploadRuntime(
  client: CloudflareClient,
  env: Pick<Env, "MASTER_KEY" | "MASTER_KEYS_PREVIOUS">,
  input: { scriptName: string; config: RuntimeConfig; namespaceId: string | null },
): Promise<string> {
  const findNamespace = async () =>
    (await client.listDurableObjectNamespaces()).find(
      (n) => n.script === input.scriptName && n.class === RUNTIME_DO_CLASS,
    )?.id ?? null;
  const existing = input.namespaceId ?? (await findNamespace());
  const token = await mintRuntimeToken(env, {
    serviceId: input.config.service_id,
    environmentId: input.config.environment_id,
    generation: input.config.generation,
  });
  await client.uploadScript(
    input.scriptName,
    {
      main_module: RUNTIME_MAIN_MODULE,
      compatibility_date: RUNTIME_COMPATIBILITY_DATE,
      bindings: [
        {
          type: "durable_object_namespace",
          name: RUNTIME_BINDINGS.app,
          class_name: RUNTIME_DO_CLASS,
        },
        {
          type: "service",
          name: RUNTIME_BINDINGS.control,
          service: CONTROL_PLANE_WORKER_NAME,
          entrypoint: RUNTIME_ENV_ENTRYPOINT,
        },
        { type: "secret_text", name: RUNTIME_BINDINGS.token, text: token },
        { type: "plain_text", name: RUNTIME_BINDINGS.config, text: JSON.stringify(input.config) },
        {
          type: "analytics_engine",
          name: RUNTIME_BINDINGS.metrics,
          dataset: RUNTIME_METRICS_DATASET,
        },
      ],
      ...(existing ? {} : { migrations: { new_sqlite_classes: [RUNTIME_DO_CLASS] } }),
      tail_consumers: [{ service: CONTROL_PLANE_WORKER_NAME }],
    },
    [
      {
        name: RUNTIME_MAIN_MODULE,
        content: RUNTIME_WORKER_SOURCE,
        contentType: "application/javascript+module",
      },
    ],
  );
  await client.enableWorkersDev(input.scriptName);
  const namespaceId = existing ?? (await findNamespace());
  if (!namespaceId) {
    throw new CloudflareProviderError(
      `Uploading the runtime script: Cloudflare created no Durable Object namespace for ${RUNTIME_DO_CLASS}`,
      200,
    );
  }
  return namespaceId;
}

/**
 * Points `<hostname>/*` at the script for every hostname, list-then-create
 * so a retry never duplicates a route, and deletes this script's routes for
 * hostnames no longer served.
 *
 * @param client - Client of the configured account.
 * @param zoneId - The apps zone.
 * @param scriptName - The runtime script.
 * @param hostnames - Hostnames to route.
 * @param current - `{hostname: route_id}` routes created before.
 * @returns The new `{hostname: route_id}`.
 */
export async function switchRoutes(
  client: CloudflareClient,
  zoneId: string,
  scriptName: string,
  hostnames: readonly string[],
  current: Record<string, string>,
): Promise<Record<string, string>> {
  const existing = await client.listRoutes(zoneId);
  const byPattern = new Map(existing.map((r) => [r.pattern, r]));
  const next: Record<string, string> = {};
  for (const host of hostnames) {
    const pattern = `${host}/*`;
    const found = byPattern.get(pattern);
    if (found?.script === scriptName) next[host] = found.id;
    else if (found)
      next[host] = (await client.updateRoute(zoneId, found.id, pattern, scriptName)).id;
    else next[host] = (await client.createRoute(zoneId, pattern, scriptName)).id;
  }
  for (const [host, id] of Object.entries(current)) {
    if (!(host in next)) await client.deleteRoute(zoneId, id);
  }
  return next;
}

/**
 * Deletes Worker routes, so traffic falls through to the origin (the
 * ingress nodes). Routes already gone are fine.
 *
 * @param client - Client of the configured account.
 * @param zoneId - The apps zone.
 * @param routeIds - `{hostname: route_id}`.
 */
export async function removeRoutes(
  client: CloudflareClient,
  zoneId: string,
  routeIds: Record<string, string>,
): Promise<void> {
  for (const id of Object.values(routeIds)) await client.deleteRoute(zoneId, id);
}

/**
 * Stops a runtime serving: routes deleted, `max_instances` 0, generation
 * bumped (which invalidates the script's runtime token), status `disabled`.
 * Its active Cloudflare deployment becomes `removed`. Nothing is deleted
 * unless `deleteAfter` is set, after which the minute tick deletes it.
 *
 * @param env - Bindings.
 * @param db - Database client.
 * @param row - The runtime.
 * @param options - `deleteAfter`: when the tick may delete it; `null` keeps it.
 *   `skipRoutes`: the routes were already removed.
 */
export async function disableRuntime(
  env: Env,
  db: Db,
  row: CfRuntimeRow,
  options: { deleteAfter: Date | null; skipRoutes?: boolean },
): Promise<void> {
  const account = await loadCloudflareAccount(db, env);
  if (account) {
    const client = clientFor(account);
    if (!options.skipRoutes && account.apps_zone) {
      await removeRoutes(client, account.apps_zone.id, row.routeIds);
    }
    if (row.applicationId) await client.patchApplication(row.applicationId, { max_instances: 0 });
  }
  const now = new Date();
  await db.batch([
    db
      .update(cfRuntimes)
      .set({
        status: "disabled",
        generation: row.generation + 1,
        routeIds: {},
        disabledAt: now,
        deleteAfter: options.deleteAfter,
        updatedAt: now,
      })
      .where(
        and(
          eq(cfRuntimes.serviceId, row.serviceId),
          eq(cfRuntimes.environmentId, row.environmentId),
        ),
      ),
    db
      .update(cfDeployments)
      .set({ status: "removed", updatedAt: now })
      .where(
        and(
          eq(cfDeployments.serviceId, row.serviceId),
          eq(cfDeployments.environmentId, row.environmentId),
          eq(cfDeployments.status, "active"),
        ),
      ),
  ]);
}

/**
 * `deploy.replicas = 0` on a Cloudflare-provider service: stops serving
 * (routes removed, `max_instances` 0) without deleting anything; the next
 * deployment with replicas brings it back. Best effort: a Cloudflare error
 * is logged and the runtime stays as it was.
 *
 * @param env - Bindings.
 * @param db - Database client.
 * @param serviceId - The service.
 * @param environmentId - The environment.
 * @returns Whether a serving runtime was paused.
 */
export async function pauseCloudflareRuntime(
  env: Env,
  db: Db,
  serviceId: string,
  environmentId: string,
): Promise<boolean> {
  const row = await runtimeOf(db, serviceId, environmentId);
  if (row?.status !== "active") return false;
  try {
    await disableRuntime(env, db, row, { deleteAfter: null });
    return true;
  } catch (err) {
    console.error(
      "cloudflare runtime pause failed",
      row.scriptName,
      err instanceof Error ? err.message : "error",
    );
    return false;
  }
}

/**
 * Minute tick claimer: deletes the script and application of runtimes
 * disabled past their `delete_after`, then the runtime row. Each row is
 * claimed by moving `delete_after` forward by a lease, so overlapping
 * ticks never both act on it and a failure is retried after the lease.
 *
 * @param env - Bindings.
 * @param now - The tick's time, unix ms.
 * @returns How many runtimes were deleted.
 */
export async function claimCloudflareDeletions(env: Env, now: number): Promise<number> {
  const db = createDb(env.DB);
  const due = await db
    .select()
    .from(cfRuntimes)
    .where(
      and(
        eq(cfRuntimes.status, "disabled"),
        isNotNull(cfRuntimes.deleteAfter),
        lte(cfRuntimes.deleteAfter, new Date(now)),
      ),
    )
    .limit(DELETIONS_PER_TICK);
  if (!due.length) return 0;
  const account = await loadCloudflareAccount(db, env);
  if (!account) return 0;
  const client = clientFor(account);
  let deleted = 0;
  for (const row of due) {
    const [claimed] = await db
      .update(cfRuntimes)
      .set({ deleteAfter: new Date(now + DELETION_LEASE_MS) })
      .where(
        and(
          eq(cfRuntimes.serviceId, row.serviceId),
          eq(cfRuntimes.environmentId, row.environmentId),
          eq(cfRuntimes.status, "disabled"),
          eq(cfRuntimes.deleteAfter, row.deleteAfter!),
        ),
      )
      .returning();
    if (!claimed) continue;
    try {
      if (claimed.applicationId) await client.deleteApplication(claimed.applicationId);
      await client.deleteScript(claimed.scriptName);
      await db
        .delete(cfRuntimes)
        .where(
          and(
            eq(cfRuntimes.serviceId, row.serviceId),
            eq(cfRuntimes.environmentId, row.environmentId),
            eq(cfRuntimes.status, "disabled"),
          ),
        );
      deleted++;
    } catch (err) {
      console.error(
        "cloudflare runtime deletion failed",
        claimed.scriptName,
        err instanceof Error ? err.message : "error",
      );
    }
  }
  return deleted;
}

/**
 * Deletes the script repository's tags beyond the {@link KEEP_IMAGE_TAGS}
 * newest pushed ones, best effort.
 *
 * TODO: the managed registry's support for manifest deletion through the
 * Docker Registry API is unverified; until a live account confirms it this
 * may fail, which only leaves old tags in the 50 GB account storage.
 *
 * @param db - Database client.
 * @param client - Client of the configured account.
 * @param runtime - Service, environment and script.
 * @returns How many tags were deleted.
 */
export async function collectImageTags(
  db: Db,
  client: CloudflareClient,
  runtime: Pick<CfRuntimeRow, "serviceId" | "environmentId" | "scriptName">,
): Promise<number> {
  const prefix = `${CLOUDFLARE_REGISTRY_HOST}/${client.accountId}/${runtime.scriptName}:`;
  const pushed = await db
    .select({ imageRef: cfDeployments.imageRef })
    .from(cfDeployments)
    .where(
      and(
        eq(cfDeployments.serviceId, runtime.serviceId),
        eq(cfDeployments.environmentId, runtime.environmentId),
        isNotNull(cfDeployments.imageDigest),
        ne(cfDeployments.status, "failed"),
      ),
    )
    .orderBy(desc(cfDeployments.createdAt));
  const keep = new Set(
    pushed
      .filter((p) => p.imageRef.startsWith(prefix))
      .slice(0, KEEP_IMAGE_TAGS)
      .map((p) => p.imageRef.slice(prefix.length)),
  );
  const creds = await client.registryCredentials(["pull", "push"]);
  const tags = await client.listTags(creds, runtime.scriptName);
  let deleted = 0;
  for (const tag of tags) {
    if (keep.has(tag)) continue;
    await client.deleteTag(creds, runtime.scriptName, tag);
    deleted++;
  }
  return deleted;
}
