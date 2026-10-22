/**
 * Row → API serialisers for Phase 1 resources. Every response that returns a
 * project, service, deployment, … goes through one of these, so the wire
 * format matches `../schemas` in one place.
 *
 * @module
 */
import type {
  builds,
  deploymentEvents,
  deployments,
  domains,
  environments,
  placements,
  projects,
  serviceConfigs,
  services,
} from "@openrail/db";
import type { TlsMode } from "@openrail/shared";

type Row<T extends { $inferSelect: unknown }> = T["$inferSelect"];

const ms = (d: Date | null): number | null => (d ? +d : null);

/**
 * @param p - Project row.
 * @returns The `Project` wire shape.
 */
export function toApiProject(p: Row<typeof projects>) {
  return {
    id: p.id,
    workspace_id: p.workspaceId,
    name: p.name,
    slug: p.slug,
    description: p.description,
    created_at: +p.createdAt,
    updated_at: +p.updatedAt,
  };
}

/**
 * @param e - Environment row.
 * @returns The `Environment` wire shape.
 */
export function toApiEnvironment(e: Row<typeof environments>) {
  return {
    id: e.id,
    project_id: e.projectId,
    name: e.name,
    slug: e.slug,
    kind: e.kind,
    pr_number: e.prNumber,
    source_branch: e.sourceBranch,
    created_at: +e.createdAt,
  };
}

/**
 * @param s - Service row.
 * @returns The `Service` wire shape.
 */
export function toApiService(s: Row<typeof services>) {
  return {
    id: s.id,
    project_id: s.projectId,
    name: s.name,
    slug: s.slug,
    kind: s.kind,
    icon: s.icon,
    created_at: +s.createdAt,
    updated_at: +s.updatedAt,
  };
}

/**
 * @param c - Config version row.
 * @returns The `ServiceConfig` wire shape.
 */
export function toApiConfig(c: Row<typeof serviceConfigs>) {
  return {
    id: c.id,
    service_id: c.serviceId,
    environment_id: c.environmentId,
    version: c.version,
    created_by: c.createdBy,
    created_at: +c.createdAt,
    source: c.source,
    build: c.build,
    deploy: c.deploy,
    resources: c.resources,
    healthcheck: c.healthcheck ?? null,
    networking: c.networking,
    placement: c.placement,
  };
}

/**
 * @param b - Build row.
 * @returns The `Build` wire shape.
 */
export function toApiBuild(b: Row<typeof builds>) {
  return {
    id: b.id,
    deployment_id: b.deploymentId,
    service_id: b.serviceId,
    commit_sha: b.commitSha,
    commit_message: b.commitMessage,
    commit_author: b.commitAuthor,
    status: b.status,
    node_id: b.nodeId,
    image_repository: b.imageRepository,
    image_digest: b.imageDigest,
    started_at: ms(b.startedAt),
    finished_at: ms(b.finishedAt),
    error: b.error,
    created_at: +b.createdAt,
  };
}

/** A deployment as sent to clients. */
export type ApiDeployment = ReturnType<typeof toApiDeployment>;

/**
 * @param d - Deployment row.
 * @param build - Its build row, when it has one.
 * @returns The `Deployment` wire shape. Never includes the sealed env.
 */
export function toApiDeployment(d: Row<typeof deployments>, build: Row<typeof builds> | null) {
  return {
    id: d.id,
    service_id: d.serviceId,
    environment_id: d.environmentId,
    config_version: d.configVersion,
    build_id: d.buildId,
    build: build ? toApiBuild(build) : null,
    image: d.image,
    status: d.status,
    trigger: d.trigger,
    triggered_by: d.triggeredBy,
    rollback_of: d.rollbackOf,
    failure_reason: d.failureReason,
    started_at: ms(d.startedAt),
    finished_at: ms(d.finishedAt),
    created_at: +d.createdAt,
    updated_at: +d.updatedAt,
  };
}

/**
 * @param e - Deployment event row.
 * @returns The `DeploymentEvent` wire shape.
 */
export function toApiDeploymentEvent(e: Row<typeof deploymentEvents>) {
  return {
    id: e.id,
    deployment_id: e.deploymentId,
    type: e.type,
    message: e.message,
    data: e.data ?? null,
    created_at: +e.createdAt,
  };
}

/**
 * @param p - Placement row.
 * @param nodeName - Name of its node, when the node still exists.
 * @returns The `Placement` wire shape.
 */
export function toApiPlacement(p: Row<typeof placements>, nodeName: string | null) {
  return {
    id: p.id,
    deployment_id: p.deploymentId,
    replica: p.replica,
    node_id: p.nodeId,
    node_name: nodeName,
    workload_id: p.workloadId,
    container_id: p.containerId,
    state: p.state,
    last_status_at: ms(p.lastStatusAt),
  };
}

/**
 * @param d - Domain row.
 * @param tlsMode - Current TLS mode, which decides the URL scheme.
 * @returns The `Domain` wire shape.
 */
export function toApiDomain(d: Row<typeof domains>, tlsMode: TlsMode) {
  return {
    id: d.id,
    service_id: d.serviceId,
    environment_id: d.environmentId,
    hostname: d.hostname,
    url: `${tlsMode === "off" ? "http" : "https"}://${d.hostname}`,
    type: d.type,
    target_port: d.targetPort,
    verification_status: d.verificationStatus,
    tls_status: d.tlsStatus,
    created_at: +d.createdAt,
  };
}
