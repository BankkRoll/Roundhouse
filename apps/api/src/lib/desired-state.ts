/**
 * A node's desired state, computed from D1 every time it is sent, so a
 * reconnecting agent always gets the truth and nothing is cached in the
 * node's Durable Object.
 *
 * - {@link buildDesiredState}: every `service` workload placed on the node
 *   whose deployment is live (`deploying`, `active`, `crashed`), plus the
 *   install's ingress settings and, for builder nodes, the registry. From
 *   `VOLUMES_PROTOCOL_VERSION` it also lists every live volume pinned to the
 *   node (ADR 0004), and a volume service's workload mounts its volume,
 *   stops before it is replaced, and a database gets its `exec` probe.
 *   A volume being migrated is also listed on its target node, and its
 *   service runs nowhere until the copy is done; a service with a TCP proxy
 *   publishes its port on nodes that enforce the allowlist.
 * - {@link refreshNodes}: bumps nodes' `desired_generation` and asks their
 *   Durable Objects to push the new state.
 * - {@link sealDeploymentEnv}/{@link openDeploymentEnv} and the build
 *   counterparts: a deployment's frozen inputs under the project DEK.
 *
 * @module
 */
import {
  type Db,
  deployments,
  domains,
  environments,
  nodes,
  placements,
  projects,
  serviceConfigs,
  services,
  volumeMigrations,
  volumes,
} from "@roundhouse/db";
import {
  computeSpecHash,
  type DesiredState,
  environmentNetworkName,
  type Healthcheck,
  MAX_VOLUMES_PER_NODE,
  MAX_WORKLOADS_PER_NODE,
  REGISTRY_LISTEN,
  type RegistryConfig,
  SEALED_ENV_PROTOCOL_VERSION,
  type SealedBox,
  type SealedWorkloadEnv,
  sealBox,
  VOLUMES_PROTOCOL_VERSION,
  type VolumeSpec,
  type WorkloadSpec,
  workloadEnvAad,
} from "@roundhouse/protocol";
import {
  DATABASE_STOP_GRACE_S,
  DEFAULT_PIDS_LIMIT,
  type DeploymentStatus,
  databaseHealthCommand,
  databaseVersion,
  type HealthcheckConfig,
  LIVE_VOLUME_STATUSES,
  type ServiceConfigSpec,
  type ServiceDatabaseEngine,
} from "@roundhouse/shared";
import { and, asc, eq, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import type { NodeConnection } from "../durable/node-connection";
import { type KeyEnv, type Sealed, sealWith, unsealWith } from "./crypto";
import { deploymentBuildAadV2, deploymentEnvAadV2 } from "./keyring";
import { getIngressSettings } from "./settings";
import { tcpProxiesFor } from "./tcp-proxies";
import { deploymentEnvAad, projectKey } from "./variables";

/**
 * Migration phases in which the target node holds the volume before it is
 * pinned there: it creates it, then receives the copy.
 */
export const MIGRATION_TARGET_PHASES = [
  "preparing_target",
  "stopping",
  "copying_out",
  "copying_in",
] as const;

/** Which deployment a sealed input belongs to; every part is in its AAD. */
export interface DeploymentRef {
  workspaceId: string;
  projectId: string;
  deploymentId: string;
}

/** A deployment's build inputs, as sealed in `deployments.build_env_sealed`. */
export interface DeploymentBuildInputs {
  /** Plain values passed as `--build-arg`. */
  args: Record<string, string>;
  /** BuildKit secrets (`available_at_build` secrets), sealed to the builder in `build_secrets_sealed`. */
  secrets: Record<string, string>;
  /**
   * Names of `args` the service config marks secret (ADR 0003
   * `secret_build_args`): the builder passes them as BuildKit secrets and
   * they are redacted from build logs.
   */
  secret_args: string[];
}

/**
 * Seals a deployment's resolved environment under the project DEK.
 *
 * @param key - Project DEK.
 * @param ref - The deployment; bound into the AAD.
 * @param payload - Environment variables and `mount_as_file` values.
 * @returns The value for `deployments.env_sealed`.
 */
export function sealDeploymentEnv(
  key: CryptoKey,
  ref: DeploymentRef,
  payload: SealedWorkloadEnv,
): Promise<Sealed> {
  return sealWith(
    key,
    JSON.stringify(payload),
    deploymentEnvAadV2(ref.workspaceId, ref.projectId, ref.deploymentId),
  );
}

/**
 * Opens `deployments.env_sealed`.
 *
 * Format 2 values open only under `deployment-env:v2:<ws>:<prj>:<dep>`.
 * Format 1 values were sealed before ADR 0014 under `deployment-env:<id>`
 * with a flat `{ KEY: value }` body; they are still read, so deployments
 * that predate the change keep running until rotation re-seals them.
 *
 * @param key - Project DEK.
 * @param sealed - The stored value.
 * @param ref - The deployment.
 * @returns The environment split into `env` and `files`.
 * @throws When the value doesn't open under its format's AAD.
 */
export async function openDeploymentEnv(
  key: CryptoKey,
  sealed: Sealed,
  ref: DeploymentRef,
): Promise<SealedWorkloadEnv> {
  // SECURITY: the AAD follows the format, never a fallback: a v2 value that
  // opened under the short v1 AAD would no longer be bound to its project.
  const aad =
    sealed.v === 2
      ? deploymentEnvAadV2(ref.workspaceId, ref.projectId, ref.deploymentId)
      : deploymentEnvAad(ref.deploymentId);
  const text = await unsealWith(key, sealed, aad);
  const body = JSON.parse(text) as Record<string, unknown>;
  // Flat bodies hold only strings, so an object under `env` marks the split shape.
  if (typeof body.env === "object" && body.env !== null) {
    return {
      env: body.env as Record<string, string>,
      files: (body.files ?? {}) as Record<string, string>,
    };
  }
  return { env: body as Record<string, string>, files: {} };
}

/**
 * Seals a deployment's build inputs under the project DEK.
 *
 * @param key - Project DEK.
 * @param ref - The deployment; bound into the AAD.
 * @param inputs - Build args and secrets.
 * @returns The value for `deployments.build_env_sealed`.
 */
export function sealDeploymentBuild(
  key: CryptoKey,
  ref: DeploymentRef,
  inputs: DeploymentBuildInputs,
): Promise<Sealed> {
  return sealWith(
    key,
    JSON.stringify(inputs),
    deploymentBuildAadV2(ref.workspaceId, ref.projectId, ref.deploymentId),
  );
}

/**
 * Opens `deployments.build_env_sealed`. The column came with ADR 0014, so
 * every value of it is bound to `deployment-build:v2:<ws>:<prj>:<dep>`.
 *
 * @param key - Project DEK.
 * @param sealed - The stored value.
 * @param ref - The deployment.
 * @returns The build inputs.
 */
export async function openDeploymentBuild(
  key: CryptoKey,
  sealed: Sealed,
  ref: DeploymentRef,
): Promise<DeploymentBuildInputs> {
  const body = JSON.parse(
    await unsealWith(
      key,
      sealed,
      deploymentBuildAadV2(ref.workspaceId, ref.projectId, ref.deploymentId),
    ),
  ) as Partial<DeploymentBuildInputs>;
  return {
    args: body.args ?? {},
    secrets: body.secrets ?? {},
    secret_args: body.secret_args ?? [],
  };
}

/** Deployments whose replicas belong on nodes. */
export const LIVE_DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = [
  "deploying",
  "active",
  "crashed",
];

/** Label carrying a replica's private hostname; see {@link privateDomain}. */
export const PRIVATE_DOMAIN_LABEL = "roundhouse.private_domain";

/** The body of a `desired_state` frame, without the signed header. */
export type DesiredStateBody = Omit<DesiredState, "id" | "node_id" | "iat" | "exp">;

/**
 * Private hostname of a service in an environment, injected as
 * `ROUNDHOUSE_PRIVATE_DOMAIN` and carried on each replica as
 * {@link PRIVATE_DOMAIN_LABEL} for the agent to register as a network alias.
 *
 * The agent registers it as an alias on the environment's own network only
 * (see `environmentNetworkName`), so it resolves only inside that
 * environment.
 *
 * @param serviceSlug - Service slug.
 * @param environmentSlug - Environment slug.
 * @returns E.g. `api.production.internal`.
 */
export function privateDomain(serviceSlug: string, environmentSlug: string): string {
  return `${serviceSlug}.${environmentSlug}.internal`;
}

/**
 * Turns a service's probe config into the protocol's probe, filling the port.
 *
 * @param h - Configured probe, or `null`.
 * @param port - `networking.port`, the default probe port.
 * @returns The probe, or `null` for none (the agent then reports healthy once running).
 */
export function healthcheckSpec(
  h: HealthcheckConfig | null,
  port: number | null,
): Healthcheck | null {
  if (!h || h.type === "none") return null;
  const probePort = h.port ?? port;
  if (!probePort) return null;
  return {
    type: h.type,
    ...(h.type === "http" && h.path ? { path: h.path } : {}),
    port: probePort,
    interval_s: h.interval_s,
    timeout_s: h.timeout_s,
    retries: h.retries,
    start_period_s: h.start_period_s,
  };
}

/**
 * The replica's restart policy. `on_failure` with 0 retries is sent as
 * `never`: the agent follows Docker, where 0 retries means unlimited, but
 * a user who sets 0 means "don't restart".
 *
 * @param deploy - The deploy part of the config.
 * @returns The protocol restart policy.
 */
export function restartSpec(
  deploy: Pick<ServiceConfigSpec["deploy"], "restart_policy" | "max_retries">,
) {
  if (deploy.restart_policy === "on_failure" && deploy.max_retries === 0) {
    return { policy: "never" as const, max_retries: 0 };
  }
  return { policy: deploy.restart_policy, max_retries: deploy.max_retries };
}

/** Everything that decides one replica's spec. */
export interface WorkloadInput {
  workloadId: string;
  replica: number;
  projectId: string;
  environmentId: string;
  serviceId: string;
  deploymentId: string;
  image: string;
  /** The replica's environment, sealed to its node; see {@link sealWorkloadEnv}. */
  envSealed: SealedBox;
  config: Pick<ServiceConfigSpec, "deploy" | "resources" | "healthcheck" | "networking">;
  hostnames: string[];
  privateDomain: string;
  /** The service's volume on this node (ADR 0004); its replica mounts it. */
  volume?: { id: string; mountPath: string };
  /** A database service: its engine's `exec` probe replaces the configured one. */
  database?: { engine: ServiceDatabaseEngine; version: string | null };
  /**
   * A TCP proxy (ADR 0004): the container port published on the node's
   * `host_port`, admitting only `allowedCidrs`.
   */
  publish?: { containerPort: number; hostPort: number; allowedCidrs: string[] };
}

/**
 * The replica's ports: the configured port, plus a TCP proxy's port when it
 * differs, with the proxy's `publish` on whichever entry it names.
 *
 * @param port - `networking.port`, or `null`.
 * @param publish - The proxy, if any.
 * @returns `WorkloadSpec.ports`.
 */
export function workloadPorts(
  port: number | null,
  publish: WorkloadInput["publish"],
): WorkloadSpec["ports"] {
  const ports: WorkloadSpec["ports"] = port ? [{ container_port: port, protocol: "http" }] : [];
  if (!publish) return ports;
  const binding = { host_port: publish.hostPort, host_ip: "0.0.0.0" as const };
  const existing = ports.find((p) => p.container_port === publish.containerPort);
  if (existing) existing.publish = binding;
  else ports.push({ container_port: publish.containerPort, protocol: "tcp", publish: binding });
  return ports;
}

/** Probe timings of a database's `exec` health check (ADR 0004, "Service and config"). */
export const DATABASE_PROBE = {
  interval_s: 5,
  timeout_s: 5,
  retries: 6,
  start_period_s: 30,
} as const;

/**
 * The health probe of a replica: a database's engine probe, else the
 * configured one.
 *
 * @param w - The replica's inputs.
 * @returns The probe, or `null` for none.
 */
export function workloadHealthcheck(
  w: Pick<WorkloadInput, "config" | "database">,
): Healthcheck | null {
  if (w.database) {
    const v = databaseVersion(w.database.engine, w.database.version);
    if (v) {
      return {
        type: "exec",
        command: databaseHealthCommand(w.database.engine, v),
        ...DATABASE_PROBE,
      };
    }
  }
  return healthcheckSpec(w.config.healthcheck ?? null, w.config.networking.port);
}

/**
 * Builds one replica's `WorkloadSpec`, hash included.
 *
 * @param w - The replica and its deployment's resolved config.
 * @returns A spec that passes `WorkloadSpecSchema`.
 */
export async function workloadSpec(w: WorkloadInput): Promise<WorkloadSpec> {
  const port = w.config.networking.port;
  const spec: Omit<WorkloadSpec, "spec_hash"> = {
    id: w.workloadId,
    kind: "service",
    project_id: w.projectId,
    environment_id: w.environmentId,
    service_id: w.serviceId,
    deployment_id: w.deploymentId,
    replica: w.replica,
    image: w.image,
    registry_auth: null,
    ...(w.config.deploy.start_command
      ? { command: ["/bin/sh", "-c", w.config.deploy.start_command] }
      : {}),
    env_sealed: w.envSealed,
    ports: workloadPorts(port, w.publish),
    ...(w.publish ? { publish_allowed_cidrs: w.publish.allowedCidrs } : {}),
    routes: port ? w.hostnames.map((hostname) => ({ hostname, container_port: port })) : [],
    healthcheck: workloadHealthcheck(w),
    resources: {
      cpu_millis: w.config.resources.cpu_millis,
      memory_mb: w.config.resources.memory_mb,
      pids: DEFAULT_PIDS_LIMIT,
    },
    restart: restartSpec(w.config.deploy),
    // SECURITY: one network per environment, so staging can never reach
    // production by IP or by private domain. A change of network changes
    // the spec hash, which moves existing replicas onto it.
    network: await environmentNetworkName(w.projectId, w.environmentId),
    labels: { [PRIVATE_DOMAIN_LABEL]: w.privateDomain },
    drain_s: w.config.deploy.drain_s,
    // A volume is never mounted by two containers at once: the old replica
    // stops before the new one starts (ADR 0004, "Placement affinity").
    ...(w.volume
      ? {
          mounts: [{ volume_id: w.volume.id, path: w.volume.mountPath, read_only: false }],
          rollout: "stop_first" as const,
          ...(w.database ? { stop_grace_s: DATABASE_STOP_GRACE_S } : {}),
        }
      : {}),
  };
  return { ...spec, spec_hash: await computeSpecHash(spec) };
}

/**
 * Seals a replica's environment to its node for one `desired_state` frame.
 *
 * @param nodePublicKey - The node's X25519 key (`nodes.encryption_public_key`).
 * @param nodeId - The node.
 * @param workloadId - The replica.
 * @param generation - Generation of the frame that will carry it.
 * @param payload - Environment variables, and values to mount as files.
 * @returns The box for `WorkloadSpec.env_sealed`.
 */
export function sealWorkloadEnv(
  nodePublicKey: string,
  nodeId: string,
  workloadId: string,
  generation: number,
  payload: SealedWorkloadEnv,
): Promise<SealedBox> {
  return sealBox(
    nodePublicKey,
    JSON.stringify(payload),
    "workload-env",
    workloadEnvAad(nodeId, workloadId, generation),
  );
}

/**
 * Whether a node may be given workloads or builds: its agent must open
 * sealed boxes and have registered the key to seal them to. A node without a
 * key could only be sent plaintext variables, so it gets nothing (ADR 0014
 * "Node sealing").
 *
 * @param node - The node's protocol version and encryption key.
 * @returns `true` when the node can run sealed workloads and builds.
 */
export function runsSealedWorkloads(node: {
  protocolVersion: number;
  encryptionPublicKey: string | null;
}): boolean {
  return node.protocolVersion >= SEALED_ENV_PROTOCOL_VERSION && node.encryptionPublicKey !== null;
}

/** Registry a builder node runs. Phase 1 always stores blobs on the builder's disk. */
export const BUILDER_REGISTRY: RegistryConfig = {
  listen: REGISTRY_LISTEN,
  storage: { type: "filesystem" },
};

/**
 * Computes a node's complete desired state from D1.
 *
 * @param db - Database client.
 * @param keys - The keyring bindings, to unseal each deployment's env.
 * @param nodeId - The node.
 * @returns The frame body, or `null` when the node no longer exists.
 */
export async function buildDesiredState(
  db: Db,
  keys: KeyEnv,
  nodeId: string,
): Promise<DesiredStateBody | null> {
  // Generation first: content read afterwards is at least as new as the
  // write that bumped it, so a frame never carries a newer generation than
  // its workloads.
  const [node] = await db
    .select({
      generation: nodes.desiredGeneration,
      protocolVersion: nodes.protocolVersion,
      capabilities: nodes.capabilities,
      encryptionPublicKey: nodes.encryptionPublicKey,
    })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), isNull(nodes.deletedAt)))
    .limit(1);
  if (!node) return null;
  const ingress = await getIngressSettings(db);
  const nodeKey = node.encryptionPublicKey;
  const runsWorkloads = runsSealedWorkloads(node);
  const body: DesiredStateBody = {
    type: "desired_state",
    generation: node.generation,
    workloads: [],
    tls_mode: ingress.tlsMode,
    apps_domain: ingress.appsDomain,
    registry: runsWorkloads && node.capabilities?.builder ? BUILDER_REGISTRY : null,
  };
  const holdsVolumes = node.protocolVersion >= VOLUMES_PROTOCOL_VERSION;
  const nodeVolumes = holdsVolumes
    ? await db
        .select()
        .from(volumes)
        .where(and(eq(volumes.nodeId, nodeId), inArray(volumes.status, [...LIVE_VOLUME_STATUSES])))
        .orderBy(asc(volumes.id))
        .limit(MAX_VOLUMES_PER_NODE)
    : [];
  // A volume moving here is created (and copied into) before it is pinned
  // here; it keeps its ID, and its service runs nowhere meanwhile.
  const incoming = holdsVolumes
    ? (
        await db
          .select({ volume: volumes })
          .from(volumeMigrations)
          .innerJoin(volumes, eq(volumes.id, volumeMigrations.volumeId))
          .where(
            and(
              eq(volumeMigrations.targetNodeId, nodeId),
              eq(volumeMigrations.status, "running"),
              inArray(volumeMigrations.phase, [...MIGRATION_TARGET_PHASES]),
              inArray(volumes.status, [...LIVE_VOLUME_STATUSES]),
              or(isNull(volumes.nodeId), ne(volumes.nodeId, nodeId)),
            ),
          )
          .orderBy(asc(volumes.id))
          .limit(MAX_VOLUMES_PER_NODE)
      ).map((r) => r.volume)
    : [];
  if (holdsVolumes) {
    // Every volume the node holds, including those of services scaled to
    // zero: the agent reports an unlisted one as orphaned but never deletes it.
    body.volumes = [...nodeVolumes, ...incoming].slice(0, MAX_VOLUMES_PER_NODE).map(
      (v): VolumeSpec => ({
        id: v.id,
        size_mb: v.sizeMb,
        project_id: v.projectId,
        environment_id: v.environmentId,
        service_id: v.serviceId,
        owner: null,
      }),
    );
  }
  if (!runsWorkloads || nodeKey === null) return body;

  const rows = await db
    .select({
      placement: placements,
      deployment: deployments,
      serviceSlug: services.slug,
      databaseEngine: services.databaseEngine,
      databaseVersion: services.databaseVersion,
      projectId: services.projectId,
      workspaceId: projects.workspaceId,
      environmentSlug: environments.slug,
      config: serviceConfigs,
    })
    .from(placements)
    .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .innerJoin(environments, eq(environments.id, deployments.environmentId))
    .innerJoin(
      serviceConfigs,
      and(
        eq(serviceConfigs.serviceId, deployments.serviceId),
        eq(serviceConfigs.environmentId, deployments.environmentId),
        eq(serviceConfigs.version, deployments.configVersion),
      ),
    )
    .where(
      and(
        eq(placements.nodeId, nodeId),
        inArray(deployments.status, [...LIVE_DEPLOYMENT_STATUSES]),
        isNull(services.deletedAt),
        isNull(projects.deletedAt),
      ),
    )
    .orderBy(asc(placements.workloadId))
    .limit(MAX_WORKLOADS_PER_NODE);

  const pairs = [
    ...new Map(
      rows.map((r) => [
        `${r.deployment.serviceId}:${r.deployment.environmentId}`,
        { serviceId: r.deployment.serviceId, environmentId: r.deployment.environmentId },
      ]),
    ).values(),
  ];
  const hostnames = new Map<string, { hostname: string; type: string }[]>();
  if (pairs.length) {
    const domainRows = await db
      .select({
        serviceId: domains.serviceId,
        environmentId: domains.environmentId,
        hostname: domains.hostname,
        type: domains.type,
      })
      .from(domains)
      .where(
        and(
          eq(domains.verificationStatus, "verified"),
          or(
            ...pairs.map((p) =>
              and(eq(domains.serviceId, p.serviceId), eq(domains.environmentId, p.environmentId)),
            ),
          ),
        ),
      )
      .orderBy(asc(domains.hostname));
    for (const d of domainRows) {
      const key = `${d.serviceId}:${d.environmentId}`;
      hostnames.set(key, [...(hostnames.get(key) ?? []), d]);
    }
  }

  const volumeServices = new Set<string>();
  if (pairs.length) {
    const held = await db
      .select({ serviceId: volumes.serviceId, environmentId: volumes.environmentId })
      .from(volumes)
      .where(
        and(
          inArray(
            volumes.serviceId,
            pairs.map((p) => p.serviceId),
          ),
          notInArray(volumes.status, ["deleted", "abandoned"]),
        ),
      );
    for (const v of held) volumeServices.add(`${v.serviceId}:${v.environmentId}`);
  }
  const mountOf = new Map(nodeVolumes.map((v) => [`${v.serviceId}:${v.environmentId}`, v]));
  const proxies = node.capabilities?.tcp_proxy ? await tcpProxiesFor(db, pairs) : new Map();

  for (const r of rows) {
    const d = r.deployment;
    if (!d.image || !d.envSealed) continue;
    const pair = `${d.serviceId}:${d.environmentId}`;
    const volume = mountOf.get(pair);
    // SECURITY: a volume service never runs without its volume, or a
    // database would initialise a fresh, empty data directory.
    if (!volume && (r.databaseEngine || volumeServices.has(pair))) continue;
    // SECURITY: a migrating volume is being copied; a running service would
    // write after the snapshot and those writes would be lost on the target.
    if (volume?.status === "migrating") continue;
    const proxy = proxies.get(pair);
    const key = await projectKey(db, keys, r.projectId);
    const payload = await openDeploymentEnv(key, d.envSealed as Sealed, {
      workspaceId: r.workspaceId,
      projectId: r.projectId,
      deploymentId: d.id,
    });
    const networking = r.config.networking;
    body.workloads.push(
      await workloadSpec({
        workloadId: r.placement.workloadId,
        replica: r.placement.replica,
        projectId: r.projectId,
        environmentId: d.environmentId,
        serviceId: d.serviceId,
        deploymentId: d.id,
        image: d.image,
        envSealed: await sealWorkloadEnv(
          nodeKey,
          nodeId,
          r.placement.workloadId,
          node.generation,
          payload,
        ),
        config: r.config,
        hostnames: (hostnames.get(`${d.serviceId}:${d.environmentId}`) ?? [])
          .filter((h) => h.type !== "generated" || networking.generated_domain)
          .map((h) => h.hostname),
        privateDomain: privateDomain(r.serviceSlug, r.environmentSlug),
        ...(volume ? { volume: { id: volume.id, mountPath: volume.mountPath } } : {}),
        ...(r.databaseEngine
          ? { database: { engine: r.databaseEngine, version: r.databaseVersion } }
          : {}),
        ...(proxy
          ? {
              publish: {
                containerPort: proxy.containerPort,
                hostPort: proxy.publicPort,
                allowedCidrs: proxy.allowedCidrs,
              },
            }
          : {}),
      }),
    );
  }
  return body;
}

/** The bindings {@link refreshNodes} needs. */
export interface RefreshEnv {
  NODE_CONNECTION: DurableObjectNamespace<NodeConnection>;
}

/**
 * Bumps each node's `desired_generation` and asks its Durable Object to push
 * the recomputed state. A node that isn't connected gets it on its next hello.
 *
 * @param env - Bindings with the node namespace.
 * @param db - Database client.
 * @param nodeIds - Nodes whose workloads changed; duplicates are ignored.
 */
export async function refreshNodes(
  env: RefreshEnv,
  db: Db,
  nodeIds: Iterable<string>,
): Promise<void> {
  const ids = [...new Set(nodeIds)];
  if (!ids.length) return;
  await db
    .update(nodes)
    .set({ desiredGeneration: sql`${nodes.desiredGeneration} + 1` })
    .where(and(inArray(nodes.id, ids), isNull(nodes.deletedAt)));
  await Promise.all(
    ids.map(async (id) => {
      try {
        await env.NODE_CONNECTION.get(env.NODE_CONNECTION.idFromName(id)).pushDesiredState();
      } catch (err) {
        // The generation is already bumped, so the next hello delivers it.
        console.warn("desired state push failed", id, err);
      }
    }),
  );
}

/**
 * Nodes holding replicas of the given deployments.
 *
 * @param db - Database client.
 * @param deploymentIds - Deployments.
 * @returns Distinct node IDs.
 */
export async function nodesOfDeployments(
  db: Db,
  deploymentIds: readonly string[],
): Promise<string[]> {
  if (!deploymentIds.length) return [];
  const rows = await db
    .selectDistinct({ nodeId: placements.nodeId })
    .from(placements)
    .where(inArray(placements.deploymentId, [...deploymentIds]));
  return rows.map((r) => r.nodeId);
}

/**
 * Refreshes every live node, e.g. after the ingress settings change.
 *
 * @param env - Bindings with the node namespace.
 * @param db - Database client.
 */
export async function refreshAllNodes(env: RefreshEnv, db: Db): Promise<void> {
  const rows = await db.select({ id: nodes.id }).from(nodes).where(isNull(nodes.deletedAt));
  await refreshNodes(
    env,
    db,
    rows.map((r) => r.id),
  );
}
