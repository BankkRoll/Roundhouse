/**
 * A node's desired state, computed from D1 every time it is sent, so a
 * reconnecting agent always gets the truth and nothing is cached in the
 * node's Durable Object.
 *
 * - {@link buildDesiredState}: every `service` workload placed on the node
 *   whose deployment is live (`deploying`, `active`, `crashed`), plus the
 *   install's ingress settings and, for builder nodes, the registry.
 * - {@link refreshNodes}: bumps nodes' `desired_generation` and asks their
 *   Durable Objects to push the new state.
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
} from "@openrail/db";
import {
  computeSpecHash,
  type DesiredState,
  type Healthcheck,
  MAX_WORKLOADS_PER_NODE,
  projectNetworkName,
  REGISTRY_LISTEN,
  type RegistryConfig,
  WORKLOADS_PROTOCOL_VERSION,
  type WorkloadSpec,
} from "@openrail/protocol";
import {
  DEFAULT_PIDS_LIMIT,
  type DeploymentStatus,
  type HealthcheckConfig,
  type ServiceConfigSpec,
} from "@openrail/shared";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { NodeConnection } from "../durable/node-connection";
import type { Sealed } from "./crypto";
import { unsealWith } from "./crypto";
import { getIngressSettings } from "./settings";
import { deploymentEnvAad, projectKey } from "./variables";

/** Deployments whose replicas belong on nodes. */
export const LIVE_DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = [
  "deploying",
  "active",
  "crashed",
];

/** Label carrying a replica's private hostname; see {@link privateDomain}. */
export const PRIVATE_DOMAIN_LABEL = "openrail.private_domain";

/** The body of a `desired_state` frame, without the signed header. */
export type DesiredStateBody = Omit<DesiredState, "id" | "node_id" | "iat" | "exp">;

/**
 * Private hostname of a service in an environment, injected as
 * `OPENRAIL_PRIVATE_DOMAIN` and carried on each replica as
 * {@link PRIVATE_DOMAIN_LABEL} for the agent to register as a network alias.
 *
 * @param serviceSlug - Service slug.
 * @param environmentSlug - Environment slug; one project network spans every environment.
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
  env: Record<string, string>;
  config: Pick<ServiceConfigSpec, "deploy" | "resources" | "healthcheck" | "networking">;
  hostnames: string[];
  privateDomain: string;
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
    env: w.env,
    ports: port ? [{ container_port: port, protocol: "http" }] : [],
    routes: port ? w.hostnames.map((hostname) => ({ hostname, container_port: port })) : [],
    healthcheck: healthcheckSpec(w.config.healthcheck ?? null, port),
    resources: {
      cpu_millis: w.config.resources.cpu_millis,
      memory_mb: w.config.resources.memory_mb,
      pids: DEFAULT_PIDS_LIMIT,
    },
    restart: restartSpec(w.config.deploy),
    network: projectNetworkName(w.projectId),
    labels: { [PRIVATE_DOMAIN_LABEL]: w.privateDomain },
    drain_s: w.config.deploy.drain_s,
  };
  return { ...spec, spec_hash: await computeSpecHash(spec) };
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
 * @param masterKey - Base64 master key, to unseal each deployment's env.
 * @param nodeId - The node.
 * @returns The frame body, or `null` when the node no longer exists.
 */
export async function buildDesiredState(
  db: Db,
  masterKey: string,
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
    })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), isNull(nodes.deletedAt)))
    .limit(1);
  if (!node) return null;
  const ingress = await getIngressSettings(db);
  const runsWorkloads = node.protocolVersion >= WORKLOADS_PROTOCOL_VERSION;
  const body: DesiredStateBody = {
    type: "desired_state",
    generation: node.generation,
    workloads: [],
    tls_mode: ingress.tlsMode,
    apps_domain: ingress.appsDomain,
    registry: runsWorkloads && node.capabilities?.builder ? BUILDER_REGISTRY : null,
  };
  if (!runsWorkloads) return body;

  const rows = await db
    .select({
      placement: placements,
      deployment: deployments,
      serviceSlug: services.slug,
      projectId: services.projectId,
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

  for (const r of rows) {
    const d = r.deployment;
    if (!d.image || !d.envSealed) continue;
    const key = await projectKey(db, masterKey, r.projectId);
    const env = JSON.parse(
      await unsealWith(key, d.envSealed as Sealed, deploymentEnvAad(d.id)),
    ) as Record<string, string>;
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
        env,
        config: r.config,
        hostnames: (hostnames.get(`${d.serviceId}:${d.environmentId}`) ?? [])
          .filter((h) => h.type !== "generated" || networking.generated_domain)
          .map((h) => h.hostname),
        privateDomain: privateDomain(r.serviceSlug, r.environmentSlug),
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
