/**
 * Pull request preview routes (ADR 0007, "Routes, RBAC, audit"): a
 * project's preview settings, its previews, and approving, redeploying and
 * tearing one down. Previews themselves are created by the GitHub webhook
 * (`pull_request` events), never through these routes.
 *
 * Deviations from the ADR's table:
 * - `GET /v1/previews/{previewId}` (not in the ADR) returns one preview, for
 *   the dashboard and the CLI.
 * - `POST …/approve` takes the `head_sha` the approver saw, so a push that
 *   lands between looking and clicking is never approved unseen (409
 *   `head_moved`).
 * - `DELETE /v1/environments/{environmentId}` is not part of this change;
 *   `DELETE /v1/previews/{previewId}` tears a preview's environment down.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import {
  DEFAULT_PREVIEW_APPROVAL_LABEL,
  DEFAULT_PREVIEW_CAPS,
  DEPLOYMENT_STATUSES,
  PREVIEW_DATABASE_SEEDS,
  PREVIEW_FORK_POLICIES,
  PREVIEW_LIMITS,
  PREVIEW_SAME_REPO_SECRETS,
  PREVIEW_STATUSES,
} from "@roundhouse/shared";
import { body, errors, json, Millis, sessionAuth } from "../schemas";
import { ProjectParams } from "./params";
import { defineRoute, session } from "./policy";

// -----------------------------------------------------------------------------
// Schemas
// -----------------------------------------------------------------------------

/** `{previewId}` path param. */
export const PreviewParams = z.object({ previewId: z.string() });

const L = PREVIEW_LIMITS;

/** Node labels: the same key and value rules as a placement selector. */
const NodeSelectorField = z
  .record(z.string().min(1).max(63), z.string().max(63))
  .refine((r) => Object.keys(r).length <= 16, { message: "at most 16 labels" });

/** Upper bounds on each preview service's resources. */
export const PreviewCapsSchema = z
  .object({
    replicas: z.number().int().min(L.replicas.min).max(L.replicas.max),
    cpu_millis: z.number().int().min(L.cpuMillis.min).max(L.cpuMillis.max),
    memory_mb: z.number().int().min(L.memoryMb.min).max(L.memoryMb.max),
    volume_mb: z.number().int().min(L.volumeMb.min).max(L.volumeMb.max),
  })
  .openapi("PreviewCaps");

/**
 * A GitHub label name: 1 to 50 characters. Commas are refused because the
 * labels API splits on them.
 */
const LabelField = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .refine((s) => !s.includes(","), { message: "must not contain a comma" });

/** Body of `PUT /v1/projects/{projectId}/preview-settings`. */
export const PreviewSettingsInputSchema = z
  .object({
    enabled: z.boolean(),
    /** Copied by every preview; not a preview environment itself. */
    base_environment_id: z.string(),
    /**
     * Git services built at the PR's head. `null` (the default) means every
     * git service of the base environment.
     */
    services: z.array(z.string()).max(100).nullable().default(null),
    ttl_hours: z.number().int().min(L.ttlHours.min).max(L.ttlHours.max).default(L.ttlHours.default),
    max_active: z
      .number()
      .int()
      .min(L.maxActive.min)
      .max(L.maxActive.max)
      .default(L.maxActive.default),
    caps: PreviewCapsSchema.default(DEFAULT_PREVIEW_CAPS),
    skip_drafts: z.boolean().default(true),
    same_repo_secrets: z.enum(PREVIEW_SAME_REPO_SECRETS).default("copy"),
    /**
     * `approval` needs `build_node_selector`: fork code then builds only on
     * those nodes, never on one that builds the project's other environments.
     */
    fork_policy: z.enum(PREVIEW_FORK_POLICIES).default("disabled"),
    approval_label: LabelField.default(DEFAULT_PREVIEW_APPROVAL_LABEL),
    database_seed: z.enum(PREVIEW_DATABASE_SEEDS).default("empty"),
    node_selector: NodeSelectorField.default({}),
    build_node_selector: NodeSelectorField.default({}),
    comment: z.boolean().default(true),
  })
  .openapi("PreviewSettingsInput");

/** A project's preview settings, or the defaults while it has none. */
export const PreviewSettingsSchema = z
  .object({
    project_id: z.string(),
    /** `false` until the settings were saved once. */
    configured: z.boolean(),
    enabled: z.boolean(),
    base_environment_id: z.string().nullable(),
    services: z.array(z.string()).nullable(),
    ttl_hours: z.number().int(),
    max_active: z.number().int(),
    caps: PreviewCapsSchema,
    skip_drafts: z.boolean(),
    same_repo_secrets: z.enum(PREVIEW_SAME_REPO_SECRETS),
    fork_policy: z.enum(PREVIEW_FORK_POLICIES),
    approval_label: z.string(),
    database_seed: z.enum(PREVIEW_DATABASE_SEEDS),
    node_selector: z.record(z.string(), z.string()),
    build_node_selector: z.record(z.string(), z.string()),
    comment: z.boolean(),
    /**
     * Whether this instance has received a `pull_request` delivery. Apps
     * created before previews must subscribe to the event in GitHub.
     */
    pull_request_events_seen: z.boolean(),
    updated_at: Millis.nullable(),
  })
  .openapi("PreviewSettings");

/** One service of a preview: its link and latest deployment. */
export const PreviewServiceSchema = z
  .object({
    service_id: z.string(),
    slug: z.string(),
    name: z.string(),
    /** Public URL of its generated domain, if it has one. */
    url: z.string().nullable(),
    deployment_id: z.string().nullable(),
    status: z.enum(DEPLOYMENT_STATUSES).nullable(),
    commit_sha: z.string().nullable(),
  })
  .openapi("PreviewService");

/** A pull request's preview of a project. */
export const PreviewSchema = z
  .object({
    id: z.string(),
    project_id: z.string(),
    /** `null` while gated, queued, or after teardown. */
    environment_id: z.string().nullable(),
    environment_slug: z.string().nullable(),
    repo_full_name: z.string(),
    pr_number: z.number().int(),
    pr_url: z.string(),
    title: z.string(),
    head_ref: z.string(),
    head_sha: z.string(),
    /** `null` when the fork was deleted. */
    head_repo_full_name: z.string().nullable(),
    is_fork: z.boolean(),
    /** Secrets were replaced by empty placeholders. */
    withheld: z.boolean(),
    author_login: z.string(),
    author_association: z.string(),
    draft: z.boolean(),
    status: z.enum(PREVIEW_STATUSES),
    approved_sha: z.string().nullable(),
    approved_by_login: z.string().nullable(),
    last_activity_at: Millis,
    expires_at: Millis.nullable(),
    closed_at: Millis.nullable(),
    /** Why creating failed. Never a variable value or build output. */
    error: z.string().nullable(),
    services: z.array(PreviewServiceSchema),
    created_at: Millis,
    updated_at: Millis,
  })
  .openapi("Preview");

/** Query of the preview list. */
export const PreviewListQuery = z.object({
  /** `open` (default): everything not `closed` or `expired`. */
  status: z.enum(["open", "all"]).default("open"),
});

/** Body of `POST /v1/previews/{previewId}/approve`. */
export const ApprovePreviewBody = z
  .object({
    /** The head the approver looked at; 409 `head_moved` when the PR moved on. */
    head_sha: z.string().regex(/^([a-f0-9]{40}|[a-f0-9]{64})$/),
  })
  .openapi("ApprovePreview");

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

/** A project's preview settings (the defaults when none were saved). */
export const getPreviewSettings = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/projects/{projectId}/preview-settings",
  tags: ["previews"],
  summary: "Get preview settings",
  security: sessionAuth,
  request: { params: ProjectParams },
  responses: { 200: json(PreviewSettingsSchema), ...errors(401, 403, 404) },
});

/** Saves a project's preview settings. */
export const putPreviewSettings = defineRoute(
  session("previews:manage", ["preview.settings_updated"]),
  {
    method: "put",
    path: "/v1/projects/{projectId}/preview-settings",
    tags: ["previews"],
    summary: "Save preview settings",
    security: sessionAuth,
    request: { params: ProjectParams, ...body(PreviewSettingsInputSchema) },
    responses: { 200: json(PreviewSettingsSchema), ...errors(400, 401, 403, 404) },
  },
);

/** A project's previews, newest PR activity first. */
export const listPreviews = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/projects/{projectId}/previews",
  tags: ["previews"],
  summary: "List previews",
  security: sessionAuth,
  request: { params: ProjectParams, query: PreviewListQuery },
  responses: {
    200: json(z.object({ previews: z.array(PreviewSchema) })),
    ...errors(400, 401, 403, 404),
  },
});

/** One preview. */
export const getPreview = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/previews/{previewId}",
  tags: ["previews"],
  summary: "Get a preview",
  security: sessionAuth,
  request: { params: PreviewParams },
  responses: { 200: json(PreviewSchema), ...errors(401, 403, 404) },
});

/**
 * Approves a fork PR's current head, as the approval label does, and adds
 * the label on GitHub so the decision shows there. The preview is then
 * created or deployed. 409 `head_moved` when `head_sha` is no longer the
 * head; 409 when the preview needs no approval.
 */
export const approvePreview = defineRoute(session("previews:manage", ["preview.approved"]), {
  method: "post",
  path: "/v1/previews/{previewId}/approve",
  tags: ["previews"],
  summary: "Approve a fork pull request's preview",
  security: sessionAuth,
  request: { params: PreviewParams, ...body(ApprovePreviewBody) },
  responses: { 200: json(PreviewSchema), ...errors(400, 401, 403, 404, 409) },
});

/** Deploys the preview's git services again at the PR's head. 409 unless it is active. */
export const redeployPreview = defineRoute(session("deployments:create", ["deployment.created"]), {
  method: "post",
  path: "/v1/previews/{previewId}/redeploy",
  tags: ["previews"],
  summary: "Redeploy a preview",
  security: sessionAuth,
  request: { params: PreviewParams },
  responses: { 200: json(PreviewSchema), ...errors(401, 403, 404, 409) },
});

/**
 * Tears a preview down: its deployments stop, its volumes are scheduled for
 * deletion, its domains go, and it becomes `closed`. A later push or reopen
 * of the PR creates it again.
 */
export const deletePreview = defineRoute(session("environments:manage", ["preview.deleted"]), {
  method: "delete",
  path: "/v1/previews/{previewId}",
  tags: ["previews"],
  summary: "Tear down a preview",
  security: sessionAuth,
  request: { params: PreviewParams },
  responses: { 200: json(PreviewSchema), ...errors(401, 403, 404) },
});

/** Every preview route, for the contract tests. */
export const PREVIEW_ROUTES = {
  getPreviewSettings,
  putPreviewSettings,
  listPreviews,
  getPreview,
  approvePreview,
  redeployPreview,
  deletePreview,
} as const;

/** A preview. */
export type Preview = z.infer<typeof PreviewSchema>;
/** A project's preview settings. */
export type PreviewSettings = z.infer<typeof PreviewSettingsSchema>;
