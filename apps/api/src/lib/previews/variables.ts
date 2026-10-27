/**
 * The variables of a new preview environment (ADR 0007, "Secrets", and ADR
 * 0014 section 14): which base values it copies, which it replaces with
 * fresh database credentials, and which it withholds.
 *
 * {@link planPreviewVariables} is pure so the rule the whole feature is
 * built around can be tested as a table: a preview that withholds secrets
 * never receives a value that is secret, looks secret, or resolves through
 * one, except the database credentials minted for the preview itself.
 *
 * @module
 */
import {
  classifyVariable,
  SHARED_NAMESPACE,
  secretDerivedVariables,
  type VariableScope,
  type VariableTier,
} from "@roundhouse/shared";

/** One variable of the base environment, decrypted. */
export interface BaseVariable {
  scope: VariableScope;
  /** Set for `service` scope. */
  serviceId: string | null;
  key: string;
  value: string;
  tier: VariableTier;
  locked: boolean;
  availableAtBuild: boolean;
  mountAsFile: boolean;
}

/** Fresh credentials of one database service, minted for the preview. */
export interface FreshCredentials {
  serviceId: string;
  entries: readonly { key: string; value: string; tier: VariableTier; locked: boolean }[];
}

/** A variable to write into the preview environment. */
export interface PlannedVariable extends BaseVariable {
  /** An empty placeholder for a value the preview may not have. */
  withheld: boolean;
}

/** Input of {@link planPreviewVariables}. */
export interface PreviewVariablePlanInput {
  base: readonly BaseVariable[];
  /** Service slug by ID, for references between services. */
  slugs: ReadonlyMap<string, string>;
  fresh: readonly FreshCredentials[];
  /** Replace secrets with placeholders (forks, or `same_repo_secrets: "omit"`). */
  withhold: boolean;
}

/**
 * Plans a preview's variables.
 *
 * 1. Copy every base variable.
 * 2. Replace each database service's credential variables with the fresh
 *    ones: a preview's database starts empty and the image applies
 *    credentials only when it initialises, so copied ones would neither
 *    work nor be needed.
 * 3. With `withhold`, mark as secret every copied value that is stored
 *    `secret` or whose value the classifier recognises as a credential
 *    (whatever its stored tier), then every plain value whose references
 *    reach one of those (`secretDerivedVariables`), and replace them all
 *    with empty placeholders. References into the fresh credentials stay,
 *    since those exist only in the preview.
 *
 * @param input - Base values, slugs, fresh credentials, and whether to withhold.
 * @returns The variables, sorted by scope, service and key.
 */
export function planPreviewVariables(input: PreviewVariablePlanInput): PlannedVariable[] {
  const id = (scope: VariableScope, serviceId: string | null, key: string) =>
    scope === "shared" ? `shared:${key}` : `${serviceId}:${key}`;
  const out = new Map<string, PlannedVariable & { fresh: boolean }>();
  for (const v of input.base) {
    out.set(id(v.scope, v.serviceId, v.key), { ...v, withheld: false, fresh: false });
  }
  for (const f of input.fresh) {
    for (const e of f.entries) {
      const k = id("service", f.serviceId, e.key);
      const prior = out.get(k);
      out.set(k, {
        scope: "service",
        serviceId: f.serviceId,
        key: e.key,
        value: e.value,
        tier: e.tier,
        locked: e.locked,
        availableAtBuild: prior?.availableAtBuild ?? false,
        mountAsFile: prior?.mountAsFile ?? false,
        withheld: false,
        fresh: true,
      });
    }
  }

  if (input.withhold) {
    const services: Record<string, Record<string, string>> = {};
    const shared: Record<string, string> = {};
    const secretServiceKeys: Record<string, string[]> = {};
    const secretSharedKeys: string[] = [];
    for (const v of out.values()) {
      const slug = v.serviceId ? input.slugs.get(v.serviceId) : undefined;
      if (v.scope === "service" && !slug) continue;
      const secret = !v.fresh && (v.tier === "secret" || credentialValue(v.key, v.value));
      if (v.scope === "shared") {
        shared[v.key] = v.value;
        if (secret) secretSharedKeys.push(v.key);
      } else {
        const values = services[slug!] ?? {};
        values[v.key] = v.value;
        services[slug!] = values;
        if (secret) secretServiceKeys[slug!] = [...(secretServiceKeys[slug!] ?? []), v.key];
      }
    }
    const taint = secretDerivedVariables({ services, shared, secretServiceKeys, secretSharedKeys });
    const withheld = new Set<string>([
      ...secretSharedKeys.map((k) => `${SHARED_NAMESPACE}.${k}`),
      ...taint.shared.map((k) => `${SHARED_NAMESPACE}.${k}`),
      ...Object.entries(secretServiceKeys).flatMap(([s, keys]) => keys.map((k) => `${s}.${k}`)),
      ...Object.entries(taint.services).flatMap(([s, keys]) => keys.map((k) => `${s}.${k}`)),
    ]);
    for (const v of out.values()) {
      const ns = v.scope === "shared" ? SHARED_NAMESPACE : input.slugs.get(v.serviceId ?? "");
      if (ns !== undefined && withheld.has(`${ns}.${v.key}`)) {
        v.value = "";
        v.withheld = true;
      }
    }
  }

  return [...out.values()]
    .map(({ fresh: _fresh, ...v }) => v)
    .sort((a, b) =>
      a.scope !== b.scope
        ? a.scope.localeCompare(b.scope)
        : (a.serviceId ?? "").localeCompare(b.serviceId ?? "") || a.key.localeCompare(b.key),
    );
}

/**
 * Whether the classifier recognises a value itself as a credential (a known
 * format or high entropy). A secret-looking name alone doesn't count:
 * `DATABASE_URL = ${{db.DATABASE_URL}}` holds only a reference, and the
 * referenced variable's own tier decides it.
 */
function credentialValue(key: string, value: string): boolean {
  const c = classifyVariable(key, value);
  return c.tier === "secret" && (c.reason === "value_detected" || c.reason === "high_entropy");
}
