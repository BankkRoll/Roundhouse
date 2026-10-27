/**
 * Cloudflare Containers as a service runtime (ADR 0011):
 * - `cf_runtimes`: the runtime Worker, Durable Object namespace, container
 *   application and Worker routes of one service-environment, kept across
 *   deployments (and for 24 h after switching back to nodes, so a quick
 *   return reuses them);
 * - `cf_deployments`: what one deployment pushed and rolled out.
 *
 * Nothing here holds a secret. The runtime token is derived from the master
 * key and `generation` on demand; environments stay sealed in `deployments`.
 *
 * @module
 */
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { id, json, timestamp, timestamps } from "./columns";
import { deployments } from "./deployments";
import { environments, services } from "./projects";

/** Lifecycle of one Cloudflare deployment (ADR 0011). */
export type CfDeploymentStatus =
  | "pushing"
  | "uploading"
  | "rolling_out"
  | "warming"
  | "routing"
  | "active"
  | "removed"
  | "failed";

/** Whether a service-environment's Cloudflare runtime serves traffic. */
export type CfRuntimeStatus = "active" | "disabled";

/** The Cloudflare resources of one service in one environment. */
export const cfRuntimes = sqliteTable(
  "cf_runtimes",
  {
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    /** `rh-<hash>`; see the API's `cloudflareScriptName`. */
    scriptName: text("script_name").notNull().unique(),
    namespaceId: text("namespace_id"),
    applicationId: text("application_id"),
    /**
     * Bumped on every Cloudflare deploy and on disable; the runtime token
     * and warm-up HMAC are bound to it, so older ones stop working.
     */
    generation: integer("generation").notNull().default(0),
    /** `{hostname: route_id}` of the Worker routes that send traffic here. */
    routeIds: json<Record<string, string>>("route_ids").notNull().default(sql`'{}'`),
    status: text("status").$type<CfRuntimeStatus>().notNull(),
    activeDeploymentId: text("active_deployment_id"),
    /** When traffic moved back to nodes. */
    disabledAt: timestamp("disabled_at"),
    /** The minute tick deletes the script and application after this. */
    deleteAfter: timestamp("delete_after"),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.serviceId, t.environmentId] }),
    index("cf_runtimes_delete_idx").on(t.deleteAfter).where(sql`delete_after IS NOT NULL`),
  ],
);

/** What one Cloudflare-provider deployment pushed and rolled out. */
export const cfDeployments = sqliteTable(
  "cf_deployments",
  {
    /** `cfd_…`. */
    id: id(),
    deploymentId: text("deployment_id")
      .notNull()
      .unique()
      .references(() => deployments.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => services.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    scriptName: text("script_name").notNull(),
    namespaceId: text("namespace_id"),
    applicationId: text("application_id"),
    /** The image the application runs: a pushed tag, or a direct registry reference. */
    imageRef: text("image_ref").notNull(),
    imageDigest: text("image_digest"),
    /** `psh_…` of the builder's `image_push`, for git builds. */
    pushId: text("push_id"),
    /**
     * The builder node `image_push` was sent to; only its
     * `image_push_result` is accepted for this push.
     */
    pushNodeId: text("push_node_id"),
    runtimeGeneration: integer("runtime_generation").notNull(),
    instanceType: text("instance_type").notNull(),
    maxInstances: integer("max_instances").notNull(),
    routeIds: json<Record<string, string>>("route_ids"),
    status: text("status").$type<CfDeploymentStatus>().notNull(),
    /** The Cloudflare API's error, verbatim, when `failed`. */
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    index("cf_deployments_service_idx").on(t.serviceId, t.environmentId, t.createdAt),
    index("cf_deployments_push_idx").on(t.pushId),
  ],
);
