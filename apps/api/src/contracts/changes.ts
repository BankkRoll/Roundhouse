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
 * Review (submit, approve, reject) records who vouched for exactly which
 * revision; an environment whose protection requires approval refuses to
 * apply without one (ADR 0006 "Apply", step 2).
 *
 * SECURITY: A staged `variable.set` takes a plaintext `value` on input
 * only. Responses carry its key, tier and fingerprint, never the value.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import { isSafeMountPath } from "@roundhouse/protocol";
import {
  CHANGE_SET_SOURCES,
  MAX_REVIEW_NOTE_LENGTH,
  MAX_STAGED_OPS,
  MAX_VOLUME_MB,
  MIN_VOLUME_MB,
  NEW_SERVICE_REF_RE,
  SERVICE_DATABASE_ENGINES,
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
  WorkspaceParams,
} from "../schemas";
import { DatabaseChoiceSchema } from "./databases";
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

const ServiceCreateOp = z
  .object({
    type: z.literal("service.create"),
    ref: NewRef,
    name: NameField,
    slug: ServiceSlugField.optional(),
    kind: z.enum(SERVICE_KINDS).default("app"),
    icon: z.string().max(64).optional(),
    /** Required, except for a database, whose pinned image the registry picks. */
    source: ServiceSourceSchema.optional(),
    config: ServiceConfigPatchSchema.omit({ source: true }).optional(),
    /** Creates a database service (ADR 0004); see `POST /v1/projects/{projectId}/databases`. */
    database: DatabaseChoiceSchema.optional(),
  })
  .refine((op) => (op.source === undefined) !== (op.database === undefined), {
    message: "give exactly one of source and database",
    path: ["source"],
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

const LiveServiceId = z.string().min(1).max(128).openapi({ description: "A live service ID" });

/** A container path a volume may be mounted at; see `isSafeMountPath`. */
const MountPathField = z
  .string()
  .min(2)
  .max(1024)
  .refine(isSafeMountPath, { message: "not a safe absolute mount path" })
  .openapi({ example: "/data" });

const VolumeSetOp = z.object({
  type: z.literal("volume.set"),
  service: LiveServiceId,
  /** Required when the service has no volume in the environment yet. */
  mount_path: MountPathField.optional(),
  /** Grow-only: a smaller size than the current one is refused with 422. */
  size_mb: z.number().int().min(MIN_VOLUME_MB).max(MAX_VOLUME_MB),
});

const VolumeDeleteOp = z.object({ type: z.literal("volume.delete"), service: LiveServiceId });

const DomainAddOp = z.object({
  type: z.literal("domain.add"),
  service: LiveServiceId,
  /** Normalised when staged: case, one trailing dot and IDNs are accepted. */
  hostname: z.string().min(1).max(300).openapi({ example: "shop.example.com" }),
});

const DomainRemoveInputOp = z.object({
  type: z.literal("domain.remove"),
  domain_id: z.string().min(1).max(128),
});

const DomainRemoveOp = DomainRemoveInputOp.extend({
  hostname: z.string(),
  service: z.string(),
});

/**
 * Deploys another environment's exact image (ADR 0007, "Promote"). Only the
 * promote route writes it; clients can't stage it.
 */
const DeploymentPromoteOp = z.object({
  type: z.literal("deployment.promote"),
  service_id: z.string(),
  from_deployment_id: z.string(),
  from_environment_id: z.string(),
  /** The image by digest. */
  image: z.string(),
});

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
    VolumeSetOp,
    VolumeDeleteOp,
    DomainAddOp,
    DomainRemoveInputOp,
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
    VolumeSetOp,
    VolumeDeleteOp,
    DomainAddOp,
    DomainRemoveOp,
    DeploymentPromoteOp,
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
    /** `volume`: the set gives it a new volume, which only a new deployment mounts. */
    reason: z.enum(["config", "variables", "created", "references", "volume"]),
  })
  .openapi("PlannedDeploy");

/** Whether a change set may be applied as far as review goes, and who may review it. */
export const ChangeSetApprovalSchema = z
  .object({
    /** The environment is protected and its protection requires approval. */
    required: z.boolean(),
    /** Approved at the current revision. */
    approved: z.boolean(),
    /**
     * Users who opened the set or staged ops in it: none of them may approve
     * it. Lets a client hide Approve from them.
     */
    authors: z.array(z.string()),
  })
  .openapi("ChangeSetApproval");

/** A change set checked against the current state, without changing anything. */
export const ChangeSetReviewSchema = z
  .object({
    change_set: ChangeSetSchema,
    /** Ops whose base drifted: `rebases` merge cleanly, `conflicts` need a decision. */
    rebases: z.array(z.string()),
    conflicts: z.array(z.object({ id: z.string(), conflict: StagedConflictSchema })),
    /** What `deploy: "affected"` would start. */
    deploys: z.array(PlannedDeploySchema),
    approval: ChangeSetApprovalSchema,
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

const ReviewNote = z.string().trim().min(1).max(MAX_REVIEW_NOTE_LENGTH);

/** Body of `POST /v1/change-sets/{changeSetId}/submit`. */
export const SubmitChangeSetBody = z
  .object({
    /** Refuse unless the set is still at this revision. */
    expected_revision: z.number().int().positive().optional(),
    /** What reviewers should know. Shown as text. */
    note: ReviewNote.optional(),
  })
  .openapi("SubmitChangeSet");

/** Body of `POST …/approve` and `POST …/reject`. */
export const ReviewChangeSetBody = z
  .object({
    /** The revision the reviewer looked at; the decision covers exactly it. */
    expected_revision: z.number().int().positive(),
    /** Why, for a rejection especially. Shown as text. */
    note: ReviewNote.optional(),
  })
  .openapi("ReviewDecision");

/** Body of `POST /v1/change-sets/{changeSetId}/rebase`. */
export const RebaseChangeSetBody = z
  .object({ expected_revision: z.number().int().positive() })
  .openapi("RebaseChangeSet");

/** Response of the rebase route. */
export const RebasedChangeSetSchema = z
  .object({
    change_set: ChangeSetSchema,
    /** Ops moved onto the current state; their diffs were recomputed. */
    rebased: z.array(z.string()),
    /** Ops that conflict and need Keep mine / Take theirs. */
    conflicts: z.array(z.object({ id: z.string(), conflict: StagedConflictSchema })),
  })
  .openapi("RebasedChangeSet");

/** Query of `GET /v1/environments/{environmentId}/change-sets`. */
export const ChangeSetListQuery = z.object({
  /** Only open sets (the default), or every set newest first. */
  status: z.enum(["open", "all"]).default("open"),
});

// -----------------------------------------------------------------------------
// Canvas
// -----------------------------------------------------------------------------

/** A service's volume in the canvas's environment, with what the draft does to it. */
export const CanvasVolumeSchema = z
  .object({
    /** `null` while only staged. */
    id: z.string().nullable(),
    mount_path: z.string(),
    size_mb: z.number().int(),
    /** A volume status (`pending`, `ready`, `pending_deletion`, …); `null` while only staged. */
    status: z.string().nullable(),
    /** Unix ms after which a deleted volume's data is removed. */
    delete_after: z.number().int().nullable(),
    staged: z.enum(["create", "resize", "delete"]).nullable(),
    /** The size the draft sets, when it creates or grows the volume. */
    staged_size_mb: z.number().int().nullable(),
  })
  .openapi("CanvasVolume");

/** A custom domain of a service in the canvas's environment. */
export const CanvasDomainSchema = z
  .object({
    /** `null` for one the draft adds. */
    id: z.string().nullable(),
    hostname: z.string(),
    /** `null` for one the draft adds. */
    status: z.string().nullable(),
    staged: z.enum(["add", "remove"]).nullable(),
  })
  .openapi("CanvasDomain");

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
    /** Engine and registry version of a database service, live or staged. */
    database: z
      .object({ engine: z.enum(SERVICE_DATABASE_ENGINES), version: z.string() })
      .nullable(),
    volume: CanvasVolumeSchema.nullable(),
    domains: z.array(CanvasDomainSchema),
  })
  .openapi("CanvasNode");

/**
 * A dependency between two services: derived from `${{slug.VAR}}`
 * references (`reference`, or `private_network` when one of them is a
 * private domain built-in), or drawn by someone (`explicit`, ID `edg_…`).
 * `staged` reference edges only exist once the draft applies; `removed`
 * ones disappear then. Explicit edges are always `current`.
 */
export const CanvasEdgeSchema = z
  .object({
    id: z.string(),
    from: z.string(),
    to: z.string(),
    kind: z.enum(["reference", "private_network", "explicit"]),
    /** Referenced variables as `slug.NAME`; empty for explicit edges. */
    variables: z.array(z.string()),
    state: z.enum(["current", "staged", "removed"]),
  })
  .openapi("CanvasEdge");

/** Body of `POST /v1/projects/{projectId}/edges`. */
export const AddServiceEdgeBody = z
  .object({
    from_service_id: z.string().min(1).max(128),
    to_service_id: z.string().min(1).max(128),
  })
  .refine((b) => b.from_service_id !== b.to_service_id, {
    message: "a service can't connect to itself",
  })
  .openapi("AddServiceEdge");

/** An explicit "connects to" edge. */
export const ServiceEdgeSchema = z
  .object({
    id: z.string(),
    project_id: z.string(),
    from_service_id: z.string(),
    to_service_id: z.string(),
    created_by: z.string().nullable(),
    created_at: z.number().int(),
  })
  .openapi("ServiceEdge");

/** `{projectId}` and `{edgeId}` path params. */
export const ServiceEdgeParams = ProjectParams.extend({ edgeId: z.string() });

/** Query of the canvas route. */
export const CanvasQuery = z.object({ environment_id: z.string() });

/** What the canvas draws for one environment. */
export const CanvasSchema = z
  .object({
    project_id: z.string(),
    environment_id: z.string(),
    /** Applying changes here is limited by the environment's protection rules (ADR 0014). */
    environment_protected: z.boolean(),
    /** Applying here needs an approval (ADR 0006); see `require_approval` on protection. */
    environment_requires_approval: z.boolean(),
    /** The workspace stages dashboard edits (`staged_changes`); off, they apply as saved. */
    staging: z.boolean(),
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
    200: json(
      z
        .object({
          change_sets: z.array(ChangeSetSummarySchema),
          /**
           * Applying here needs an approval (protected with `require_approval`), so a set
           * whose `review_status` isn't `approved` can't apply yet.
           */
          environment_requires_approval: z.boolean(),
        })
        .openapi("ChangeSetList"),
    ),
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
  responses: { 201: json(ChangeSetSchema, "Opened"), ...errors(400, 401, 403, 404, 409, 422) },
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
  responses: { 200: json(ChangeSetSchema, "Staged"), ...errors(400, 401, 403, 404, 409, 422) },
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
  responses: { 200: json(ChangeSetSchema, "Staged"), ...errors(400, 401, 403, 404, 409, 422) },
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

/**
 * Asks for a review. Needs `services:manage` or `variables:manage`; a set
 * already submitted or approved is left as it is.
 */
export const submitChangeSet = defineRoute(session("projects:read", ["change_set.submitted"]), {
  method: "post",
  path: "/v1/change-sets/{changeSetId}/submit",
  tags,
  summary: "Submit a change set for review",
  security: sessionAuth,
  request: { params: ChangeSetParams, ...body(SubmitChangeSetBody) },
  responses: { 200: json(ChangeSetSchema, "Submitted"), ...errors(400, 401, 403, 404, 409) },
});

/**
 * Approves a change set at the revision the reviewer saw. Nobody who opened
 * it or staged an op in it may approve it (403 `self_review`); any later
 * edit voids the approval.
 */
export const approveChangeSet = defineRoute(session("changes:approve", ["change_set.approved"]), {
  method: "post",
  path: "/v1/change-sets/{changeSetId}/approve",
  tags,
  summary: "Approve a change set",
  security: sessionAuth,
  request: { params: ChangeSetParams, ...body(ReviewChangeSetBody) },
  responses: { 200: json(ChangeSetSchema, "Approved"), ...errors(400, 401, 403, 404, 409) },
});

/** Rejects a change set at the revision the reviewer saw; it can't apply until edited. */
export const rejectChangeSet = defineRoute(session("changes:approve", ["change_set.rejected"]), {
  method: "post",
  path: "/v1/change-sets/{changeSetId}/reject",
  tags,
  summary: "Reject a change set",
  security: sessionAuth,
  request: { params: ChangeSetParams, ...body(ReviewChangeSetBody) },
  responses: { 200: json(ChangeSetSchema, "Rejected"), ...errors(400, 401, 403, 404, 409) },
});

/**
 * Moves a stale set onto the current state (ADR 0006 "Conflicts"): ops whose
 * base drifted on disjoint fields are rebased and their diffs recomputed;
 * the rest are marked conflicted. Bumps the revision when anything changed.
 */
export const rebaseChangeSet = defineRoute(session("projects:read"), {
  method: "post",
  path: "/v1/change-sets/{changeSetId}/rebase",
  tags,
  summary: "Rebase a change set",
  security: sessionAuth,
  request: { params: ChangeSetParams, ...body(RebaseChangeSetBody) },
  responses: { 200: json(RebasedChangeSetSchema), ...errors(400, 401, 403, 404, 409) },
});

/** Draws a "connects to" edge between two live services of the project. */
export const addServiceEdge = defineRoute(session("services:manage", ["canvas.edge_added"]), {
  method: "post",
  path: "/v1/projects/{projectId}/edges",
  tags,
  summary: "Connect two services",
  security: sessionAuth,
  request: { params: ProjectParams, ...body(AddServiceEdgeBody) },
  responses: { 201: json(ServiceEdgeSchema, "Added"), ...errors(400, 401, 403, 404, 409) },
});

/** Removes a "connects to" edge. */
export const removeServiceEdge = defineRoute(session("services:manage", ["canvas.edge_removed"]), {
  method: "delete",
  path: "/v1/projects/{projectId}/edges/{edgeId}",
  tags,
  summary: "Disconnect two services",
  security: sessionAuth,
  request: { params: ServiceEdgeParams },
  responses: { 204: { description: "Removed" }, ...errors(401, 403, 404) },
});

/** A change set in a workspace-wide list, with where it applies. */
export const WorkspaceChangeSetSchema = ChangeSetSummarySchema.extend({
  project_name: z.string(),
  environment_name: z.string(),
  environment_requires_approval: z.boolean(),
}).openapi("WorkspaceChangeSet");

/** Query of `GET /v1/workspaces/{workspaceId}/change-sets`. */
export const WorkspaceChangeSetQuery = z.object({
  /** Every open set (the default), or only those waiting for a reviewer. */
  review: z.enum(["open", "pending"]).default("open"),
});

/**
 * Open change sets across the workspace's projects the caller can see,
 * newest first: the workspace's review queue.
 */
export const listWorkspaceChangeSets = defineRoute(session("projects:read"), {
  method: "get",
  path: "/v1/workspaces/{workspaceId}/change-sets",
  tags,
  summary: "List a workspace's open change sets",
  security: sessionAuth,
  request: { params: WorkspaceParams, query: WorkspaceChangeSetQuery },
  responses: {
    200: json(
      z
        .object({ change_sets: z.array(WorkspaceChangeSetSchema) })
        .openapi("WorkspaceChangeSetList"),
    ),
    ...errors(400, 401, 403, 404),
  },
});

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
  submitChangeSet,
  approveChangeSet,
  rejectChangeSet,
  rebaseChangeSet,
  addServiceEdge,
  removeServiceEdge,
  listWorkspaceChangeSets,
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
/** An explicit "connects to" edge. */
export type ServiceEdge = z.infer<typeof ServiceEdgeSchema>;
/** A change set in the workspace review queue. */
export type WorkspaceChangeSet = z.infer<typeof WorkspaceChangeSetSchema>;
