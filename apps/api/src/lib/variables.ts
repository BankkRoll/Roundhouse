/**
 * Encrypted variables (ADR 0014 "Secrets", "Crypto"):
 *
 * - each project's data key (DEK), sealed under the master keyring's KEK in
 *   `project_keys`;
 * - sealing and unsealing values: format 2 under the DEK with AAD
 *   `variable:v2:<ws>:<prj>:<env>:<scope>:<svc|->:<key>:<row_id>:<version>`,
 *   re-sealed on every version bump, so a value can't be moved to another
 *   row or rolled back undetected; format 1 rows (AAD without workspace, row
 *   and version) stay readable until the rotation workflow re-seals them;
 * - keyed fingerprints, stored on every write;
 * - the tier decision on write (classifier, locks, write-only confirmation,
 *   public-prefix acknowledgement) and reference-syntax validation;
 * - build-time checks: build args and build-time variables stay plain and
 *   away from names the builder reserves;
 * - decrypting a whole environment for resolution at deploy time or log
 *   redaction.
 *
 * @module
 */
import { type Db, projectKeys, projects, services, variables } from "@roundhouse/db";
import {
  type ClassificationWarningCode,
  classifyVariable,
  decideVariableTier,
  detectSecretValue,
  hasHighEntropyToken,
  isReservedBuildName,
  newId,
  parseReferences,
  SHARED_NAMESPACE,
  secretDerivedVariables,
  secretLengthWarnings,
  type VariableScope,
  type VariableTier,
} from "@roundhouse/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  dataKeyInfo,
  generateDataKey,
  type KeyEnv,
  openDataKey,
  type Sealed,
  type SealedV2,
  sealDataKey,
  sealWith,
  unsealWith,
  valueFingerprint,
} from "./crypto";
import { ApiError, conflict, type ErrorCode, type ErrorDetail, notFound } from "./errors";
import { variableAadV2 } from "./keyring";

type VariableRow = typeof variables.$inferSelect;

/** Which variables a call is about. */
export interface VariableTarget {
  projectId: string;
  environmentId: string;
  scope: VariableScope;
  /** Set exactly when `scope` is `service`. */
  serviceId: string | null;
}

/**
 * Format 1 AAD of one variable value. Only for reading rows written before
 * format 2; new values are sealed with {@link sealVariable}.
 *
 * @param t - The variable's scope.
 * @param key - Variable name.
 * @returns The AAD string.
 */
export function variableAad(t: VariableTarget, key: string): string {
  return `variable:${t.projectId}:${t.environmentId}:${t.scope}:${t.serviceId ?? "-"}:${key}`;
}

/** The coordinates of a stored variable that its format 2 AAD binds. */
export type StoredVariable = Pick<
  VariableRow,
  "id" | "projectId" | "environmentId" | "scope" | "serviceId" | "key" | "version"
>;

function storedAad(key: CryptoKey, row: StoredVariable, format: 1 | 2): string {
  if (format === 1) return variableAad(row, row.key);
  return variableAadV2({
    workspaceId: dataKeyInfo(key).workspaceId,
    projectId: row.projectId,
    environmentId: row.environmentId,
    scope: row.scope,
    serviceId: row.serviceId,
    key: row.key,
    rowId: row.id,
    version: row.version,
  });
}

/**
 * Decrypts a stored variable, whichever format sealed it.
 *
 * @param key - The project DEK.
 * @param row - The row (its id and version are part of the format 2 AAD).
 * @returns The raw value.
 * @throws When the ciphertext doesn't belong to this row and version.
 */
export function openVariable(
  key: CryptoKey,
  row: StoredVariable & { valueSealed: Sealed },
): Promise<string> {
  return unsealWith(key, row.valueSealed, storedAad(key, row, row.valueSealed.v));
}

/**
 * Seals a value for a row at a version (format 2) and fingerprints it.
 * Every write that bumps `version` must call this again.
 *
 * @param key - The project DEK.
 * @param row - Where the value will be stored, at the version it will have.
 * @param value - The raw value.
 * @returns The columns to store.
 */
export async function sealVariable(
  key: CryptoKey,
  row: StoredVariable,
  value: string,
): Promise<{ valueSealed: SealedV2; fingerprint: string }> {
  const [valueSealed, fingerprint] = await Promise.all([
    sealWith(key, value, storedAad(key, row, 2)),
    valueFingerprint(key, value),
  ]);
  return { valueSealed, fingerprint };
}

// -----------------------------------------------------------------------------
// Deployment inputs
// -----------------------------------------------------------------------------

/**
 * Format 1 AAD of a deployment's sealed environment. Only for reading;
 * `sealDeploymentEnv` in `./desired-state` seals format 2.
 *
 * @param deploymentId - The deployment.
 * @returns The AAD string.
 */
export function deploymentEnvAad(deploymentId: string): string {
  return `deployment-env:${deploymentId}`;
}

// -----------------------------------------------------------------------------
// Project keys
// -----------------------------------------------------------------------------

/**
 * Creates a project's DEK sealed under the current KEK, as a `project_keys`
 * row to insert in the same batch as the project.
 *
 * NOTE: Returns the row, not the insert: an async function returning a
 * Drizzle query would run it, because queries are thenables.
 *
 * @param keys - The keyring bindings.
 * @param projectId - New project's ID.
 * @param workspaceId - Its workspace; part of the DEK's AAD.
 * @returns The row to insert.
 */
export async function newProjectKeyRow(keys: KeyEnv, projectId: string, workspaceId: string) {
  const sealed = await sealDataKey(keys, generateDataKey(), workspaceId, projectId);
  return { projectId, ...sealed } satisfies typeof projectKeys.$inferInsert;
}

// PERF: Every variable read and every log batch needs the DEK. Caching the
// imported key per isolate skips a D1 read, an unseal and an import. Bounded
// so a long-lived isolate serving many projects doesn't grow without limit.
// A master key rotation re-wraps the DEK but never changes it, so a cached
// key stays valid across one.
const KEY_CACHE_LIMIT = 256;
const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * Loads (and caches) a project's DEK.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @param projectId - The project.
 * @returns The usable AES-GCM key.
 * @throws {ApiError} 404 when the project has no key.
 */
export function projectKey(db: Db, keys: KeyEnv, projectId: string): Promise<CryptoKey> {
  const cached = keyCache.get(projectId);
  if (cached) return cached;
  const loading = (async () => {
    const [row] = await db
      .select({ dekSealed: projectKeys.dekSealed, workspaceId: projects.workspaceId })
      .from(projectKeys)
      .innerJoin(projects, eq(projects.id, projectKeys.projectId))
      .where(eq(projectKeys.projectId, projectId))
      .limit(1);
    if (!row) throw notFound("Project key");
    return openDataKey(keys, row.dekSealed as Sealed, row.workspaceId, projectId);
  })().catch((err) => {
    keyCache.delete(projectId);
    throw err;
  });
  if (keyCache.size >= KEY_CACHE_LIMIT) {
    const oldest = keyCache.keys().next().value;
    if (oldest !== undefined) keyCache.delete(oldest);
  }
  keyCache.set(projectId, loading);
  return loading;
}

// -----------------------------------------------------------------------------
// Reads and writes
// -----------------------------------------------------------------------------

/**
 * Rejects values whose `${{…}}` references are malformed, reporting every
 * problem with its key and span. Unknown targets and cycles are only known
 * at deploy time.
 *
 * @param set - Values about to be written.
 * @throws {ApiError} 400 `invalid_reference` with `details`.
 */
export function assertValidReferences(set: readonly { key: string; value: string }[]): void {
  const details: ErrorDetail[] = [];
  for (const { key, value } of set) {
    for (const e of parseReferences(value).errors) {
      details.push({ field: key, code: e.code, message: e.message, start: e.start, end: e.end });
    }
  }
  if (details.length) {
    const first = details[0]!;
    throw new ApiError(
      400,
      "invalid_reference",
      `${first.field}: ${first.message} (at ${first.start}-${first.end})`,
      details,
    );
  }
}

function scopeWhere(t: VariableTarget) {
  return and(
    eq(variables.projectId, t.projectId),
    eq(variables.environmentId, t.environmentId),
    eq(variables.scope, t.scope),
    t.serviceId === null ? isNull(variables.serviceId) : eq(variables.serviceId, t.serviceId),
  );
}

/** A variable as listed; see `VariableSchema`. Never carries a secret value. */
export interface ListedVariable {
  key: string;
  tier: VariableTier;
  locked: boolean;
  value: string | null;
  fingerprint: string | null;
  available_at_build: boolean;
  mount_as_file: boolean;
  withheld: boolean;
  version: number;
  updated_at: number;
  updated_by: string | null;
}

/**
 * Lists a scope's variables. Only plain values are ever decrypted, and only
 * when `plain` says the caller may read them; everyone else (viewers
 * included) sees keys, tiers, flags and fingerprints.
 *
 * @param db - Database client.
 * @param key - Project DEK.
 * @param t - Scope.
 * @param options - `plain`: the caller holds `variables:read_plain`.
 * @returns Variables sorted by key.
 */
export async function listVariables(
  db: Db,
  key: CryptoKey,
  t: VariableTarget,
  options: { plain: boolean },
): Promise<ListedVariable[]> {
  const rows = await db.select().from(variables).where(scopeWhere(t)).orderBy(variables.key);
  return Promise.all(
    rows.map(async (r) => ({
      key: r.key,
      tier: r.tier,
      locked: r.locked,
      value: r.tier === "plain" && options.plain ? await openVariable(key, r) : null,
      fingerprint: r.fingerprint,
      available_at_build: r.availableAtBuild,
      mount_as_file: r.mountAsFile,
      withheld: r.withheld,
      version: r.version,
      updated_at: +r.updatedAt,
      updated_by: r.updatedBy,
    })),
  );
}

/** One upsert; see `VariableSetEntrySchema`. */
export interface VariableSetEntry {
  key: string;
  value?: string;
  tier?: VariableTier;
  available_at_build?: boolean;
  mount_as_file?: boolean;
  expected_version?: number;
}

/** A whole variables write; see `VariablesPutSchema`. */
export interface VariablesChange {
  set: VariableSetEntry[];
  delete: string[];
  confirm_write_only: boolean;
  acknowledge_public: string[];
}

/** One classifier warning of a write. */
export interface VariableWriteWarning {
  key: string;
  code: ClassificationWarningCode;
  message: string;
}

const detail = (key: string, code: string, message: string): ErrorDetail => ({
  field: key,
  code,
  message,
});

const plural = (keys: readonly string[], one: string, many: string) =>
  keys.length === 1 ? one : many;

const reservedMessage = (name: string) =>
  `${name} is reserved for the builder's own environment and can't be passed to a build`;

interface PlannedWrite {
  entry: VariableSetEntry;
  value: string;
  tier: VariableTier;
  locked: boolean;
  availableAtBuild: boolean;
  mountAsFile: boolean;
}

/**
 * Upserts and deletes a scope's variables in one batch, deciding each tier
 * with the shared classifier and sealing each value for its row and new
 * version, with its fingerprint.
 *
 * Refuses the whole write (nothing is stored) when:
 * - a tier contradicts a lock (`tier_locked`), or a secret would become
 *   plain without a new value (`value_required`);
 * - a build-time variable has a name the builder reserves (`invalid_request`);
 * - a public variable looks like a credential and isn't in
 *   `acknowledge_public` (`public_prefix_secret_value`);
 * - a value would become secret without `confirm_write_only`
 *   (`confirmation_required`, listing the keys);
 * - a plain build-time variable references a secret, directly or through
 *   other variables (`build_arg_secret`): build args end up in the image;
 * - an `expected_version` is stale (409).
 *
 * @param db - Database client.
 * @param key - Project DEK.
 * @param t - Scope.
 * @param change - The validated request body.
 * @param actorId - User making the change, stored as `updated_by`.
 * @returns Keys that changed, for the audit record, and warnings for the response.
 * @throws {ApiError} 400 with `details` per key, or 409 for a stale version.
 */
export async function putVariables(
  db: Db,
  key: CryptoKey,
  t: VariableTarget,
  change: VariablesChange,
  actorId: string | null,
): Promise<{
  set: string[];
  deleted: string[];
  /** Preview placeholders (ADR 0007) this write gave a real value. */
  unwithheld: string[];
  warnings: VariableWriteWarning[];
}> {
  const existing = new Map<string, VariableRow>();
  const keys = [...change.set.map((s) => s.key), ...change.delete];
  if (keys.length) {
    const rows = await db
      .select()
      .from(variables)
      .where(and(scopeWhere(t), inArray(variables.key, keys)));
    for (const r of rows) existing.set(r.key, r);
  }

  const warnings: VariableWriteWarning[] = [];
  const problems: ErrorDetail[] = [];
  const reserved: string[] = [];
  const needConfirm: string[] = [];
  const needAck: string[] = [];
  const planned: PlannedWrite[] = [];
  for (const s of change.set) {
    const prior = existing.get(s.key);
    if (s.expected_version !== undefined && prior && prior.version !== s.expected_version) {
      throw conflict(`${s.key} changed since version ${s.expected_version}`);
    }
    if (s.value === undefined && !prior) {
      problems.push(detail(s.key, "value_required", "A new variable needs a value"));
      continue;
    }
    const value = s.value ?? (await openVariable(key, prior!));
    const classification = classifyVariable(s.key, value);
    const decision = decideVariableTier({
      classification,
      ...(s.tier ? { requested: s.tier } : {}),
      ...(prior ? { previous: prior.tier } : {}),
      valueProvided: s.value !== undefined,
    });
    if (!decision.ok) {
      problems.push(detail(s.key, decision.code, decision.message));
      continue;
    }
    const availableAtBuild = s.available_at_build ?? prior?.availableAtBuild ?? false;
    if (availableAtBuild && isReservedBuildName(s.key)) reserved.push(s.key);
    // The classifier warns about short secrets only for its own default
    // tier; the stored tier is what decides whether logs can redact it.
    const fromClassifier = classification.warnings.filter(
      (w) => w.code !== "secret_too_short_to_redact" || decision.tier === "secret",
    );
    const lengthWarnings =
      decision.tier === "secret" && classification.tier !== "secret"
        ? secretLengthWarnings(s.key, value)
        : [];
    for (const w of [...fromClassifier, ...lengthWarnings]) {
      if (w.code === "public_prefix_secret_value" && !change.acknowledge_public.includes(s.key)) {
        needAck.push(s.key);
      }
      warnings.push({ key: s.key, code: w.code, message: w.message });
    }
    if (decision.tier === "secret" && prior?.tier !== "secret") needConfirm.push(s.key);
    planned.push({
      entry: s,
      value,
      tier: decision.tier,
      locked: decision.locked,
      availableAtBuild,
      mountAsFile: s.mount_as_file ?? prior?.mountAsFile ?? false,
    });
  }
  if (problems.length) {
    const first = problems[0]!;
    throw new ApiError(400, first.code as ErrorCode, `${first.field}: ${first.message}`, problems);
  }
  if (reserved.length) {
    throw new ApiError(
      400,
      "invalid_request",
      reservedMessage(reserved.join(", ")),
      reserved.map((k) => detail(k, "reserved_name", reservedMessage(k))),
    );
  }
  if (needAck.length) {
    throw new ApiError(
      400,
      "public_prefix_secret_value",
      `${needAck.join(", ")} will ship to every browser but ${plural(needAck, "looks", "look")} like a credential; add ${plural(needAck, "it", "them")} to acknowledge_public to store anyway`,
      needAck.map((k) => detail(k, "public_prefix_secret_value", "Looks like a credential")),
    );
  }
  if (needConfirm.length && !change.confirm_write_only) {
    throw new ApiError(
      400,
      "confirmation_required",
      `${needConfirm.join(", ")} will be write-only: nobody can read ${plural(needConfirm, "it", "them")} back. Resend with confirm_write_only to continue`,
      needConfirm.map((k) => detail(k, "confirmation_required", "Becomes write-only")),
    );
  }
  await assertPlainAtBuild(db, key, t, planned, change.delete);

  const now = new Date();
  const statements = [];
  for (const p of planned) {
    const prior = existing.get(p.entry.key);
    const coordinates: StoredVariable = {
      id: prior?.id ?? newId("variable"),
      projectId: t.projectId,
      environmentId: t.environmentId,
      scope: t.scope,
      serviceId: t.serviceId,
      key: p.entry.key,
      version: prior ? prior.version + 1 : 1,
    };
    const sealed = await sealVariable(key, coordinates, p.value);
    const columns = {
      ...sealed,
      tier: p.tier,
      locked: p.locked,
      availableAtBuild: p.availableAtBuild,
      mountAsFile: p.mountAsFile,
      // A new value replaces a preview placeholder; a flags-only write keeps it one.
      withheld: p.entry.value === undefined ? (prior?.withheld ?? false) : false,
      updatedBy: actorId,
      version: coordinates.version,
    };
    if (prior) {
      statements.push(
        db
          .update(variables)
          .set({ ...columns, updatedAt: now })
          .where(eq(variables.id, prior.id)),
      );
    } else {
      statements.push(db.insert(variables).values({ ...coordinates, ...columns }));
    }
  }
  const deleted = change.delete.filter((k) => existing.has(k));
  if (deleted.length) {
    statements.push(
      db.delete(variables).where(and(scopeWhere(t), inArray(variables.key, deleted))),
    );
  }
  if (statements.length) {
    await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
  }
  const unwithheld = planned
    .filter((p) => p.entry.value !== undefined && existing.get(p.entry.key)?.withheld)
    .map((p) => p.entry.key);
  return { set: planned.map((p) => p.entry.key), deleted, unwithheld, warnings };
}

/**
 * Refuses plain build-time variables of a write whose resolution would reach
 * a secret, against the environment as it will be after the write. Only
 * loads the environment when such a variable has references at all.
 */
async function assertPlainAtBuild(
  db: Db,
  key: CryptoKey,
  t: VariableTarget,
  planned: readonly PlannedWrite[],
  deletes: readonly string[],
): Promise<void> {
  const candidates = planned.filter(
    (p) =>
      p.tier === "plain" && p.availableAtBuild && parseReferences(p.value).references.length > 0,
  );
  if (!candidates.length) return;
  const loaded = await loadEnvironmentVariables(db, key, t.projectId, t.environmentId);
  let namespace = SHARED_NAMESPACE;
  if (t.scope === "service") {
    const [svc] = await db
      .select({ slug: services.slug })
      .from(services)
      .where(eq(services.id, t.serviceId!))
      .limit(1);
    if (!svc) throw notFound("Service");
    namespace = svc.slug;
  }
  const shared = t.scope === "shared";
  const values = { ...(shared ? loaded.shared : (loaded.services[namespace] ?? {})) };
  const secretKeys = new Set(shared ? loaded.sharedSecretKeys : loaded.secretKeys[namespace]);
  for (const k of deletes) {
    delete values[k];
    secretKeys.delete(k);
  }
  for (const p of planned) {
    values[p.entry.key] = p.value;
    if (p.tier === "secret") secretKeys.add(p.entry.key);
    else secretKeys.delete(p.entry.key);
  }
  const taint = secretDerivedVariables({
    services: shared ? loaded.services : { ...loaded.services, [namespace]: values },
    shared: shared ? values : loaded.shared,
    secretServiceKeys: shared
      ? loaded.secretKeys
      : { ...loaded.secretKeys, [namespace]: [...secretKeys] },
    secretSharedKeys: shared ? [...secretKeys] : loaded.sharedSecretKeys,
  });
  const tainted = new Set(shared ? taint.shared : (taint.services[namespace] ?? []));
  const refused = candidates.map((p) => p.entry.key).filter((k) => tainted.has(k));
  if (refused.length) throw buildArgSecret(refused, "references a secret");
}

function buildArgSecret(names: readonly string[], why: string): ApiError {
  const message = (name: string) =>
    `${name} ${why}; make it a secret variable with available_at_build and read it with RUN --mount=type=secret,id=${name}`;
  return new ApiError(
    400,
    "build_arg_secret",
    message(names.join(", ")),
    names.map((n) => detail(n, "build_arg_secret", message(n))),
  );
}

/** What {@link assertPlainBuildArgs} checks. */
export interface BuildArgsCheck {
  projectId: string;
  environmentId: string;
  /**
   * Slug of the service the args belong to, which unqualified references
   * name; `null` for a service not created yet (it has no variables).
   */
  serviceSlug: string | null;
  /** The service config's `build` part, as it will be stored. */
  build: { build_args?: Record<string, string>; secret_build_args?: string[] | undefined };
}

/**
 * Checks a service config's build args before it is saved (ADR 0014
 * "Builds"): build args end up in the image and its history, so they stay
 * plain.
 *
 * - Names the builder reserves for its own process environment (`PATH`,
 *   `LD_*`, `GIT_*`, `*_PROXY`, … see `isReservedBuildName`) are refused
 *   with 400 `invalid_request`.
 * - A value with a known credential format or a high-entropy token, or one
 *   referencing a secret (or a plain variable derived from one) of the
 *   environment, is refused with 400 `build_arg_secret`. Args named in
 *   `secret_build_args` are already passed as BuildKit secrets and skip
 *   this check. References the save can't resolve are checked again at
 *   deploy.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings, to read the environment's variables
 *   when an arg has references.
 * @param input - The args and where they are saved.
 * @throws {ApiError} 400 `invalid_request` or `build_arg_secret`, with one detail per arg.
 * @example
 * await assertPlainBuildArgs(db, c.env, {
 *   projectId, environmentId, serviceSlug: service.slug, build: spec.build,
 * });
 */
export async function assertPlainBuildArgs(
  db: Db,
  keys: KeyEnv,
  input: BuildArgsCheck,
): Promise<void> {
  const args = Object.entries(input.build.build_args ?? {});
  if (!args.length) return;
  const reserved = args.map(([name]) => name).filter(isReservedBuildName);
  if (reserved.length) {
    throw new ApiError(
      400,
      "invalid_request",
      reservedMessage(reserved.join(", ")),
      reserved.map((k) => detail(k, "reserved_name", reservedMessage(k))),
    );
  }
  const passedAsSecret = new Set(input.build.secret_build_args ?? []);
  const plainArgs = args.filter(([name]) => !passedAsSecret.has(name));
  const looksSecret = plainArgs
    .filter(([, value]) => detectSecretValue(value) !== null || hasHighEntropyToken(value))
    .map(([name]) => name);
  if (looksSecret.length) throw buildArgSecret(looksSecret, "looks secret");

  const withRefs = plainArgs
    .map(([name, value]) => ({ name, refs: parseReferences(value).references }))
    .filter((a) => a.refs.length > 0);
  if (!withRefs.length) return;
  const loaded = await loadEnvironmentVariables(
    db,
    await projectKey(db, keys, input.projectId),
    input.projectId,
    input.environmentId,
  );
  const taint = secretDerivedVariables({
    services: loaded.services,
    shared: loaded.shared,
    secretServiceKeys: loaded.secretKeys,
    secretSharedKeys: loaded.sharedSecretKeys,
  });
  const secretIds = new Set<string>();
  for (const [slug, names] of Object.entries(loaded.secretKeys)) {
    for (const n of [...names, ...(taint.services[slug] ?? [])]) secretIds.add(`${slug}.${n}`);
  }
  for (const n of [...loaded.sharedSecretKeys, ...taint.shared]) {
    secretIds.add(`${SHARED_NAMESPACE}.${n}`);
  }
  const refused = withRefs
    .filter((a) =>
      a.refs.some((r) => {
        const ns = r.namespace ?? input.serviceSlug;
        return ns !== null && secretIds.has(`${ns}.${r.name}`);
      }),
    )
    .map((a) => a.name);
  if (refused.length) throw buildArgSecret(refused, "references a secret");
}

// -----------------------------------------------------------------------------
// Whole environments
// -----------------------------------------------------------------------------

/** Every variable of an environment, decrypted. */
export interface EnvironmentVariables {
  /** Service variables by service slug. */
  services: Record<string, Record<string, string>>;
  /** Shared variables of the environment. */
  shared: Record<string, string>;
  /** Plaintext of every secret value, by service slug, for log redaction. */
  secrets: Record<string, string[]>;
  /** Plaintext of every shared secret value. */
  sharedSecrets: string[];
  /** Keys stored with tier `secret`, by service slug, for taint checks. */
  secretKeys: Record<string, string[]>;
  /** Shared keys stored with tier `secret`. */
  sharedSecretKeys: string[];
}

/**
 * Decrypts every variable of the live services of a project environment.
 * Only for deploy-time resolution and log redaction; never return it.
 *
 * @param db - Database client.
 * @param key - Project DEK.
 * @param projectId - The project.
 * @param environmentId - The environment.
 * @returns Decrypted values keyed by service slug.
 */
export async function loadEnvironmentVariables(
  db: Db,
  key: CryptoKey,
  projectId: string,
  environmentId: string,
): Promise<EnvironmentVariables> {
  const [rows, live] = await Promise.all([
    db
      .select()
      .from(variables)
      .where(and(eq(variables.projectId, projectId), eq(variables.environmentId, environmentId))),
    db
      .select({ id: services.id, slug: services.slug })
      .from(services)
      .where(and(eq(services.projectId, projectId), isNull(services.deletedAt))),
  ]);
  const slugOf = new Map(live.map((s) => [s.id, s.slug]));
  const out: EnvironmentVariables = {
    services: {},
    shared: {},
    secrets: {},
    sharedSecrets: [],
    secretKeys: {},
    sharedSecretKeys: [],
  };
  for (const s of live) {
    out.services[s.slug] = {};
    out.secrets[s.slug] = [];
    out.secretKeys[s.slug] = [];
  }
  for (const r of rows) {
    if (r.scope === "shared") {
      const value = await openVariable(key, r);
      out.shared[r.key] = value;
      if (r.tier === "secret") {
        out.sharedSecrets.push(value);
        out.sharedSecretKeys.push(r.key);
      }
      continue;
    }
    const slug = r.serviceId ? slugOf.get(r.serviceId) : undefined;
    if (!slug) continue;
    const value = await openVariable(key, r);
    out.services[slug]![r.key] = value;
    if (r.tier === "secret") {
      out.secrets[slug]!.push(value);
      out.secretKeys[slug]!.push(r.key);
    }
  }
  return out;
}
