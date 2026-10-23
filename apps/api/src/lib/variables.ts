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
import { newId, parseReferences, type VariableScope } from "@roundhouse/shared";
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
import { ApiError, type ErrorDetail, notFound } from "./errors";

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

/** A variable as listed: secrets masked. */
export interface ListedVariable {
  key: string;
  value: string | null;
  is_secret: boolean;
  version: number;
  updated_at: number;
}

/**
 * Lists a scope's variables, decrypting only non-secret values.
 *
 * @param db - Database client.
 * @param key - Project DEK.
 * @param t - Scope.
 * @returns Variables sorted by key.
 */
export async function listVariables(
  db: Db,
  key: CryptoKey,
  t: VariableTarget,
): Promise<ListedVariable[]> {
  const rows = await db.select().from(variables).where(scopeWhere(t)).orderBy(variables.key);
  return Promise.all(
    rows.map(async (r) => ({
      key: r.key,
      value: r.isSecret ? null : await unsealWith(key, r.valueSealed, variableAad(t, r.key)),
      is_secret: r.isSecret,
      version: r.version,
      updated_at: +r.updatedAt,
    })),
  );
}

/**
 * Upserts and deletes a scope's variables in one batch.
 *
 * @param db - Database client.
 * @param key - Project DEK.
 * @param t - Scope.
 * @param change - Values to set and keys to delete.
 * @returns Keys that changed, for the audit record.
 */
export async function putVariables(
  db: Db,
  key: CryptoKey,
  t: VariableTarget,
  change: { set: { key: string; value: string; is_secret?: boolean }[]; delete: string[] },
): Promise<{ set: string[]; deleted: string[] }> {
  const existing = new Map<string, VariableRow>();
  const keys = [...change.set.map((s) => s.key), ...change.delete];
  if (keys.length) {
    const rows = await db
      .select()
      .from(variables)
      .where(and(scopeWhere(t), inArray(variables.key, keys)));
    for (const r of rows) existing.set(r.key, r);
  }
  const now = new Date();
  const statements = [];
  for (const s of change.set) {
    const valueSealed = await sealWith(key, s.value, variableAad(t, s.key));
    const prior = existing.get(s.key);
    if (prior) {
      statements.push(
        db
          .update(variables)
          .set({
            valueSealed,
            isSecret: s.is_secret ?? prior.isSecret,
            version: prior.version + 1,
            updatedAt: now,
          })
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
          isSecret: s.is_secret ?? false,
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
  return { set: change.set.map((s) => s.key), deleted };
}

/**
 * Decrypts the given keys of a scope.
 *
 * @param db - Database client.
 * @param key - Project DEK.
 * @param t - Scope.
 * @param keys - Keys to reveal; unknown keys are skipped.
 * @returns Plaintext values in request order.
 */
export async function revealVariables(
  db: Db,
  key: CryptoKey,
  t: VariableTarget,
  keys: readonly string[],
): Promise<{ key: string; value: string }[]> {
  const rows = await db
    .select()
    .from(variables)
    .where(and(scopeWhere(t), inArray(variables.key, [...keys])));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out: { key: string; value: string }[] = [];
  for (const k of keys) {
    const r = byKey.get(k);
    if (r) out.push({ key: k, value: await unsealWith(key, r.valueSealed, variableAad(t, k)) });
  }
  return out;
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
  const out: EnvironmentVariables = { services: {}, shared: {}, secrets: {}, sharedSecrets: [] };
  for (const s of live) {
    out.services[s.slug] = {};
    out.secrets[s.slug] = [];
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
      if (r.isSecret) out.sharedSecrets.push(value);
      continue;
    }
    const slug = r.serviceId ? slugOf.get(r.serviceId) : undefined;
    if (!slug) continue;
    const value = await unsealWith(key, r.valueSealed, variableAad(t, r.key));
    out.services[slug]![r.key] = value;
    if (r.isSecret) out.secrets[slug]!.push(value);
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
        isSecret: r.isSecret,
      } satisfies typeof variables.$inferInsert;
    }),
  );
}
