/**
 * Database services (ADR 0004, "Database templates"): turning an engine and
 * version into a `service.create` op, and the credentials and volume rows
 * an apply writes for it.
 *
 * - {@link databaseCreateOp}: the op's pinned image, config and `database`
 *   choice, rendered from the registry when the op is staged.
 * - {@link databaseVariables}: freshly generated credentials for one
 *   environment, as `putVariables` entries.
 *
 * SECURITY: credentials are minted with `crypto.getRandomValues` at apply
 * time, one set per environment, and stored only as `secret` variables:
 * staged ops, audit records and responses carry their keys, never values.
 *
 * @module
 */
import type { variables } from "@roundhouse/db";
import {
  classifyVariable,
  DATABASE_ENGINE_SPECS,
  DEFAULT_DATABASE_VOLUME_MB,
  databaseVersion,
  decideVariableTier,
  newId,
  renderDatabaseService,
  type ServiceConfigPatch,
  type ServiceCreateOp,
  type ServiceDatabaseEngine,
} from "@roundhouse/shared";
import { ApiError } from "./errors";
import {
  type StoredVariable,
  sealVariable,
  type VariableSetEntry,
  type VariableTarget,
} from "./variables";
import { clampVolumeMb, singleReplicaError } from "./volumes";

/** Randomness for credentials. */
const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** What a client asks for. */
export interface DatabaseChoice {
  engine: ServiceDatabaseEngine;
  version?: string | undefined;
  size_mb?: number | undefined;
}

/**
 * Resolves a version against the registry.
 *
 * @param engine - The engine.
 * @param version - A registry version, or omitted for the default.
 * @returns The registry entry.
 * @throws {ApiError} 404 for a version the registry doesn't offer.
 */
export function resolveDatabaseVersion(engine: ServiceDatabaseEngine, version?: string | null) {
  const v = databaseVersion(engine, version);
  if (!v) {
    const offered = DATABASE_ENGINE_SPECS[engine].versions.map((x) => x.version).join(", ");
    throw new ApiError(
      404,
      "not_found",
      `${DATABASE_ENGINE_SPECS[engine].name} has no version ${version}; offered: ${offered}`,
    );
  }
  return v;
}

/**
 * The `service.create` op of a database: kind `database`, the pinned image,
 * the registry's config with the caller's patch on top, and the choice
 * itself, which the apply turns into credentials and volumes.
 *
 * @param input - Ref, name, slug, icon, the choice, and an optional config patch.
 * @returns The op to stage.
 * @throws {ApiError} 404 for an unknown version, 422 for more than one replica.
 */
export function databaseCreateOp(input: {
  ref: string;
  name?: string | undefined;
  slug?: string | undefined;
  icon?: string | undefined;
  database: DatabaseChoice;
  config?: Omit<ServiceConfigPatch, "source"> | undefined;
}): ServiceCreateOp {
  const { engine } = input.database;
  const v = resolveDatabaseVersion(engine, input.database.version);
  // Only the shape is used here; the apply mints the real credentials.
  const rendered = renderDatabaseService(engine, v.version, () => new Uint8Array(32));
  const { source, ...config } = rendered.config;
  const patch = input.config ?? {};
  if ((patch.deploy?.replicas ?? 1) > 1) throw singleReplicaError();
  const spec = DATABASE_ENGINE_SPECS[engine];
  return {
    type: "service.create",
    ref: input.ref,
    name: input.name ?? spec.name,
    kind: "database",
    icon: input.icon ?? spec.icon,
    source,
    config: {
      build: config.build,
      deploy: { ...config.deploy, ...patch.deploy },
      resources: { ...config.resources, ...patch.resources },
      healthcheck: null,
      networking: { ...config.networking, ...patch.networking },
      placement: { ...config.placement, ...patch.placement },
    },
    ...(input.slug !== undefined ? { slug: input.slug } : {}),
    database: {
      engine,
      version: v.version,
      size_mb: clampVolumeMb(input.database.size_mb ?? DEFAULT_DATABASE_VOLUME_MB),
    },
  };
}

/**
 * Fresh credentials and connection variables of a database for one
 * environment: secret ones requested as `secret`, the rest as `plain`
 * (user and database names, and references to them).
 *
 * @param engine - The engine.
 * @param version - A registry version.
 * @returns Entries for `putVariables`.
 */
export function databaseVariables(
  engine: ServiceDatabaseEngine,
  version: string,
): VariableSetEntry[] {
  return renderDatabaseService(engine, version, randomBytes).variables.map((v) => ({
    key: v.key,
    value: v.value,
    tier: v.secret ? "secret" : "plain",
  }));
}

/**
 * Variable rows (version 1) for a new database service's credentials, sealed
 * for their rows, with the tier the classifier decides for the requested
 * one, exactly as a variables write would store them. Rows, not a write, so
 * they commit in the same batch as the service.
 *
 * @param key - Project DEK.
 * @param target - The new service in one environment.
 * @param entries - From {@link databaseVariables}.
 * @param actorId - Stored as `updated_by`.
 * @returns Rows to insert.
 * @throws When the classifier refuses a value, which generated values never trip.
 */
export async function databaseVariableRows(
  key: CryptoKey,
  target: VariableTarget,
  entries: readonly VariableSetEntry[],
  actorId: string,
): Promise<(typeof variables.$inferInsert)[]> {
  return Promise.all(
    entries.map(async (e) => {
      const decision = decideVariableTier({
        classification: classifyVariable(e.key, e.value!),
        ...(e.tier ? { requested: e.tier } : {}),
        valueProvided: true,
      });
      if (!decision.ok) throw new Error(`${e.key}: ${decision.code}`);
      const coordinates: StoredVariable = {
        id: newId("variable"),
        projectId: target.projectId,
        environmentId: target.environmentId,
        scope: target.scope,
        serviceId: target.serviceId,
        key: e.key,
        version: 1,
      };
      return {
        ...coordinates,
        ...(await sealVariable(key, coordinates, e.value!)),
        tier: decision.tier,
        locked: decision.locked,
        availableAtBuild: false,
        mountAsFile: false,
        updatedBy: actorId,
      };
    }),
  );
}
