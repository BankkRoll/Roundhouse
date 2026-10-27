/**
 * MCP tools for one server's health and lifecycle (ADR 0005, "Node
 * lifecycle"):
 *
 * - `get_node_health` (read): status and usage, mesh state, latest drain,
 *   and the replicas on the server in projects the caller can see.
 * - `list_degraded_services` (read): services waiting on a server, with why.
 * - `drain_node`, `resume_node` (writes): the same `startDrain` and
 *   `resumeDrainedNode` the REST routes call, checked against the routes'
 *   contract action (`nodes:manage`) and audited with the routes' actions
 *   plus `via: "mcp"`. `mcp/route.ts` applies the token scope check and the
 *   two-factor gate before either runs.
 *
 * @module
 */
import { deployments, environments, placements, projects, services } from "@roundhouse/db";
import type { Action, ApiTokenScope, ProjectAction } from "@roundhouse/shared";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { type AppContext, clientIp, requireWorkspace, visibleProjects } from "../context";
import { drainNode, getNodeDrain, listServices, policyOf, resumeNode } from "../contracts";
import { readMesh } from "../lib/mesh";
import {
  currentDrainBlockers,
  latestDrain,
  loadWorkspaceNode,
  resumeDrainedNode,
  startDrain,
  toApiBlocker,
  toApiDrain,
} from "../lib/node-lifecycle";
import { toApiNode } from "../lib/nodes";
import { healthNodesOf } from "../lib/service-health";
import type { McpTool, ToolContext } from "./tools";

const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

const scopeOf = (route: Parameters<typeof policyOf>[0]): ApiTokenScope =>
  policyOf(route).action as Exclude<Action, "instance:manage" | "workspaces:create">;

/** The project action a service list checks; services are listed only where it holds. */
const SERVICES_READ = scopeOf(listServices) as ProjectAction;

/** Deployments whose replicas count as running somewhere. */
const LIVE_DEPLOYMENT_STATUSES = ["deploying", "active", "crashed"] as const;

const WorkspaceInput = z
  .string()
  .min(1)
  .max(128)
  .optional()
  .describe("Workspace ID. Defaults to the token's workspace.");

const NodeInput = z.string().min(1).max(128).describe("Server (node) ID, from list_nodes.");

/** Why a service is degraded, for an agent to relay. */
const HEALTH_REASON_TEXT = {
  node_offline:
    "Its data lives on a server that went offline; a replica with a volume can't move on " +
    "its own. It recovers when that server reconnects.",
  node_maintenance:
    "A forced drain stopped it on its server; it restarts there when the server is resumed " +
    "(resume_node).",
} as const;

function auditMetadata({ tool, token }: ToolContext) {
  return {
    via: "mcp",
    tool,
    ...(token.oauth ? { oauth_client_id: token.oauth.clientId } : {}),
  };
}

/** The replicas on a server, in projects the caller may read services of. */
async function servicesOnNode(c: AppContext, workspaceId: string, nodeId: string) {
  const visible = await visibleProjects(c, workspaceId, SERVICES_READ);
  const rows = await c
    .get("db")
    .select({
      serviceId: services.id,
      serviceName: services.name,
      health: services.health,
      healthReason: services.healthReason,
      projectId: projects.id,
      projectName: projects.name,
      environmentId: environments.id,
      environmentName: environments.name,
      deploymentId: deployments.id,
      deploymentStatus: deployments.status,
      replica: placements.replica,
      state: placements.state,
    })
    .from(placements)
    .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .innerJoin(environments, eq(environments.id, deployments.environmentId))
    .where(
      and(
        eq(placements.nodeId, nodeId),
        eq(projects.workspaceId, workspaceId),
        inArray(deployments.status, [...LIVE_DEPLOYMENT_STATUSES]),
        isNull(services.deletedAt),
        isNull(projects.deletedAt),
      ),
    )
    .orderBy(asc(projects.name), asc(services.name), asc(placements.replica));
  return rows
    .filter((r) => visible.has(r.projectId))
    .map((r) => ({
      service_id: r.serviceId,
      service_name: r.serviceName,
      project_id: r.projectId,
      project_name: r.projectName,
      environment_id: r.environmentId,
      environment_name: r.environmentName,
      deployment_id: r.deploymentId,
      deployment_status: r.deploymentStatus,
      replica: r.replica,
      state: r.state,
      health: r.health,
      health_reason: r.healthReason,
    }));
}

const getNodeHealthTool: McpTool = {
  name: "get_node_health",
  title: "Get a server's health",
  description:
    "Returns one server's health: status (online, degraded, offline, draining, maintenance), " +
    "CPU, memory and disk usage against capacity, last heartbeat, its mesh state (address, " +
    "readiness, error, and the path and handshake age to each peer), its latest drain with " +
    "the services blocking it, and the replicas running on it in projects you can see. " +
    "Read-only.",
  input: z.object({ node_id: NodeInput, workspace_id: WorkspaceInput }),
  scopes: [scopeOf(getNodeDrain), SERVICES_READ],
  annotations: READ,
  async run({ c, token }, raw) {
    const input = raw as { node_id: string; workspace_id?: string };
    const workspaceId = input.workspace_id ?? token.workspaceId;
    await requireWorkspace(c, workspaceId, policyOf(getNodeDrain).action!);
    const db = c.get("db");
    const node = await loadWorkspaceNode(db, workspaceId, input.node_id);
    const now = Date.now();
    const [mesh, drain, replicas] = await Promise.all([
      readMesh(db, workspaceId, now),
      latestDrain(db, node.id),
      servicesOnNode(c, workspaceId, node.id),
    ]);
    const names = new Map(mesh.nodes.map((n) => [n.id, n.name]));
    const self = mesh.nodes.find((n) => n.id === node.id);
    const joined = self?.mesh_index !== null && self?.mesh_index !== undefined;
    return {
      server: toApiNode(node, now),
      mesh: {
        enabled: mesh.enabled,
        joined,
        address: self?.address ?? null,
        mode: self?.mode ?? null,
        nat: self?.nat ?? null,
        ready: self?.ready ?? false,
        error: self?.error ?? null,
        relay: self?.relay ?? false,
        rotating: self?.rotating ?? false,
        peers: mesh.pairs
          .filter((pair) => pair.nodes.includes(node.id))
          .map((pair) => {
            const peer = pair.nodes.find((id) => id !== node.id)!;
            return {
              server_id: peer,
              server: names.get(peer) ?? peer,
              path: pair.path,
              relay: pair.relay_node_id
                ? (names.get(pair.relay_node_id) ?? pair.relay_node_id)
                : null,
              handshake_age_s:
                pair.last_handshake_at === null
                  ? null
                  : Math.max(0, Math.round((now - pair.last_handshake_at) / 1000)),
            };
          }),
      },
      drain: drain
        ? (({ moves, ...rest }) => ({
            ...rest,
            moves: {
              total: moves.length,
              done: moves.filter((m) => m.state === "done").length,
              failed: moves.filter((m) => m.state === "failed").length,
              stopped: moves.filter((m) => m.state === "stopped").length,
              errors: moves.flatMap((m) => (m.error ? [m.error] : [])),
            },
          }))(toApiDrain(drain))
        : null,
      replicas,
    };
  },
};

const listDegradedServicesTool: McpTool = {
  name: "list_degraded_services",
  title: "List degraded services",
  description:
    "Lists the workspace's services marked degraded, in projects you can see: a service " +
    "with a volume whose server went offline (node_offline), or one a forced drain stopped " +
    "(node_maintenance). Each comes with the server it waits on and what ends it. " +
    "Read-only; get_node_health shows that server.",
  input: z.object({ workspace_id: WorkspaceInput }),
  scopes: [SERVICES_READ],
  annotations: READ,
  async run({ c, token }, raw) {
    const input = raw as { workspace_id?: string };
    const workspaceId = input.workspace_id ?? token.workspaceId;
    const visible = await visibleProjects(c, workspaceId, SERVICES_READ);
    const db = c.get("db");
    const rows = (
      await db
        .select({ service: services, projectName: projects.name })
        .from(services)
        .innerJoin(projects, eq(projects.id, services.projectId))
        .where(
          and(
            eq(projects.workspaceId, workspaceId),
            eq(services.health, "degraded"),
            isNull(services.deletedAt),
            isNull(projects.deletedAt),
          ),
        )
        .orderBy(asc(projects.name), asc(services.name))
    ).filter((r) => visible.has(r.service.projectId));
    const waitingOn = await healthNodesOf(
      db,
      rows.map((r) => r.service),
    );
    return {
      services: rows.map(({ service, projectName }) => {
        const reason = service.healthReason ?? "node_offline";
        return {
          service_id: service.id,
          service_name: service.name,
          project_id: service.projectId,
          project_name: projectName,
          health_reason: service.healthReason,
          explanation: HEALTH_REASON_TEXT[reason],
          server: waitingOn.get(service.id) ?? null,
        };
      }),
    };
  },
};

const drainNodeTool: McpTool = {
  name: "drain_node",
  title: "Drain a server",
  description:
    "Drains a server so it can be rebooted: it takes no new replicas, its stateless replicas " +
    "move to other servers (each old one removed only once its replacement is healthy), and " +
    "it ends in maintenance. Services with a volume keep their data on the server and block " +
    "the drain; they are listed in volume_services. Without force the drain stops at " +
    "`blocked`; with force they are stopped and marked degraded until resume_node. Poll " +
    "get_node_health for progress. Needs nodes:manage.",
  input: z.object({
    node_id: NodeInput,
    force: z
      .boolean()
      .default(false)
      .describe("Stop volume services instead of stopping the drain at `blocked`."),
    workspace_id: WorkspaceInput,
  }),
  scopes: [scopeOf(drainNode)],
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  async run(ctx, raw) {
    const { c, token } = ctx;
    const input = raw as { node_id: string; force: boolean; workspace_id?: string };
    const workspaceId = input.workspace_id ?? token.workspaceId;
    const caller = await requireWorkspace(c, workspaceId, policyOf(drainNode).action!);
    const db = c.get("db");
    // NOTE: Read before starting: the workflow parks forced volume services
    // as its first step, after which they no longer count as blockers.
    await loadWorkspaceNode(db, workspaceId, input.node_id);
    const blockers = await currentDrainBlockers(db, input.node_id);
    const { drain } = await startDrain(
      { db, env: c.env },
      { workspaceId, nodeId: input.node_id, force: input.force, startedBy: caller.user.id },
      { actor: caller.actor, ip: clientIp(c), metadata: auditMetadata(ctx) },
    );
    const outcome = !blockers.length
      ? "Every replica can move; the server ends in maintenance once they are healthy elsewhere."
      : input.force
        ? "The volume services are stopped and marked degraded until resume_node restarts them here."
        : "The drain will stop at `blocked` because of the volume services. Migrate their " +
          "volumes, or call drain_node again with force: true; resume_node takes the server " +
          "back into service.";
    return {
      drain: toApiDrain(drain),
      volume_services: blockers.map(toApiBlocker),
      outcome,
    };
  },
};

const resumeNodeTool: McpTool = {
  name: "resume_node",
  title: "Resume a server",
  description:
    "Takes a draining or maintenance server back into service: it may get new replicas again " +
    "(nothing moves back on its own), a running drain is cancelled, and volume services a " +
    "forced drain stopped start again on it. Needs nodes:manage.",
  input: z.object({ node_id: NodeInput, workspace_id: WorkspaceInput }),
  scopes: [scopeOf(resumeNode)],
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  async run(ctx, raw) {
    const { c, token } = ctx;
    const input = raw as { node_id: string; workspace_id?: string };
    const workspaceId = input.workspace_id ?? token.workspaceId;
    const caller = await requireWorkspace(c, workspaceId, policyOf(resumeNode).action!);
    const { node, restarted } = await resumeDrainedNode(
      { db: c.get("db"), env: c.env },
      { workspaceId, nodeId: input.node_id },
      { actor: caller.actor, ip: clientIp(c), metadata: auditMetadata(ctx) },
    );
    return { server: toApiNode(node), restarted };
  },
};

/** The server health and lifecycle tools, in `tools/list` order. */
export const NODE_TOOLS: readonly McpTool[] = [
  getNodeHealthTool,
  listDegradedServicesTool,
  drainNodeTool,
  resumeNodeTool,
];
