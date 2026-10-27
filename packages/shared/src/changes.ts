/**
 * Staged changes (ADR 0006): the operations a change set holds, and the pure
 * logic the API, dashboard, MCP server and CLI share about them.
 *
 * - {@link StagedOp}: one operation, discriminated on `type`.
 * - {@link targetKeyOf} / {@link stageOp}: the coalescing key and the rules
 *   for staging an op into a set that may already touch the same target.
 * - {@link mergeConfigPatches} / {@link patchPointers} / {@link configDiff} /
 *   {@link pointersOverlap}: config patches as JSON pointers, for display and
 *   for the three-way conflict check at apply time.
 * - {@link affectedServices}: which services a set redeploys, following
 *   variable references transitively.
 * - {@link describeOp}: a value-free one-line summary for audit metadata.
 *
 * SECURITY: Nothing here ever sees a variable value: a staged `variable.set`
 * carries only the value's fingerprint; the sealed value lives in its own
 * column on the API side.
 *
 * @module
 */

import type { ServiceDatabaseEngine } from "./databases";
import type { ServiceKind, VariableScope } from "./projects";
import type { ProjectAction } from "./rbac";
import type {
  BuildConfig,
  DeployConfig,
  HealthcheckConfig,
  NetworkingConfig,
  PlacementConfig,
  ResourcesConfig,
  ServiceConfigSpec,
  ServiceSource,
} from "./service-config";
import type { VariableTier } from "./variable-classifier";
import { parseReferences, SHARED_NAMESPACE } from "./variables";

// -----------------------------------------------------------------------------
// Vocabulary
// -----------------------------------------------------------------------------

/** Lifecycle of a change set. */
export const CHANGE_SET_STATUSES = ["open", "applying", "applied", "discarded", "failed"] as const;

/** A change set's status; see {@link CHANGE_SET_STATUSES}. */
export type ChangeSetStatus = (typeof CHANGE_SET_STATUSES)[number];

/** Who proposed a change set. */
export const CHANGE_SET_SOURCES = [
  "dashboard",
  "api",
  "mcp",
  "template",
  "promote",
  "preview",
] as const;

/** A change set's origin; see {@link CHANGE_SET_SOURCES}. */
export type ChangeSetSource = (typeof CHANGE_SET_SOURCES)[number];

/** State of one staged op. */
export const STAGED_CHANGE_STATUSES = ["pending", "conflicted", "applied"] as const;

/** A staged op's status; see {@link STAGED_CHANGE_STATUSES}. */
export type StagedChangeStatus = (typeof STAGED_CHANGE_STATUSES)[number];

/**
 * Op types that can be staged today. ADR 0006 also lists `tcp_proxy.set` and
 * `backup_policy.set`; each lands with the feature that owns it (0004) by
 * adding a member here, a branch to the union below, and an apply step in
 * the API. `deployment.promote` (ADR 0007) is only ever written by the
 * promote route, never staged by a client.
 */
export const STAGED_OP_TYPES = [
  "service.create",
  "service.update",
  "service.delete",
  "config.patch",
  "variable.set",
  "variable.delete",
  "volume.set",
  "volume.delete",
  "domain.add",
  "domain.remove",
  "deployment.promote",
] as const;

/** A staged op's type; see {@link STAGED_OP_TYPES}. */
export type StagedOpType = (typeof STAGED_OP_TYPES)[number];

/** Most ops one change set holds. */
export const MAX_STAGED_OPS = 100;

/**
 * Where a change set is in review (ADR 0006 "Apply", step 2):
 * - `none`: nobody asked for a review;
 * - `submitted`: someone asked for one, or edited an approved or rejected set;
 * - `approved` / `rejected`: a reviewer with `changes:approve` decided, at the
 *   set's current revision. Any later edit moves the set back to `submitted`,
 *   so an approval always covers exactly what applies.
 */
export const CHANGE_SET_REVIEW_STATUSES = ["none", "submitted", "approved", "rejected"] as const;

/** A change set's review state; see {@link CHANGE_SET_REVIEW_STATUSES}. */
export type ChangeSetReviewStatus = (typeof CHANGE_SET_REVIEW_STATUSES)[number];

/** Longest note a submitter or reviewer can leave on a change set. */
export const MAX_REVIEW_NOTE_LENGTH = 500;

/** Most explicit "connects to" edges one project holds. */
export const MAX_SERVICE_EDGES = 500;

/**
 * A service created in the same set, addressed before it has an ID:
 * `new:1`, `new:2`, … Resolved to the new `svc_…` at apply time.
 */
export const NEW_SERVICE_REF_RE = /^new:[1-9][0-9]{0,3}$/;

/**
 * Whether `ref` names a service created in the same change set.
 *
 * @param ref - A service ID or a `new:<n>` reference.
 * @returns `true` for `new:<n>`.
 */
export function isNewServiceRef(ref: string): boolean {
  return NEW_SERVICE_REF_RE.test(ref);
}

// -----------------------------------------------------------------------------
// Ops
// -----------------------------------------------------------------------------

/** A config change: parts shallow-merge, `source` and `healthcheck` replace whole. */
export interface ServiceConfigPatch {
  source?: ServiceSource;
  build?: Partial<BuildConfig>;
  deploy?: Partial<DeployConfig>;
  resources?: Partial<ResourcesConfig>;
  healthcheck?: HealthcheckConfig | null;
  networking?: Partial<NetworkingConfig>;
  placement?: Partial<PlacementConfig>;
}

/** Config parts, in display order. */
export const CONFIG_PATCH_PARTS = [
  "source",
  "build",
  "deploy",
  "resources",
  "healthcheck",
  "networking",
  "placement",
] as const satisfies readonly (keyof ServiceConfigSpec)[];

/** Parts a patch replaces whole instead of merging field by field. */
const WHOLE_PARTS = new Set<string>(["source", "healthcheck"]);

/** Creates a service (config version 1 in every environment). */
export interface ServiceCreateOp {
  type: "service.create";
  /** `new:<n>`: how other ops of the set address this service. */
  ref: string;
  name: string;
  slug?: string;
  kind: ServiceKind;
  icon?: string;
  source: ServiceSource;
  /** Applied on top of `defaultServiceConfig(source)`. */
  config?: Omit<ServiceConfigPatch, "source">;
  /**
   * A database service (ADR 0004): `source` and `config` are rendered from
   * the registry when staged, and the apply generates its credentials and
   * creates its volume in every environment.
   */
  database?: ServiceCreateDatabase;
}

/** The database a `service.create` op renders; see {@link ServiceCreateOp.database}. */
export interface ServiceCreateDatabase {
  engine: ServiceDatabaseEngine;
  /** A registry version, resolved when staged. */
  version: string;
  /** Volume quota in MiB. */
  size_mb: number;
}

/** Renames a service or changes its icon. */
export interface ServiceUpdateOp {
  type: "service.update";
  service_id: string;
  name?: string;
  slug?: string;
  icon?: string | null;
}

/** Deletes a service from every environment. */
export interface ServiceDeleteOp {
  type: "service.delete";
  service_id: string;
}

/** Changes a service's config in the set's environment. */
export interface ConfigPatchOp {
  type: "config.patch";
  /** A service ID, or `new:<n>`. */
  service: string;
  patch: ServiceConfigPatch;
}

/**
 * Sets one variable. The value itself is never part of the op: the API
 * seals it into its own column and keeps only its fingerprint here.
 */
export interface VariableSetOp {
  type: "variable.set";
  scope: VariableScope;
  /** A service ID or `new:<n>`; set exactly when `scope` is `service`. */
  service?: string;
  key: string;
  /** Requested tier; the classifier decides when omitted. */
  tier?: VariableTier;
  available_at_build?: boolean;
  mount_as_file?: boolean;
  /** The stager confirmed a value becoming secret can never be read back. */
  confirm_write_only: boolean;
  /** The stager confirmed a public-prefix value that looks like a credential. */
  acknowledge_public: boolean;
  /** First 8 hex of HMAC-SHA256 of the staged value under the project's fingerprint key. */
  fingerprint: string;
  /** Tier the classifier decided when the op was staged. */
  staged_tier: VariableTier;
}

/** Deletes one variable. */
export interface VariableDeleteOp {
  type: "variable.delete";
  scope: VariableScope;
  service?: string;
  key: string;
}

/**
 * Gives a live service a volume in the set's environment, or grows the one it
 * has (ADR 0004). Volumes never shrink; a service with a volume runs one
 * replica.
 */
export interface VolumeSetOp {
  type: "volume.set";
  /** A live service ID. */
  service: string;
  /** Required when the service has no volume in the environment yet. */
  mount_path?: string;
  /** Quota in MiB. */
  size_mb: number;
}

/**
 * Soft-deletes a service's volume in the set's environment: its data is
 * removed from the node after `VOLUME_DELETE_GRACE_MS` (72 h) unless it is
 * undeleted first.
 */
export interface VolumeDeleteOp {
  type: "volume.delete";
  service: string;
}

/** Adds a custom domain to a live service in the set's environment (ADR 0009). */
export interface DomainAddOp {
  type: "domain.add";
  service: string;
  /** Normalised when staged (lower case, punycode, no trailing dot). */
  hostname: string;
}

/** Removes a custom domain. */
export interface DomainRemoveOp {
  type: "domain.remove";
  domain_id: string;
  /** Filled in when staged, for the coalescing key and the review. */
  hostname: string;
  service: string;
}

/**
 * Deploys, in the set's environment, the exact image another environment's
 * active deployment runs (ADR 0007, "Promote"): no rebuild, with the target's
 * config after the apply.
 */
export interface DeploymentPromoteOp {
  type: "deployment.promote";
  service_id: string;
  /** An active deployment of the same service in another environment of the project. */
  from_deployment_id: string;
  /** Its environment, for the review. */
  from_environment_id: string;
  /** Its image, pinned by digest, for the review. */
  image: string;
}

/** One operation of a change set. */
export type StagedOp =
  | ServiceCreateOp
  | ServiceUpdateOp
  | ServiceDeleteOp
  | ConfigPatchOp
  | VariableSetOp
  | VariableDeleteOp
  | VolumeSetOp
  | VolumeDeleteOp
  | DomainAddOp
  | DomainRemoveOp
  | DeploymentPromoteOp;

/**
 * The service an op is about, if any: its ID or `new:<n>` ref.
 *
 * @param op - A staged op.
 * @returns The service, or `null` for shared variables.
 */
export function serviceOfOp(op: StagedOp): string | null {
  switch (op.type) {
    case "service.create":
      return op.ref;
    case "service.update":
    case "service.delete":
    case "deployment.promote":
      return op.service_id;
    case "config.patch":
      return op.service;
    case "variable.set":
    case "variable.delete":
      return op.scope === "shared" ? null : (op.service ?? null);
    case "volume.set":
    case "volume.delete":
    case "domain.add":
    case "domain.remove":
      return op.service;
  }
}

/**
 * The coalescing key of an op: two ops with the same key can't both be in a
 * set, so staging the second one merges into or replaces the first.
 *
 * @param op - A staged op.
 * @returns e.g. `config:svc_1`, `var:shared:API_URL`, `create:new:1`, `domain:shop.example.com`.
 * @example
 * targetKeyOf({ type: "variable.delete", scope: "service", service: "svc_1", key: "A" });
 * // "var:svc_1:A"
 */
export function targetKeyOf(op: StagedOp): string {
  switch (op.type) {
    case "service.create":
      return `create:${op.ref}`;
    case "service.update":
    case "service.delete":
      return `service:${op.service_id}`;
    case "config.patch":
      return `config:${op.service}`;
    case "variable.set":
    case "variable.delete":
      return `var:${op.scope === "shared" ? SHARED_NAMESPACE : op.service}:${op.key}`;
    case "volume.set":
    case "volume.delete":
      return `volume:${op.service}`;
    case "domain.add":
    case "domain.remove":
      return `domain:${op.hostname}`;
    case "deployment.promote":
      return `promote:${op.service_id}`;
  }
}

/**
 * The RBAC action applying an op needs (ADR 0006 "Operations"). Apply checks
 * it against the target environment, so protection rules apply. Volumes and
 * domains are `services:manage`, as on their direct routes; a promotion is a
 * deploy.
 *
 * @param op - A staged op.
 * @returns `services:manage`, `variables:manage` or `deployments:create`.
 */
export function opAction(
  op: StagedOp,
): Extract<ProjectAction, "services:manage" | "variables:manage" | "deployments:create"> {
  if (op.type === "deployment.promote") return "deployments:create";
  return op.type === "variable.set" || op.type === "variable.delete"
    ? "variables:manage"
    : "services:manage";
}

/**
 * A short, value-free description of an op for audit metadata and lists.
 *
 * @param op - A staged op.
 * @param serviceName - Display name for a service ID or ref; the ID itself when omitted.
 * @returns e.g. `set api.DATABASE_URL`, `patch api config (deploy.replicas)`.
 */
export function describeOp(op: StagedOp, serviceName: (ref: string) => string = (r) => r): string {
  switch (op.type) {
    case "service.create":
      return `create service ${op.name}`;
    case "service.update":
      return `update service ${serviceName(op.service_id)}`;
    case "service.delete":
      return `delete service ${serviceName(op.service_id)}`;
    case "config.patch":
      return `patch ${serviceName(op.service)} config (${patchPointers(op.patch)
        .map((p) => p.slice(1).replace("/", "."))
        .join(", ")})`;
    case "variable.set":
    case "variable.delete": {
      const ns = op.scope === "shared" ? SHARED_NAMESPACE : serviceName(op.service ?? "");
      return `${op.type === "variable.set" ? "set" : "delete"} ${ns}.${op.key}`;
    }
    case "volume.set":
      return `set ${serviceName(op.service)} volume to ${op.size_mb} MiB`;
    case "volume.delete":
      return `delete ${serviceName(op.service)} volume`;
    case "domain.add":
      return `add domain ${op.hostname} to ${serviceName(op.service)}`;
    case "domain.remove":
      return `remove domain ${op.hostname} from ${serviceName(op.service)}`;
    case "deployment.promote":
      return `promote ${serviceName(op.service_id)} image ${op.image.slice(op.image.indexOf("@") + 1, op.image.indexOf("@") + 20)}`;
  }
}

// -----------------------------------------------------------------------------
// Config patches as JSON pointers
// -----------------------------------------------------------------------------

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const escapePointer = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

/**
 * Combines two patches of the same service the way applying them in order
 * would: `source` and `healthcheck` from the newer patch replace the older
 * ones, every other part merges field by field with the newer field winning.
 *
 * @param older - Patch already staged.
 * @param newer - Patch being staged.
 * @returns One patch equivalent to applying `older` then `newer`.
 */
export function mergeConfigPatches(
  older: ServiceConfigPatch,
  newer: ServiceConfigPatch,
): ServiceConfigPatch {
  const out: Record<string, unknown> = { ...older };
  for (const [part, value] of Object.entries(newer)) {
    if (value === undefined) continue;
    const prior = out[part];
    out[part] =
      WHOLE_PARTS.has(part) || !isPlainObject(value) || !isPlainObject(prior)
        ? value
        : {
            ...prior,
            ...Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)),
          };
  }
  return out as ServiceConfigPatch;
}

/**
 * The JSON pointers a patch writes: `/source` and `/healthcheck` whole,
 * `/<part>/<field>` for the merged parts.
 *
 * @param patch - A config patch.
 * @returns Sorted, unique pointers.
 * @example
 * patchPointers({ deploy: { replicas: 2 } }); // ["/deploy/replicas"]
 */
export function patchPointers(patch: ServiceConfigPatch): string[] {
  const out = new Set<string>();
  for (const [part, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (WHOLE_PARTS.has(part) || !isPlainObject(value)) {
      out.add(`/${part}`);
      continue;
    }
    for (const [field, v] of Object.entries(value)) {
      if (v !== undefined) out.add(`/${part}/${escapePointer(field)}`);
    }
  }
  return [...out].sort();
}

/** One changed value, as shown in a review: a JSON pointer and both sides. */
export interface DiffEntry {
  /** e.g. `/deploy/replicas` or `/variables/DATABASE_URL`. */
  path: string;
  /** `null` when absent. Variables carry `{ tier, fingerprint }`, never a value. */
  before: unknown;
  after: unknown;
}

/** Shown in place of a value the reviewer may not see (a secret build arg). */
export const MASKED_VALUE = { masked: true } as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Field-level differences between two configs, at the same granularity as
 * {@link patchPointers} plus one level under `source` and `healthcheck`, so
 * a review lists `/source/image` rather than the whole source.
 *
 * Values of build args named in `secret_build_args` (on either side) are
 * replaced with {@link MASKED_VALUE}.
 *
 * @param before - Config before, or `null` for a new service.
 * @param after - Config after, or `null` for a deleted service.
 * @returns Entries sorted by path.
 */
export function configDiff(
  before: ServiceConfigSpec | null,
  after: ServiceConfigSpec | null,
): DiffEntry[] {
  const secretArgs = new Set([
    ...(before?.build.secret_build_args ?? []),
    ...(after?.build.secret_build_args ?? []),
  ]);
  const out: DiffEntry[] = [];
  for (const part of CONFIG_PATCH_PARTS) {
    const b = before ? (before[part] as unknown) : undefined;
    const a = after ? (after[part] as unknown) : undefined;
    if (same(b, a)) continue;
    if (!isPlainObject(b) && !isPlainObject(a)) {
      out.push({ path: `/${part}`, before: b ?? null, after: a ?? null });
      continue;
    }
    const bo = isPlainObject(b) ? b : {};
    const ao = isPlainObject(a) ? a : {};
    for (const field of [...new Set([...Object.keys(bo), ...Object.keys(ao)])].sort()) {
      if (same(bo[field], ao[field])) continue;
      const path = `/${part}/${escapePointer(field)}`;
      if (part === "build" && field === "build_args") {
        const bArgs = (bo[field] ?? {}) as Record<string, string>;
        const aArgs = (ao[field] ?? {}) as Record<string, string>;
        for (const k of [...new Set([...Object.keys(bArgs), ...Object.keys(aArgs)])].sort()) {
          if (bArgs[k] === aArgs[k]) continue;
          const mask = (v: string | undefined) =>
            v === undefined ? null : secretArgs.has(k) ? MASKED_VALUE : v;
          out.push({
            path: `${path}/${escapePointer(k)}`,
            before: mask(bArgs[k]),
            after: mask(aArgs[k]),
          });
        }
        continue;
      }
      out.push({ path, before: bo[field] ?? null, after: ao[field] ?? null });
    }
  }
  return out;
}

/**
 * Whether two JSON pointers touch the same value: equal, or one inside the other.
 *
 * @param a - A pointer.
 * @param b - Another pointer.
 * @returns `true` when writing one could change the other.
 */
export function pointersOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * Pointers of `mine` that a concurrent change (`theirs`, as a diff of the
 * config the op was staged on against the current one) also touched. Empty
 * means the op rebases cleanly.
 *
 * @param mine - Pointers the staged patch writes ({@link patchPointers}).
 * @param theirs - Paths of `configDiff(config@base, config@current)`.
 * @returns The overlapping pointers of `mine`, sorted.
 */
export function conflictingPointers(mine: readonly string[], theirs: readonly string[]): string[] {
  return mine.filter((m) => theirs.some((t) => pointersOverlap(m, t))).sort();
}

// -----------------------------------------------------------------------------
// Staging and coalescing
// -----------------------------------------------------------------------------

/** An op already in a set, with its coalescing key. */
export interface StagedEntry {
  target_key: string;
  op: StagedOp;
}

/** What staging an op does to a set. */
export type StageResult =
  | {
      ok: true;
      /** The op to store under `target_key`, merged with an older one when they coalesce. */
      entry: StagedEntry;
      /** Whether an op with the same key existed and is replaced. */
      replaces: boolean;
      /** Keys of other ops the new one makes moot (a delete drops its service's ops). */
      drop: string[];
    }
  | { ok: false; code: "too_many_ops" | "service_deleted" | "unknown_ref"; message: string };

/**
 * Stages `op` into a set holding `existing` (ADR 0006 "Operations"):
 * - an op with a new key is added, up to {@link MAX_STAGED_OPS};
 * - a `config.patch` over a staged one merges ({@link mergeConfigPatches});
 * - any other op with the same key replaces the older one, so a
 *   `variable.set` after a staged `variable.delete` of the key wins;
 * - a `service.delete` drops the service's other staged ops, and ops on a
 *   service staged for deletion are refused;
 * - ops on `new:<n>` need a staged `service.create` with that ref.
 *
 * @param existing - Ops in the set.
 * @param op - The op being staged.
 * @returns The entry to upsert and the keys to drop, or why it was refused.
 */
export function stageOp(existing: readonly StagedEntry[], op: StagedOp): StageResult {
  const key = targetKeyOf(op);
  const prior = existing.find((e) => e.target_key === key);
  const service = serviceOfOp(op);

  if (service && op.type !== "service.delete") {
    const deleting = existing.find(
      (e) => e.op.type === "service.delete" && e.op.service_id === service,
    );
    if (deleting && op.type !== "service.update") {
      return {
        ok: false,
        code: "service_deleted",
        message: "That service is staged for deletion; remove the deletion first",
      };
    }
  }
  if (service && isNewServiceRef(service) && op.type !== "service.create") {
    if (!existing.some((e) => e.op.type === "service.create" && e.op.ref === service)) {
      return { ok: false, code: "unknown_ref", message: `No staged service is called ${service}` };
    }
  }

  let next: StagedOp = op;
  if (prior && prior.op.type === "config.patch" && op.type === "config.patch") {
    next = { ...op, patch: mergeConfigPatches(prior.op.patch, op.patch) };
  } else if (prior && prior.op.type === "service.update" && op.type === "service.update") {
    next = { ...prior.op, ...op };
  }

  const drop =
    op.type === "service.delete"
      ? existing
          .filter((e) => e.target_key !== key && serviceOfOp(e.op) === op.service_id)
          .map((e) => e.target_key)
      : [];
  if (!prior && existing.length - drop.length + 1 > MAX_STAGED_OPS) {
    return {
      ok: false,
      code: "too_many_ops",
      message: `A change set holds at most ${MAX_STAGED_OPS} changes; apply or discard some first`,
    };
  }
  return { ok: true, entry: { target_key: key, op: next }, replaces: prior !== undefined, drop };
}

// -----------------------------------------------------------------------------
// Affected services
// -----------------------------------------------------------------------------

/** The post-apply model {@link affectedServices} reads. */
export interface AffectedInput {
  /** Raw variables of every live service after the apply, by slug. */
  services: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Raw shared variables after the apply. */
  shared: Readonly<Record<string, string>>;
  /** Variables the set writes or deletes, as `slug.KEY` or `shared.KEY`. */
  changedVariables: readonly string[];
  /** Slugs whose config changed or that the set creates. */
  changedServices: readonly string[];
}

/**
 * Services whose deployment a set changes: those whose config or own
 * variables change, and those whose _resolved_ environment changes because a
 * variable they reference (directly or through other variables) changed.
 *
 * Algorithm: a fixpoint over variables. Start from the changed variables;
 * any variable whose value references a changed one is changed too; repeat
 * until nothing new is marked. O(V × R) per pass, at most V passes.
 *
 * @param input - Post-apply variables and what the set touched.
 * @returns Affected slugs, sorted. `shared` is never one.
 * @example
 * affectedServices({
 *   services: { api: { DB: "${{db.URL}}" }, db: { URL: "x" } },
 *   shared: {},
 *   changedVariables: ["db.URL"],
 *   changedServices: [],
 * }); // ["api", "db"]
 */
export function affectedServices(input: AffectedInput): string[] {
  const values: { ns: string; key: string; refs: string[] }[] = [];
  const collect = (ns: string, vars: Readonly<Record<string, string>>) => {
    for (const [key, value] of Object.entries(vars)) {
      const refs = parseReferences(value).references.map((r) => `${r.namespace ?? ns}.${r.name}`);
      values.push({ ns, key, refs });
    }
  };
  for (const [slug, vars] of Object.entries(input.services)) collect(slug, vars);
  collect(SHARED_NAMESPACE, input.shared);

  const changed = new Set(input.changedVariables);
  for (let grew = true; grew; ) {
    grew = false;
    for (const v of values) {
      const id = `${v.ns}.${v.key}`;
      if (!changed.has(id) && v.refs.some((r) => changed.has(r))) {
        changed.add(id);
        grew = true;
      }
    }
  }
  const out = new Set(input.changedServices.filter((s) => s in input.services));
  for (const id of changed) {
    const ns = id.slice(0, id.indexOf("."));
    if (ns !== SHARED_NAMESPACE && ns in input.services) out.add(ns);
  }
  return [...out].sort();
}
