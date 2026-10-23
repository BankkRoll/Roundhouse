/**
 * A service's resolved environment with every secret, and every plain value
 * derived from one, held back: what `GET …/variables/resolved` and the MCP
 * `resolve_variables` tool return, so both apply the same rule.
 *
 * @module
 */
import type { Db, environments } from "@roundhouse/db";
import { secretDerivedVariables } from "@roundhouse/shared";
import { ApiError } from "./errors";
import { resolveServiceEnvironment } from "./resolve-env";
import { loadEnvironmentVariables } from "./variables";

/** Which service to resolve, and where. */
export interface PlainEnvironmentTarget {
  projectId: string;
  service: { id: string; slug: string };
  environment: typeof environments.$inferSelect;
}

/** Resolved plain values, and the keys a local run must supply itself. */
export interface PlainEnvironment {
  /** Resolved values by key, sorted; never a secret or secret-derived value. */
  variables: Record<string, string>;
  /** Secret keys and plain keys whose resolution reaches a secret, sorted. */
  localKeys: string[];
}

/**
 * Resolves a service's environment as a deployment would get it, then drops
 * every secret and every plain variable whose resolution reaches a secret.
 *
 * @param db - Database client.
 * @param key - Project DEK.
 * @param target - Project, service and environment.
 * @returns Plain values and the withheld keys.
 * @throws {ApiError} 400 `invalid_reference` with one detail per resolution error.
 */
export async function resolvePlainEnvironment(
  db: Db,
  key: CryptoKey,
  target: PlainEnvironmentTarget,
): Promise<PlainEnvironment> {
  const { projectId, service, environment } = target;
  const vars = await loadEnvironmentVariables(db, key, projectId, environment.id);
  const result = await resolveServiceEnvironment(
    db,
    key,
    { projectId, serviceId: service.id, environment },
    { variables: vars },
  );
  if (!result.ok) {
    const first = result.errors[0]!;
    throw new ApiError(
      400,
      "invalid_reference",
      `${first.variable.namespace}.${first.variable.name}: ${first.message}`,
      result.errors.map((e) => ({
        field: `${e.variable.namespace}.${e.variable.name}`,
        code: e.code,
        message: e.message,
        ...(e.start !== undefined ? { start: e.start, end: e.end } : {}),
      })),
    );
  }
  // SECURITY: Secret values are write-only (ADR 0014), and a plain value
  // that references one carries it once resolved, so both stay local.
  const taint = secretDerivedVariables({
    services: vars.services,
    shared: vars.shared,
    secretServiceKeys: vars.secretKeys,
    secretSharedKeys: vars.sharedSecretKeys,
  });
  const local = new Set([
    ...(vars.secretKeys[service.slug] ?? []),
    ...(taint.services[service.slug] ?? []),
  ]);
  const variables: Record<string, string> = {};
  for (const k of Object.keys(result.env).sort()) {
    if (!local.has(k)) variables[k] = result.env[k]!;
  }
  return { variables, localKeys: [...local].sort() };
}
