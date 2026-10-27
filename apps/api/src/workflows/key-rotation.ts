/**
 * `KeyRotationWorkflow`: moves every sealed value to the current master key
 * and to format 2 (ADR 0014 "Crypto", "Rotation"). One instance per
 * rotation; the instance ID is the `krot_…` rotation ID.
 *
 * Steps, each idempotent and batched ({@link ROTATION_BATCH} rows per step),
 * every write a compare-and-swap on the ciphertext it replaces, so a value
 * changed by a concurrent write is left to that write (which seals it
 * under the current key anyway):
 * 1. `rewrap-dek-<n>`: `project_keys` rows whose `kek_kid` isn't the current
 *    KEK id: unsealed with whichever key sealed them, re-sealed under the
 *    current KEK with the v2 AAD; `kek_kid` and `dek_id` set.
 * 2. `rewrap-instance-<n>`: the instance secrets in `instance_settings`
 *    ({@link INSTANCE_SECRET_FIELDS}), then `provider_credentials` tokens.
 *    `rewrap-two-factor-<n>`: TOTP secrets and backup codes, which Better
 *    Auth encrypts with the auth secret of the key current at enrollment.
 * 3. `reseal-variables-<n>`: variables in format 1 or without a fingerprint:
 *    re-sealed with `variableAadV2` at the same `version`, fingerprinted.
 * 4. `reseal-deployments-<n>`: `env_sealed` and `build_env_sealed` in format 1.
 * 5. `finish`: `key_rotation` state `completed`, audit
 *    `instance.key_rotation_completed`. A step that still fails after its
 *    retries ends the run in `fail` instead: state `failed`, audit
 *    `instance.key_rotation_failed`.
 *
 * Also: {@link keyStatus} for `GET /v1/instance/keys`, and the stored run
 * state ({@link KeyRotationState}).
 *
 * @module
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  certificates,
  createDb,
  type Db,
  deployments,
  instanceSettings,
  projectKeys,
  projects,
  providerCredentials,
  services,
  twoFactors,
  variables,
} from "@roundhouse/db";
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { Env } from "../env";
import { auditInsert } from "../lib/audit";
import { authSecretVersion } from "../lib/auth-secrets";
import { CERTIFICATE_KEY_SETTING } from "../lib/certificates/config";
import { ACME_ACCOUNT_KEY_FIELD, CLOUDFLARE_TOKEN_FIELD } from "../lib/certificates/settings";
import { type Sealed, sealDataKey, unsealDataKey } from "../lib/crypto";
import {
  openDeploymentBuild,
  openDeploymentEnv,
  sealDeploymentBuild,
  sealDeploymentEnv,
} from "../lib/desired-state";
import { sealInstanceSecret, unsealInstanceSecret } from "../lib/instance-secrets";
import { type KeyEnv, keyringOf } from "../lib/keyring";
import { getSetting, putSetting, SettingKey } from "../lib/settings";
import { rewrapTwoFactorBatch, staleTwoFactorCondition } from "../lib/two-factor";
import { openVariable, projectKey, sealVariable } from "../lib/variables";

/** Parameters of one rotation run. */
export interface KeyRotationParams {
  /** `krot_…`; also the workflow instance ID. */
  rotationId: string;
  /** User who started it, for the audit records. */
  startedBy: string;
}

/** `instance_settings` key of the latest run's {@link KeyRotationState}. */
export const KEY_ROTATION_SETTING = "key_rotation";

/** Rows each step handles. */
export const ROTATION_BATCH = 100;

/** The latest rotation run, as stored under {@link KEY_ROTATION_SETTING}. */
export interface KeyRotationState {
  id: string;
  state: "running" | "completed" | "failed";
  started_at: number;
  finished_at: number | null;
  /** Why the run failed; never contains key material or values. */
  error: string | null;
}

/** One sealed field of an `instance_settings` row and the field name it was sealed for. */
interface InstanceSecretField {
  setting: string;
  /** Property of the stored JSON object holding the ciphertext. */
  property: string;
  /** `field` passed to `sealInstanceSecret`; absent for single-secret settings. */
  field?: string;
}

/**
 * Every instance secret kept in `instance_settings`. A new sealed setting
 * must be added here, or rotation leaves it under the previous key and
 * `previous_keys_removable` never becomes true for it.
 */
export const INSTANCE_SECRET_FIELDS: readonly InstanceSecretField[] = [
  { setting: SettingKey.signingKey, property: "private_key" },
  { setting: SettingKey.fingerprintSecret, property: "secret" },
  { setting: SettingKey.signingKeyNext, property: "private_key" },
  { setting: SettingKey.githubApp, property: "client_secret", field: "client_secret" },
  { setting: SettingKey.githubApp, property: "webhook_secret", field: "webhook_secret" },
  { setting: SettingKey.githubApp, property: "private_key", field: "private_key" },
  {
    setting: SettingKey.backupStorage,
    property: "secret_access_key",
    field: "secret_access_key",
  },
  { setting: SettingKey.cloudflareDns, property: "api_token", field: CLOUDFLARE_TOKEN_FIELD },
  { setting: SettingKey.acmeAccount, property: "key", field: ACME_ACCOUNT_KEY_FIELD },
];

// Mirrors `lib/cloud-providers.ts`, which seals every provider token through
// `sealInstanceSecret` under this setting key and this field.
const PROVIDER_CREDENTIAL_SETTING = "provider_credential";
const providerField = (row: { workspaceId: string; provider: string; id: string }) =>
  `${row.workspaceId}:${row.provider}:${row.id}`;

// The stored JSON text, undecoded: the compare-and-swap compares it byte for byte.
const rawText = (column: AnySQLiteColumn) => sql<string>`CAST(${column} AS TEXT)`;
const formatOf = (column: AnySQLiteColumn) => sql`json_extract(${column}, '$.v')`;
const kidOf = (column: AnySQLiteColumn) => sql`json_extract(${column}, '$.kid')`;

/** Whether a KEK-sealed column isn't format 2 under `kid`. */
const notUnder = (column: AnySQLiteColumn, kid: string) =>
  sql`(${formatOf(column)} IS NOT 2 OR ${kidOf(column)} IS NOT ${kid})`;

// -----------------------------------------------------------------------------
// Steps
// -----------------------------------------------------------------------------

/**
 * Re-wraps up to {@link ROTATION_BATCH} project DEKs under the current KEK.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @returns How many rows needed work; `0` when none are left.
 */
export async function rewrapDekBatch(db: Db, keys: KeyEnv): Promise<number> {
  const current = (await keyringOf(keys)).current.kid;
  const rows = await db
    .select({
      projectId: projectKeys.projectId,
      workspaceId: projects.workspaceId,
      dekSealed: projectKeys.dekSealed,
      raw: rawText(projectKeys.dekSealed),
    })
    .from(projectKeys)
    .innerJoin(projects, eq(projects.id, projectKeys.projectId))
    .where(or(isNull(projectKeys.kekKid), ne(projectKeys.kekKid, current)))
    .limit(ROTATION_BATCH);
  for (const r of rows) {
    const sealed = r.dekSealed as Sealed;
    const dek = await unsealDataKey(keys, sealed, r.workspaceId, r.projectId);
    const next = await sealDataKey(keys, dek, r.workspaceId, r.projectId);
    await db
      .update(projectKeys)
      .set({ ...next, updatedAt: new Date() })
      .where(
        and(
          eq(projectKeys.projectId, r.projectId),
          sql`${rawText(projectKeys.dekSealed)} = ${r.raw}`,
        ),
      );
  }
  return rows.length;
}

/**
 * Re-wraps the instance secrets of `instance_settings` (all of them, they
 * are few), up to {@link ROTATION_BATCH} provider tokens and up to as many
 * certificate private keys (ADR 0009; sealed under the `certificate`
 * setting key with the certificate ID as field).
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @returns How many values needed work; `0` when none are left.
 */
export async function rewrapInstanceBatch(db: Db, keys: KeyEnv): Promise<number> {
  const current = (await keyringOf(keys)).current.kid;
  let touched = 0;
  const settingKeys = [...new Set(INSTANCE_SECRET_FIELDS.map((f) => f.setting))];
  const rows = await db
    .select({ key: instanceSettings.key, raw: rawText(instanceSettings.value) })
    .from(instanceSettings)
    .where(inArray(instanceSettings.key, settingKeys));
  for (const row of rows) {
    const value = JSON.parse(row.raw) as Record<string, unknown>;
    let changed = false;
    for (const f of INSTANCE_SECRET_FIELDS.filter((x) => x.setting === row.key)) {
      const sealed = value[f.property] as Sealed | undefined;
      if (!sealed || (sealed.v === 2 && sealed.kid === current)) continue;
      const plaintext = await unsealInstanceSecret(keys, sealed, f.setting, f.field);
      value[f.property] = await sealInstanceSecret(keys, plaintext, f.setting, f.field);
      changed = true;
      touched++;
    }
    if (!changed) continue;
    await db
      .update(instanceSettings)
      .set({ value, updatedAt: new Date() })
      .where(
        and(
          eq(instanceSettings.key, row.key),
          sql`${rawText(instanceSettings.value)} = ${row.raw}`,
        ),
      );
  }

  const creds = await db
    .select({
      id: providerCredentials.id,
      workspaceId: providerCredentials.workspaceId,
      provider: providerCredentials.provider,
      tokenSealed: providerCredentials.tokenSealed,
      raw: rawText(providerCredentials.tokenSealed),
    })
    .from(providerCredentials)
    .where(notUnder(providerCredentials.tokenSealed, current))
    .limit(ROTATION_BATCH);
  for (const c of creds) {
    const field = providerField(c);
    const token = await unsealInstanceSecret(
      keys,
      c.tokenSealed as Sealed,
      PROVIDER_CREDENTIAL_SETTING,
      field,
    );
    await db
      .update(providerCredentials)
      .set({
        tokenSealed: await sealInstanceSecret(keys, token, PROVIDER_CREDENTIAL_SETTING, field),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(providerCredentials.id, c.id),
          sql`${rawText(providerCredentials.tokenSealed)} = ${c.raw}`,
        ),
      );
  }
  const certs = await db
    .select({
      id: certificates.id,
      keySealed: certificates.keySealed,
      pendingKeySealed: certificates.pendingKeySealed,
      raw: sql<string>`COALESCE(${rawText(certificates.keySealed)}, '') || '|' || COALESCE(${rawText(certificates.pendingKeySealed)}, '')`,
    })
    .from(certificates)
    .where(staleCertificateKeys(current))
    .limit(ROTATION_BATCH);
  for (const c of certs) {
    const reseal = async (sealed: unknown) =>
      sealed
        ? sealInstanceSecret(
            keys,
            await unsealInstanceSecret(keys, sealed as Sealed, CERTIFICATE_KEY_SETTING, c.id),
            CERTIFICATE_KEY_SETTING,
            c.id,
          )
        : null;
    await db
      .update(certificates)
      .set({
        keySealed: await reseal(c.keySealed),
        pendingKeySealed: await reseal(c.pendingKeySealed),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(certificates.id, c.id),
          sql`COALESCE(${rawText(certificates.keySealed)}, '') || '|' || COALESCE(${rawText(certificates.pendingKeySealed)}, '') = ${c.raw}`,
        ),
      );
  }
  return touched + creds.length + certs.length;
}

/** Certificates holding a key not sealed under the current KEK. */
const staleCertificateKeys = (current: string) =>
  or(
    and(isNotNull(certificates.keySealed), notUnder(certificates.keySealed, current)),
    and(isNotNull(certificates.pendingKeySealed), notUnder(certificates.pendingKeySealed, current)),
  );

/**
 * Re-seals up to {@link ROTATION_BATCH} variables that are in format 1, or
 * lack a fingerprint (values written before fingerprints, or by code that
 * sealed with the format 1 AAD), at their current version.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @returns How many rows needed work; `0` when none are left.
 */
export async function resealVariablesBatch(db: Db, keys: KeyEnv): Promise<number> {
  const rows = await db
    .select({
      id: variables.id,
      projectId: variables.projectId,
      environmentId: variables.environmentId,
      scope: variables.scope,
      serviceId: variables.serviceId,
      key: variables.key,
      version: variables.version,
      valueSealed: variables.valueSealed,
      raw: rawText(variables.valueSealed),
    })
    .from(variables)
    .where(or(sql`${formatOf(variables.valueSealed)} = 1`, isNull(variables.fingerprint)))
    .limit(ROTATION_BATCH);
  for (const r of rows) {
    const key = await projectKey(db, keys, r.projectId);
    const value = await openVariable(key, { ...r, valueSealed: r.valueSealed as Sealed });
    const sealed = await sealVariable(key, r, value);
    await db
      .update(variables)
      .set(sealed)
      .where(
        and(
          eq(variables.id, r.id),
          eq(variables.version, r.version),
          sql`${rawText(variables.valueSealed)} = ${r.raw}`,
        ),
      );
  }
  return rows.length;
}

/**
 * Re-seals up to {@link ROTATION_BATCH} deployments whose `env_sealed` or
 * `build_env_sealed` is format 1.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @returns How many rows needed work; `0` when none are left.
 */
export async function resealDeploymentsBatch(db: Db, keys: KeyEnv): Promise<number> {
  const rows = await db
    .select({
      id: deployments.id,
      projectId: services.projectId,
      workspaceId: projects.workspaceId,
      envSealed: deployments.envSealed,
      buildEnvSealed: deployments.buildEnvSealed,
      envRaw: rawText(deployments.envSealed),
      buildRaw: rawText(deployments.buildEnvSealed),
    })
    .from(deployments)
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .where(
      or(
        sql`${formatOf(deployments.envSealed)} = 1`,
        sql`${formatOf(deployments.buildEnvSealed)} = 1`,
      ),
    )
    .limit(ROTATION_BATCH);
  for (const r of rows) {
    const key = await projectKey(db, keys, r.projectId);
    const ref = { workspaceId: r.workspaceId, projectId: r.projectId, deploymentId: r.id };
    const env = r.envSealed as Sealed | null;
    const build = r.buildEnvSealed as Sealed | null;
    const set: Partial<typeof deployments.$inferInsert> = {};
    if (env?.v === 1) {
      set.envSealed = await sealDeploymentEnv(key, ref, await openDeploymentEnv(key, env, ref));
    }
    if (build?.v === 1) {
      set.buildEnvSealed = await sealDeploymentBuild(
        key,
        ref,
        await openDeploymentBuild(key, build, ref),
      );
    }
    await db
      .update(deployments)
      .set(set)
      .where(
        and(
          eq(deployments.id, r.id),
          r.envRaw === null
            ? isNull(deployments.envSealed)
            : sql`${rawText(deployments.envSealed)} = ${r.envRaw}`,
          r.buildRaw === null
            ? isNull(deployments.buildEnvSealed)
            : sql`${rawText(deployments.buildEnvSealed)} = ${r.buildRaw}`,
        ),
      );
  }
  return rows.length;
}

// -----------------------------------------------------------------------------
// Status
// -----------------------------------------------------------------------------

/** The response of `GET /v1/instance/keys`; see `KeyStatusSchema`. */
export interface KeyStatus {
  current_kid: string;
  previous_kids: string[];
  remaining: {
    project_keys: number;
    instance_secrets: number;
    v1_variables: number;
    v1_deployments: number;
    missing_fingerprints: number;
  };
  rotation: KeyRotationState | null;
  previous_keys_removable: boolean;
}

const count = sql<number>`count(*)`;

/**
 * What still references a previous key or format 1, and the latest run.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings.
 * @returns The status; never key material.
 */
export async function keyStatus(db: Db, keys: KeyEnv): Promise<KeyStatus> {
  const ring = await keyringOf(keys);
  const current = ring.current.kid;
  const [[dek], [v1Vars], [noFp], [v1Deps], [creds], [tfa], [certKeys], settings, rotation] =
    await Promise.all([
      db
        .select({ n: count })
        .from(projectKeys)
        .where(or(isNull(projectKeys.kekKid), ne(projectKeys.kekKid, current))),
      db
        .select({ n: count })
        .from(variables)
        .where(sql`${formatOf(variables.valueSealed)} = 1`),
      db.select({ n: count }).from(variables).where(isNull(variables.fingerprint)),
      db
        .select({ n: count })
        .from(deployments)
        .where(
          or(
            sql`${formatOf(deployments.envSealed)} = 1`,
            sql`${formatOf(deployments.buildEnvSealed)} = 1`,
          ),
        ),
      db
        .select({ n: count })
        .from(providerCredentials)
        .where(notUnder(providerCredentials.tokenSealed, current)),
      db
        .select({ n: count })
        .from(twoFactors)
        .where(staleTwoFactorCondition(authSecretVersion(current))),
      db.select({ n: count }).from(certificates).where(staleCertificateKeys(current)),
      db
        .select({ key: instanceSettings.key, value: instanceSettings.value })
        .from(instanceSettings)
        .where(
          inArray(instanceSettings.key, [...new Set(INSTANCE_SECRET_FIELDS.map((f) => f.setting))]),
        ),
      getSetting<KeyRotationState>(db, KEY_ROTATION_SETTING),
    ]);
  let staleSettings = 0;
  for (const row of settings) {
    const value = row.value as Record<string, Sealed | undefined>;
    for (const f of INSTANCE_SECRET_FIELDS.filter((x) => x.setting === row.key)) {
      const sealed = value[f.property];
      if (sealed && !(sealed.v === 2 && sealed.kid === current)) staleSettings++;
    }
  }
  const remaining = {
    project_keys: Number(dek?.n ?? 0),
    instance_secrets:
      staleSettings + Number(creds?.n ?? 0) + Number(tfa?.n ?? 0) + Number(certKeys?.n ?? 0),
    v1_variables: Number(v1Vars?.n ?? 0),
    v1_deployments: Number(v1Deps?.n ?? 0),
    missing_fingerprints: Number(noFp?.n ?? 0),
  };
  return {
    current_kid: current,
    previous_kids: ring.previous.map((k) => k.kid),
    remaining,
    rotation: rotation ?? null,
    // Only KEK-sealed values name a master key; format 1 values under a
    // DEK don't, so they don't hold the previous keys back.
    previous_keys_removable:
      ring.previous.length > 0 && remaining.project_keys === 0 && remaining.instance_secrets === 0,
  };
}

// -----------------------------------------------------------------------------
// Workflow
// -----------------------------------------------------------------------------

const STEP = { retries: { limit: 2, delay: "1 second", backoff: "exponential" } } as const;

// A batch that keeps finding rows without making them current (a row
// rewritten under it every time) must not loop forever.
const MAX_BATCHES = 10_000;

/** Runs one master key rotation. */
export class KeyRotationWorkflow extends WorkflowEntrypoint<Env, KeyRotationParams> {
  override async run(event: Readonly<WorkflowEvent<KeyRotationParams>>, step: WorkflowStep) {
    const { rotationId, startedBy } = event.payload;
    const db = () => createDb(this.env.DB);
    const keys: KeyEnv = this.env;
    const batches = async (name: string, fn: (db: Db, keys: KeyEnv) => Promise<number>) => {
      let total = 0;
      for (let i = 0; i < MAX_BATCHES; i++) {
        const n = await step.do(`${name}-${i}`, STEP, () => fn(db(), keys));
        total += n;
        if (n === 0) return total;
      }
      throw new Error(`${name} did not converge`);
    };
    try {
      const counts = {
        project_keys: await batches("rewrap-dek", rewrapDekBatch),
        instance_secrets:
          (await batches("rewrap-instance", rewrapInstanceBatch)) +
          (await batches("rewrap-two-factor", rewrapTwoFactorBatch)),
        variables: await batches("reseal-variables", resealVariablesBatch),
        deployments: await batches("reseal-deployments", resealDeploymentsBatch),
      };
      await step.do("finish", STEP, async () => {
        const d = db();
        const prior = await getSetting<KeyRotationState>(d, KEY_ROTATION_SETTING);
        const kid = (await keyringOf(keys)).current.kid;
        await d.batch([
          putSetting(d, KEY_ROTATION_SETTING, {
            id: rotationId,
            state: "completed",
            started_at: prior?.id === rotationId ? prior.started_at : Date.now(),
            finished_at: Date.now(),
            error: null,
          } satisfies KeyRotationState),
          auditInsert(d, {
            workspaceId: null,
            actorType: "user",
            actorId: startedBy,
            action: "instance.key_rotation_completed",
            targetType: "key_rotation",
            targetId: rotationId,
            metadata: { current_kid: kid, ...counts },
          }),
        ]);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await step.do("fail", STEP, async () => {
        const d = db();
        const prior = await getSetting<KeyRotationState>(d, KEY_ROTATION_SETTING);
        await d.batch([
          putSetting(d, KEY_ROTATION_SETTING, {
            id: rotationId,
            state: "failed",
            started_at: prior?.id === rotationId ? prior.started_at : Date.now(),
            finished_at: Date.now(),
            error: message.slice(0, 500),
          } satisfies KeyRotationState),
          auditInsert(d, {
            workspaceId: null,
            actorType: "user",
            actorId: startedBy,
            action: "instance.key_rotation_failed",
            targetType: "key_rotation",
            targetId: rotationId,
            metadata: { error: message.slice(0, 500) },
          }),
        ]);
      });
    }
  }
}
