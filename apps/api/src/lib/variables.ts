/**
 * Encrypted variables: each project's data key (DEK), sealing and unsealing
 * values, reference-syntax validation on write, and decrypting a whole
 * environment for resolution at deploy time or log redaction.
 *
 * Values are AES-256-GCM under the project DEK with AAD
 * `variable:<project>:<environment>:<scope>:<service|->:<key>`, so a value
 * can't be moved to another key, scope or project undetected. The DEK is
 * sealed under the master-derived KEK in `project_keys`.
 *
 * @module
 */
import { type Db, projectKeys, services, variables } from "@roundhouse/db";
import {
  type ClassificationWarningCode,
  classifyVariable,
  decideVariableTier,
  newId,
  parseReferences,
  type VariableScope,
  type VariableTier,
} from "@roundhouse/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  deriveProjectKey,
  generateDataKey,
  projectKeyAad,
  type Sealed,
  seal,
  sealWith,
  unsealWith,
} from "./crypto";
import { ApiError, conflict, type ErrorCode, type ErrorDetail, notFound } from "./errors";

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
 * AAD of one variable value.
 *
 * @param t - The variable's scope.
 * @param key - Variable name.
 * @returns The AAD string.
 */
export function variableAad(t: VariableTarget, key: string): string {
  return `variable:${t.projectId}:${t.environmentId}:${t.scope}:${t.serviceId ?? "-"}:${key}`;
}

/**
 * AAD of a deployment's sealed environment.
 *
 * @param deploymentId - The deployment.
 * @returns The AAD string.
 */
export function deploymentEnvAad(deploymentId: string): string {
  return `deployment-env:${deploymentId}`;
}

/**
 * Creates a project's DEK sealed under the KEK, as a `project_keys` row to
 * insert in the same batch as the project.
 *
 * NOTE: Returns the row, not the insert: an async function returning a
 * Drizzle query would run it, because queries are thenables.
 *
 * @param masterKey - Base64 master key.
 * @param projectId - New project's ID.
 * @returns The row to insert.
 */
export async function newProjectKeyRow(masterKey: string, projectId: string) {
  const dekSealed = await seal(masterKey, generateDataKey(), projectKeyAad(projectId));
  return { projectId, dekSealed } satisfies typeof projectKeys.$inferInsert;
}

// PERF: Every variable read and every log batch needs the DEK. Caching the
// imported key per isolate skips a D1 read, an unseal and an import. Bounded
// so a long-lived isolate serving many projects doesn't grow without limit.
const KEY_CACHE_LIMIT = 256;
const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * Loads (and caches) a project's DEK.
 *
 * @param db - Database client.
 * @param masterKey - Base64 master key.
 * @param projectId - The project.
 * @returns The usable AES-GCM key.
 * @throws {ApiError} 404 when the project has no key.
 */
export function projectKey(db: Db, masterKey: string, projectId: string): Promise<CryptoKey> {
  const cached = keyCache.get(projectId);
  if (cached) return cached;
  const loading = (async () => {
    const row = await db.query.projectKeys.findFirst({
      where: eq(projectKeys.projectId, projectId),
    });
    if (!row) throw notFound("Project key");
    return deriveProjectKey(masterKey, projectId, row.dekSealed as Sealed);
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
  version: number;
  updated_at: number;
  updated_by: string | null;
}

/**
 * Lists a scope's variables. Only plain values are ever decrypted, and only
 * when `plain` says the caller may read them.
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
      value:
        r.tier === "plain" && options.plain
          ? await unsealWith(key, r.valueSealed, variableAad(t, r.key))
          : null,
      fingerprint: r.fingerprint,
      available_at_build: r.availableAtBuild,
      mount_as_file: r.mountAsFile,
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

/**
 * Upserts and deletes a scope's variables in one batch, deciding each tier
 * with the shared classifier.
 *
 * Refuses the whole write (nothing is stored) when a value would become
 * secret without `confirm_write_only`, a public variable looks like a
 * credential without being acknowledged, a tier contradicts a lock, a
 * secret would become plain without a new value, or an `expected_version`
 * is stale.
 *
 * TODO(api-secrets-crypto): seal v2 and fill `fingerprint` (ADR 0014 "Crypto").
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
): Promise<{ set: string[]; deleted: string[]; warnings: VariableWriteWarning[] }> {
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
  const needConfirm: string[] = [];
  const needAck: string[] = [];
  const planned: { entry: VariableSetEntry; value: string; tier: VariableTier; locked: boolean }[] =
    [];
  for (const s of change.set) {
    const prior = existing.get(s.key);
    if (s.expected_version !== undefined && prior && prior.version !== s.expected_version) {
      throw conflict(`${s.key} changed since version ${s.expected_version}`);
    }
    if (s.value === undefined && !prior) {
      problems.push(detail(s.key, "value_required", "A new variable needs a value"));
      continue;
    }
    const value = s.value ?? (await unsealWith(key, prior!.valueSealed, variableAad(t, s.key)));
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
    for (const w of classification.warnings) {
      if (w.code === "public_prefix_secret_value" && !change.acknowledge_public.includes(s.key)) {
        needAck.push(s.key);
      }
      warnings.push({ key: s.key, code: w.code, message: w.message });
    }
    if (decision.tier === "secret" && prior?.tier !== "secret") needConfirm.push(s.key);
    planned.push({ entry: s, value, tier: decision.tier, locked: decision.locked });
  }
  if (problems.length) {
    const first = problems[0]!;
    throw new ApiError(400, first.code as ErrorCode, `${first.field}: ${first.message}`, problems);
  }
  if (needAck.length) {
    throw new ApiError(
      400,
      "public_prefix_secret_value",
      `${needAck.join(", ")} will ship to every browser but look${needAck.length === 1 ? "s" : ""} like a credential; add ${needAck.length === 1 ? "it" : "them"} to acknowledge_public to store anyway`,
      needAck.map((k) => detail(k, "public_prefix_secret_value", "Looks like a credential")),
    );
  }
  if (needConfirm.length && !change.confirm_write_only) {
    throw new ApiError(
      400,
      "confirmation_required",
      `${needConfirm.join(", ")} will be write-only: nobody can read ${needConfirm.length === 1 ? "it" : "them"} back. Resend with confirm_write_only to continue`,
      needConfirm.map((k) => detail(k, "confirmation_required", "Becomes write-only")),
    );
  }

  const now = new Date();
  const statements = [];
  for (const { entry: s, value, tier, locked } of planned) {
    const valueSealed = await sealWith(key, value, variableAad(t, s.key));
    const prior = existing.get(s.key);
    const flags = {
      tier,
      locked,
      availableAtBuild: s.available_at_build ?? prior?.availableAtBuild ?? false,
      mountAsFile: s.mount_as_file ?? prior?.mountAsFile ?? false,
      updatedBy: actorId,
    };
    if (prior) {
      statements.push(
        db
          .update(variables)
          .set({ valueSealed, ...flags, version: prior.version + 1, updatedAt: now })
          .where(eq(variables.id, prior.id)),
      );
    } else {
      statements.push(
        db.insert(variables).values({
          id: newId("variable"),
          scope: t.scope,
          projectId: t.projectId,
          environmentId: t.environmentId,
          serviceId: t.serviceId,
          key: s.key,
          valueSealed,
          ...flags,
        }),
      );
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
  return { set: planned.map((p) => p.entry.key), deleted, warnings };
}

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
    const t: VariableTarget = {
      projectId,
      environmentId,
      scope: r.scope,
      serviceId: r.serviceId,
    };
    if (r.scope === "shared") {
      const value = await unsealWith(key, r.valueSealed, variableAad(t, r.key));
      out.shared[r.key] = value;
      if (r.tier === "secret") {
        out.sharedSecrets.push(value);
        out.sharedSecretKeys.push(r.key);
      }
      continue;
    }
    const slug = r.serviceId ? slugOf.get(r.serviceId) : undefined;
    if (!slug) continue;
    const value = await unsealWith(key, r.valueSealed, variableAad(t, r.key));
    out.services[slug]![r.key] = value;
    if (r.tier === "secret") {
      out.secrets[slug]!.push(value);
      out.secretKeys[slug]!.push(r.key);
    }
  }
  return out;
}

/**
 * Copies every variable of one environment into another, re-sealing each
 * value for its new AAD. Returns rows to insert in the same batch as the
 * environment (rows, not inserts; see {@link newProjectKeyRow}).
 *
 * @param db - Database client.
 * @param key - Project DEK.
 * @param projectId - The project.
 * @param fromEnvironmentId - Source environment.
 * @param toEnvironmentId - New environment.
 * @returns Rows to insert.
 */
export async function copiedVariableRows(
  db: Db,
  key: CryptoKey,
  projectId: string,
  fromEnvironmentId: string,
  toEnvironmentId: string,
) {
  const rows = await db
    .select()
    .from(variables)
    .where(and(eq(variables.projectId, projectId), eq(variables.environmentId, fromEnvironmentId)));
  return Promise.all(
    rows.map(async (r) => {
      const from: VariableTarget = {
        projectId,
        environmentId: fromEnvironmentId,
        scope: r.scope,
        serviceId: r.serviceId,
      };
      const to: VariableTarget = { ...from, environmentId: toEnvironmentId };
      const plaintext = await unsealWith(key, r.valueSealed, variableAad(from, r.key));
      return {
        id: newId("variable"),
        scope: r.scope,
        projectId,
        environmentId: toEnvironmentId,
        serviceId: r.serviceId,
        key: r.key,
        valueSealed: await sealWith(key, plaintext, variableAad(to, r.key)),
        tier: r.tier,
        locked: r.locked,
        fingerprint: r.fingerprint,
        availableAtBuild: r.availableAtBuild,
        mountAsFile: r.mountAsFile,
        updatedBy: r.updatedBy,
      } satisfies typeof variables.$inferInsert;
    }),
  );
}
