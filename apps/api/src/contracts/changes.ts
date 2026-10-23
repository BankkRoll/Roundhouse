/**
 * Project canvas and staged change routes (ADR 0006).
 *
 * A change set holds ops against one environment. Each environment has one
 * shared dashboard draft (`/draft`); the API and MCP may open separate sets.
 * Staging checks each op's action against the project; applying checks it
 * again for the applier against the target environment, so protection rules
 * apply exactly as on the direct routes (ADR 0014).
 *
 * Routes declare `projects:read` as their entry check because the action
 * that matters depends on the ops in the body or the set; handlers check
 * those per op.
 *
 * SECURITY: A staged `variable.set` takes a plaintext `value` on input
 * only. Responses carry its key, tier and fingerprint, never the value.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import {
  CHANGE_SET_SOURCES,
  MAX_STAGED_OPS,
  NEW_SERVICE_REF_RE,
  SERVICE_KINDS,
  STAGED_CHANGE_STATUSES,
  VARIABLE_SCOPES,
} from "@roundhouse/shared";
import {
  body,
  CanvasPositionSchema,
  CanvasPositionsSchema,
  ChangeSetSummarySchema,
  errors,
  json,
  NameField,
  ServiceConfigPatchSchema,
  ServiceSlugField,
  ServiceSourceSchema,
  sessionAuth,
  VariableKeyField,
  VariableTierSchema,
  VariableValueField,
} from "../schemas";
import { EnvironmentParams, ProjectParams } from "./params";
import { defineRoute, session } from "./policy";

// -----------------------------------------------------------------------------
// Params
// -----------------------------------------------------------------------------

/** `{changeSetId}` path param. */
export const ChangeSetParams = z.object({ changeSetId: z.string() });

/** `{changeSetId}` and `{opId}` path params. */
export const StagedChangeParams = ChangeSetParams.extend({ opId: z.string() });

// -----------------------------------------------------------------------------
// Ops
// -----------------------------------------------------------------------------

const NewRef = z
  .string()
  .regex(NEW_SERVICE_REF_RE, "expected new:<n>")
  .openapi({ example: "new:1" });

const ServiceRef = z
  .string()
  .min(1)
  .max(128)
  .openapi({ description: "A service ID, or `new:<n>` for a service created in the same set" });

const ConfigPatchField = ServiceConfigPatchSchema.refine(
  (p) => Object.values(p).some((v) => v !== undefined),
  { message: "the patch changes nothing" },
);

const VariableTarget = {
  scope: z.enum(VARIABLE_SCOPES),
  /** Set exactly when `scope` is `service`. */
  service: ServiceRef.optional(),
  key: VariableKeyField,
};

const scopeMatchesService = (v: { scope: string; service?: string | undefined }) =>
  (v.scope === "service") === (v.service !== undefined);
const SCOPE_RULE = { message: "service is required for scope service and only allowed for it" };

const ServiceCreateOp = z.object({
  type: z.literal("service.create"),
  ref: NewRef,
  name: NameField,
  slug: ServiceSlugField.optional(),
  kind: z.enum(SERVICE_KINDS).default("app"),
  icon: z.string().max(64).optional(),
  source: ServiceSourceSchema,
  config: ServiceConfigPatchSchema.omit({ source: true }).optional(),
});

const ServiceUpdateOp = z.object({
  type: z.literal("service.update"),
  service_id: z.string().min(1).max(128),
  name: NameField.optional(),
  slug: ServiceSlugField.optional(),
  icon: z.string().max(64).nullable().optional(),
});

const ServiceDeleteOp = z.object({
  type: z.literal("service.delete"),
  service_id: z.string().min(1).max(128),
});

const ConfigPatchOp = z.object({
  type: z.literal("config.patch"),
  service: ServiceRef,
  patch: ConfigPatchField,
});

const VariableDeleteOp = z.object({ type: z.literal("variable.delete"), ...VariableTarget });

/**
 * An op as a client stages it. `variable.set` carries the plaintext value,
 * sealed by the server on arrival.
 */
export const StagedOpInputSchema = z
  .discriminatedUnion("type", [
    ServiceCreateOp,
    ServiceUpdateOp,
    ServiceDeleteOp,
    ConfigPatchOp,
    z.object({
      type: z.literal("variable.set"),
      ...VariableTarget,
      value: VariableValueField,
      tier: VariableTierSchema.optional(),
      available_at_build: z.boolean().optional(),
      mount_as_file: z.boolean().optional(),
      /** Confirms a value becoming secret can never be read back (as on `PUT …/variables`). */
      confirm_write_only: z.boolean().default(false),
      /** Stores a public-prefix value that looks like a credential anyway. */
      acknowledge_public: z.boolean().default(false),
    }),
    VariableDeleteOp,
  ])
  .refine(
    (op) =>
      op.type === "variable.set" || op.type === "variable.delete" ? scopeMatchesService(op) : true,
    SCOPE_RULE,
  )
  .refine(
    (op) =>
      op.type !== "service.update" ||
      op.name !== undefined ||
      op.slug !== undefined ||
      op.icon !== undefined,
    { message: "nothing to update" },
  )
  .openapi("StagedOpInput");

/** An op as stored and returned. A staged variable value appears only as its fingerprint. */
export const StagedOpSchema = z
  .discriminatedUnion("type", [
    ServiceCreateOp,
    ServiceUpdateOp,
    ServiceDeleteOp,
    ConfigPatchOp,
    z.object({
      type: z.literal("variable.set"),
      ...VariableTarget,
      tier: VariableTierSchema.optional(),
      available_at_build: z.boolean().optional(),
      mount_as_file: z.boolean().optional(),
      confirm_write_only: z.boolean(),
      acknowledge_public: z.boolean(),
      /** First 8 hex of HMAC-SHA256 of the staged value under the project's fingerprint key. */
      fingerprint: z.string().regex(/^[a-f0-9]{8}$/),
      /** Tier the classifier decided when staged; applying decides again. */
      staged_tier: VariableTierSchema,
    }),
    VariableDeleteOp,
  ])
  .openapi("StagedOp");

/**
 * One changed value: a JSON pointer and both sides. Variables show
 * `{ tier, fingerprint }` on each side (or `null` when absent); a secret
 * build arg shows `{ masked: true }`.
 */
export const DiffEntrySchema = z
  .object({ path: z.string(), before: z.unknown(), after: z.unknown() })
  .openapi("DiffEntry");

/** Why an op can't apply as staged. */
export const StagedConflictSchema = z
  .object({
    theirs: z.unknown(),
    paths: z.array(z.string()).optional(),
    base_version: z.number().int().nullable(),
    current_version: z.number().int().nullable(),
    deleted: z.boolean().optional(),
  })
  .openapi("StagedConflict");

/** One op of a change set. */
export const StagedChangeSchema = z
  .object({
    id: z.string(),
    seq: z.number().int(),
    target_key: z.string(),
    op: StagedOpSchema,
    /** Value-free one-liner, e.g. `set api.DATABASE_URL`. */
    summary: z.string(),
    diff: z.array(DiffEntrySchema),
    status: z.enum(STAGED_CHANGE_STATUSES),
    conflict: StagedConflictSchema.nullable(),
    created_by: z.string().nullable(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .openapi("StagedChange");

/** A change set with its ops in apply order. */
export const ChangeSetSchema = ChangeSetSummarySchema.extend({
  changes: z.array(StagedChangeSchema),
}).openapi("ChangeSet");

/** A service an apply would deploy, and why. */
export const PlannedDeploySchema = z
  .object({
    /** A service ID, or `new:<n>`. */
    service: z.string(),
    name: z.string(),
    reason: z.enum(["config", "variables", "created", "references"]),
  })
  .openapi("PlannedDeploy");

/** A change set checked against the current state, without changing anything. */
export const ChangeSetReviewSchema = z
  .object({
    change_set: ChangeSetSchema,
    /** Ops whose base drifted: `rebases` merge cleanly, `conflicts` need a decision. */
    rebases: z.array(z.string()),
    conflicts: z.array(z.object({ id: z.string(), conflict: StagedConflictSchema })),
    /** What `deploy: "affected"` would start. */
    deploys: z.array(PlannedDeploySchema),
  })
  .openapi("ChangeSetReview");

// -----------------------------------------------------------------------------
// Bodies
// -----------------------------------------------------------------------------

/** Body of the staging routes. */
export const StageOpBody = z
  .object({
    op: StagedOpInputSchema,
    /** Fails with 409 `change_set_changed` unless the set still is at this revision. */
    expected_revision: z.number().int().positive().optional(),
  })
  .openapi("StageOp");

/** Query of `DELETE …/ops/{opId}`. */
export const UnstageQuery = z.object({
  expected_revision: z.coerce.number().int().positive().optional(),
});

/** Body of `POST /v1/environments/{environmentId}/change-sets`. */
export const CreateChangeSetBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    source: z.enum(CHANGE_SET_SOURCES).exclude(["dashboard"]).default("api"),
    /** Staged right away, in order; at most {@link MAX_STAGED_OPS}. */
    ops: z.array(StagedOpInputSchema).max(MAX_STAGED_OPS).default([]),
  })
  .openapi("CreateChangeSet");

/** Body of `POST …/ops/{opId}/resolve`. */
export const ResolveOpBody = z
  .object({
    /** `mine` rebases the op onto the current state; `theirs` drops it. */
    keep: z.enum(["mine", "theirs"]),
    expected_revision: z.number().int().positive(),
  })
  .openapi("ResolveOp");

/** Body of `POST /v1/change-sets/{changeSetId}/apply`. */
export const ApplyChangeSetBody = z
  .object({
    /** The revision the caller reviewed; 409 `change_set_changed` otherwise. */
    expected_revision: z.number().int().positive(),
    /** `affected` deploys every service whose deployment the set changes. */
    deploy: z.enum(["affected", "none"]).default("affected"),
  })
  .openapi("ApplyChangeSet");

/** Response of the apply route. */
export const AppliedChangeSetSchema = z
  .object({
    change_set: ChangeSetSchema,
    deployment_ids: z.array(z.string()),
    /** Affected services that were not deployed (e.g. scaled to 0), and why. */
    skipped: z.array(z.object({ service_id: z.string(), reason: z.string() })),
  })
  .openapi("AppliedChangeSet");

/** Body of `POST /v1/change-sets/{changeSetId}/discard`. */
export const DiscardChangeSetBody = z
  .object({ expected_revision: z.number().int().positive().optional() })
  .openapi("DiscardChangeSet");

/** Query of `GET /v1/environments/{environmentId}/change-sets`. */
export const ChangeSetListQuery = z.object({
  /** Only open sets (the default), or every set newest first. */
  status: z.enum(["open", "all"]).default("open"),
});

// -----------------------------------------------------------------------------
// Canvas
// -----------------------------------------------------------------------------

/** One service on the canvas: live, or staged for creation. */
export const CanvasNodeSchema = z
  .object({
    /** Service ID, or `new:<n>` for a staged creation. */
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    kind: z.enum(SERVICE_KINDS),
    icon: z.string().nullable(),
    /** What the environment's draft does to it, if anything. */
    staged: z.enum(["create", "update", "delete"]).nullable(),
    /** Number of draft ops about this service. */
    staged_ops: z.number().int().nonnegative(),
  })
  .openapi("CanvasNode");

/**
 * A dependency between two services, derived from `${{slug.VAR}}`
 * references. `private_network` when one of the references is a private
 * domain built-in. `staged` edges only exist once the draft applies;
 * `removed` ones disappear then.
 */
export const CanvasEdgeSchema = z
  .object({
    id: z.string(),
    from: z.string(),
    to: z.string(),
    kind: z.enum(["reference", "private_network"]),
    /** Referenced variables as `slug.NAME`. */
    variables: z.array(z.string()),
    state: z.enum(["current", "staged", "removed"]),
  })
  .openapi("CanvasEdge");

/** Query of the canvas route. */
export const CanvasQuery = z.object({ environment_id: z.string() });

/** What the canvas draws for one environment. */
export const CanvasSchema = z
  .object({
    project_id: z.string(),
    environment_id: z.string(),
    /** Applying changes here is limited by the environment's protection rules (ADR 0014). */
    environment_protected: z.boolean(),
    nodes: z.array(CanvasNodeSchema),
    edges: z.array(CanvasEdgeSchema),
    positions: CanvasPositionsSchema,
    layout_version: z.number().int().nonnegative(),
    draft: ChangeSetSummarySchema.nullable(),
  })
  .openapi("Canvas");

/** Body of `PATCH /v1/projects/{projectId}/canvas/layout`. */
export const UpdateCanvasLayoutBody = z
  .object({
    /** Merged into the stored positions; `null` removes one. */
    positions: z.record(z.string().max(128), CanvasPositionSchema.nullable()),
    /** 409 unless the layout still is at this version (0 before the first write). */
    expected_version: z.number().int().nonnegative(),
  })
  .openapi("UpdateCanvasLayout");

/** A project's stored canvas layout. */
export const CanvasLayoutSchema = z
  .object({ positions: CanvasPositionsSchema, version: z.number().int().nonnegative() })
  .openapi("CanvasLayout");

// -----------------------------------------------------------------------------
// Routes
// -----------------------------------------------------------------------------

const tags = ["changes"];

/** Services, reference edges and positions for one environment, with its draft. */
export const getCanvas = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/projects/{projectId}/canvas",
  tags,
  summary: "Get the project canvas",
  security: sessionAuth,
  request: { params: ProjectParams, query: CanvasQuery },
  responses: { 200: json(CanvasSchema), ...errors(400, 401, 403, 404) },
});

/** Moves services on the canvas. Not audited: positions are cosmetic. */
export const updateCanvasLayout = defineRoute(session("services:manage"), {
  method: "patch",
  path: "/v1/projects/{projectId}/canvas/layout",
  tags,
  summary: "Update canvas positions",
  security: sessionAuth,
  request: { params: ProjectParams, ...body(UpdateCanvasLayoutBody) },
  responses: { 200: json(CanvasLayoutSchema), ...errors(400, 401, 403, 404, 409) },
});

/** Change sets of an environment, newest first. */
export const listChangeSets = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/environments/{environmentId}/change-sets",
  tags,
  summary: "List change sets",
  security: sessionAuth,
  request: { params: EnvironmentParams, query: ChangeSetListQuery },
  responses: {
    200: json(z.object({ change_sets: z.array(ChangeSetSummarySchema) }).openapi("ChangeSetList")),
    ...errors(400, 401, 403, 404),
  },
});

/** Opens a change set separate from the draft (API clients, MCP), optionally with ops. */
export const createChangeSet = defineRoute(session("projects:read", ["change_set.created"]), {
  method: "post",
  path: "/v1/environments/{environmentId}/change-sets",
  tags,
  summary: "Open a change set",
  security: sessionAuth,
  request: { params: EnvironmentParams, ...body(CreateChangeSetBody) },
  responses: { 201: json(ChangeSetSchema, "Opened"), ...errors(400, 401, 403, 404, 409) },
});

/** The environment's shared draft, or `null` when nothing is staged. */
export const getDraft = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/environments/{environmentId}/draft",
  tags,
  summary: "Get the environment's draft",
  security: sessionAuth,
  request: { params: EnvironmentParams },
  responses: {
    200: json(z.object({ change_set: ChangeSetSchema.nullable() }).openapi("Draft")),
    ...errors(401, 403, 404),
  },
});

/** Stages an op into the environment's draft, opening it if needed. */
export const stageDraftOp = defineRoute(session("projects:read"), {
  method: "post",
  path: "/v1/environments/{environmentId}/draft/ops",
  tags,
  summary: "Stage a change in the draft",
  security: sessionAuth,
  request: { params: EnvironmentParams, ...body(StageOpBody) },
  responses: { 200: json(ChangeSetSchema, "Staged"), ...errors(400, 401, 403, 404, 409) },
});

/** A change set with its ops and value-free diffs. */
export const getChangeSet = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/change-sets/{changeSetId}",
  tags,
  summary: "Get a change set",
  security: sessionAuth,
  request: { params: ChangeSetParams },
  responses: { 200: json(ChangeSetSchema), ...errors(401, 403, 404) },
});

/**
 * Checks a change set against the current state without changing it: which
 * ops rebase, which conflict, and what an apply would deploy.
 */
export const reviewChangeSet = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/change-sets/{changeSetId}/diff",
  tags,
  summary: "Review a change set",
  security: sessionAuth,
  request: { params: ChangeSetParams },
  responses: { 200: json(ChangeSetReviewSchema), ...errors(401, 403, 404) },
});

/** Stages an op into a change set. */
export const stageOp = defineRoute(session("projects:read"), {
  method: "post",
  path: "/v1/change-sets/{changeSetId}/ops",
  tags,
  summary: "Stage a change",
  security: sessionAuth,
  request: { params: ChangeSetParams, ...body(StageOpBody) },
  responses: { 200: json(ChangeSetSchema, "Staged"), ...errors(400, 401, 403, 404, 409) },
});

/** Removes one op from a change set. */
export const unstageOp = defineRoute(session("projects:read"), {
  method: "delete",
  path: "/v1/change-sets/{changeSetId}/ops/{opId}",
  tags,
  summary: "Unstage a change",
  security: sessionAuth,
  request: { params: StagedChangeParams, query: UnstageQuery },
  responses: { 200: json(ChangeSetSchema, "Unstaged"), ...errors(400, 401, 403, 404, 409) },
});

/** Settles a conflicted op: keep mine (rebase onto current) or take theirs (drop it). */
export const resolveOp = defineRoute(session("projects:read"), {
  method: "post",
  path: "/v1/change-sets/{changeSetId}/ops/{opId}/resolve",
  tags,
  summary: "Resolve a conflict",
  security: sessionAuth,
  request: { params: StagedChangeParams, ...body(ResolveOpBody) },
  responses: { 200: json(ChangeSetSchema, "Resolved"), ...errors(400, 401, 403, 404, 409) },
});

/**
 * Applies a change set exactly as reviewed: re-authorizes every op for the
 * caller in the target environment, rebases or refuses drifted ops (409
 * `change_set_conflict`), validates references (422 `invalid_references`),
 * writes everything, and deploys the affected services.
 */
export const applyChangeSet = defineRoute(
  session("projects:read", [
    "change_set.applied",
    "service.created",
    "service.updated",
    "service.deleted",
    "variables.updated",
    "deployment.created",
  ]),
  {
    method: "post",
    path: "/v1/change-sets/{changeSetId}/apply",
    tags,
    summary: "Apply a change set",
    security: sessionAuth,
    request: { params: ChangeSetParams, ...body(ApplyChangeSetBody) },
    responses: {
      200: json(AppliedChangeSetSchema, "Applied"),
      ...errors(400, 401, 403, 404, 409, 422),
    },
  },
);

/** Throws a change set away. */
export const discardChangeSet = defineRoute(session("projects:read", ["change_set.discarded"]), {
  method: "post",
  path: "/v1/change-sets/{changeSetId}/discard",
  tags,
  summary: "Discard a change set",
  security: sessionAuth,
  request: { params: ChangeSetParams, ...body(DiscardChangeSetBody) },
  responses: { 200: json(ChangeSetSchema, "Discarded"), ...errors(400, 401, 403, 404, 409) },
});

/** Every canvas and change set route, by name. */
export const CHANGE_ROUTES = {
  getCanvas,
  updateCanvasLayout,
  listChangeSets,
  createChangeSet,
  getDraft,
  stageDraftOp,
  getChangeSet,
  reviewChangeSet,
  stageOp,
  unstageOp,
  resolveOp,
  applyChangeSet,
  discardChangeSet,
} as const;

/** A change set with its ops. */
export type ChangeSet = z.infer<typeof ChangeSetSchema>;
/** A change set without its ops. */
export type ChangeSetSummary = z.infer<typeof ChangeSetSummarySchema>;
/** One staged op as returned. */
export type StagedChange = z.infer<typeof StagedChangeSchema>;
/** An op as a client stages it. */
export type StagedOpInput = z.input<typeof StagedOpInputSchema>;
/** The canvas of one environment. */
export type Canvas = z.infer<typeof CanvasSchema>;
/** A change set review. */
export type ChangeSetReview = z.infer<typeof ChangeSetReviewSchema>;
