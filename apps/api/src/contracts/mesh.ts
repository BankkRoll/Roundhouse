/**
 * Servers → Network (ADR 0005): the WireGuard mesh between a workspace's
 * servers, read by the dashboard, the CLI (`servers mesh`) and MCP, key
 * rotation for one server, and the node lifecycle: drain (move replicas
 * off, then maintenance), its progress, and resume. Turning the mesh on, and
 * its supernet, are instance settings (`PATCH /v1/instance/settings`).
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import { DRAIN_MOVE_STATES, NODE_DRAIN_STATUSES, NODE_STATUSES } from "@roundhouse/shared";
import { body, errors, json, Millis, NodeSchema, sessionAuth, WorkspaceParams } from "../schemas";
import { defineRoute, session } from "./policy";

/** How a server runs `wg0`; mirrors `MESH_MODES` in `@roundhouse/protocol`. */
export const MESH_MODE_VALUES = ["kernel", "userspace", "unavailable"] as const;

/** Reachability the agent reported; mirrors `MESH_NAT_KINDS`. */
export const MESH_NAT_VALUES = ["public", "nat"] as const;

/** Docker's firewall backend on the server; mirrors `DOCKER_FIREWALLS`. */
export const DOCKER_FIREWALL_VALUES = ["iptables", "nftables"] as const;

/**
 * How two servers reach each other: straight through WireGuard, through a
 * relay server (both behind NAT, or a direct path that never handshook),
 * or not at all.
 */
export const MESH_PATH_VALUES = ["direct", "relayed", "down"] as const;

/** One server as the mesh sees it. */
export const MeshNodeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.enum(NODE_STATUSES),
    /** The agent speaks the mesh protocol; older agents stay single-node hosts. */
    supported: z.boolean(),
    /** The server's /24 index in the supernet; `null` until it joined the mesh. */
    mesh_index: z.number().int().nullable(),
    /** `wg0` address (the server's `.1`); `null` until it joined. */
    address: z.string().nullable(),
    /** Current WireGuard public key, standard base64; the private key never leaves the server. */
    public_key: z.string().nullable(),
    mode: z.enum(MESH_MODE_VALUES).nullable(),
    nat: z.enum(MESH_NAT_VALUES).nullable(),
    /** Where peers send WireGuard packets (`host:port`); `null` behind NAT. */
    endpoint: z.string().nullable(),
    listen_port: z.number().int().nullable(),
    docker_firewall: z.enum(DOCKER_FIREWALL_VALUES).nullable(),
    /** Docker lets marked mesh packets past its forward drop. */
    accept_fwmark: z.boolean().nullable(),
    /** `wg0` up, firewall rules applied and private DNS listening, as last reported. */
    ready: z.boolean(),
    /** Why the server isn't ready, as the agent reported it. */
    error: z.string().nullable(),
    /** Epoch of the key `wg0` uses; increases with every rotation. */
    key_epoch: z.number().int(),
    key_rotated_at: Millis.nullable(),
    /** A key rotation is in progress. */
    rotating: z.boolean(),
    /** The server relays traffic for at least one pair of servers behind NAT. */
    relay: z.boolean(),
    /** When the agent last reported mesh health. */
    status_at: Millis.nullable(),
  })
  .openapi("MeshNode");

/** One side's view of a tunnel. */
export const MeshPeerViewSchema = z
  .object({
    node_id: z.string(),
    /** The peer's address as this side last saw it. */
    endpoint: z.string().nullable(),
    last_handshake_at: Millis.nullable(),
    rx_bytes: z.number().int(),
    tx_bytes: z.number().int(),
  })
  .openapi("MeshPeerView");

/** A pair of servers in the mesh. */
export const MeshPairSchema = z
  .object({
    /** The two server IDs, lower first. */
    nodes: z.tuple([z.string(), z.string()]),
    path: z.enum(MESH_PATH_VALUES),
    /** The server relaying a `relayed` pair. */
    relay_node_id: z.string().nullable(),
    /** Latest handshake either side reported for this pair's tunnel. */
    last_handshake_at: Millis.nullable(),
    /** Each side's report, when it sent one; empty for relayed pairs (their tunnels go to the relay). */
    sides: z.array(MeshPeerViewSchema).max(2),
  })
  .openapi("MeshPair");

/** The workspace's mesh. */
export const MeshSchema = z
  .object({
    /** Instance setting `mesh_enabled`. */
    enabled: z.boolean(),
    /** Instance setting `mesh_supernet`, e.g. `10.200.0.0/16`. */
    supernet: z.string(),
    nodes: z.array(MeshNodeSchema),
    pairs: z.array(MeshPairSchema),
  })
  .openapi("Mesh");

const NodeParams = WorkspaceParams.extend({ nodeId: z.string() });

/** Servers, pair paths, last handshakes and readiness, for Servers → Network. */
export const getMesh = defineRoute(session("nodes:read"), {
  method: "get",
  path: "/v1/workspaces/{workspaceId}/mesh",
  tags: ["nodes"],
  summary: "Get the private network between servers",
  security: sessionAuth,
  request: { params: WorkspaceParams },
  responses: { 200: json(MeshSchema), ...errors(401, 403, 404) },
});

/**
 * Starts a WireGuard key rotation for one server: it generates a new key,
 * peers switch to it, then the server does. Tunnels to the server pause for
 * about two seconds. One server rotates at a time: 409
 * `mesh_rotation_in_progress` while another one is; 409 `mesh_not_joined`
 * for a server outside the mesh.
 */
export const rotateMeshKey = defineRoute(session("nodes:manage", ["node.mesh_key_rotated"]), {
  method: "post",
  path: "/v1/workspaces/{workspaceId}/nodes/{nodeId}/mesh/rotate-key",
  tags: ["nodes"],
  summary: "Rotate a server's WireGuard key",
  security: sessionAuth,
  request: { params: NodeParams },
  responses: { 202: json(MeshNodeSchema, "Rotation started"), ...errors(401, 403, 404, 409) },
});

/** One replica a drain moves (or, forced, stops). */
export const DrainMoveSchema = z
  .object({
    /** The replica's workload on the drained server. */
    workload_id: z.string(),
    deployment_id: z.string(),
    service_id: z.string(),
    environment_id: z.string(),
    replica: z.number().int(),
    /**
     * `pending` → `moving` (replacement started on `to_node_id`) → `done`
     * (healthy there, old one removed), or `failed` (no server could take
     * it, or it never became healthy; it keeps running here); `stopped` for
     * a volume service a forced drain stopped.
     */
    state: z.enum(DRAIN_MOVE_STATES),
    to_node_id: z.string().nullable(),
    new_workload_id: z.string().nullable(),
    error: z.string().nullable(),
  })
  .openapi("DrainMove");

/** A drain of one server. */
export const NodeDrainSchema = z
  .object({
    id: z.string(),
    node_id: z.string(),
    /** `running`, `blocked` (volume services, see `blocked`), `failed`, `completed` or `cancelled`. */
    status: z.enum(NODE_DRAIN_STATUSES),
    force: z.boolean(),
    moves: z.array(DrainMoveSchema),
    /**
     * Services with a volume that keep the drain from finishing: their data
     * lives on this server. Migrate each volume, or drain with `force`.
     */
    blocked: z.array(
      z.object({ service_id: z.string(), environment_id: z.string(), service_name: z.string() }),
    ),
    error: z.string().nullable(),
    started_by: z.string().nullable(),
    started_at: Millis,
    finished_at: Millis.nullable(),
  })
  .openapi("NodeDrain");

/** Body of `POST /nodes/{nodeId}/drain`. */
export const DrainNodeBody = z
  .object({
    /**
     * Stop volume services instead of stopping at `blocked`; their services
     * are marked `degraded` (`node_maintenance`) until the server resumes.
     */
    force: z.boolean().default(false),
  })
  .openapi("DrainNode");

/**
 * Drains a server: it takes no new replicas (`draining`), its stateless
 * replicas move to other servers four at a time (never two of one service
 * at once), each removed here only once its replacement is healthy, and the
 * server ends in `maintenance`, safe to reboot. 409 `drain_in_progress`
 * while a drain of it runs; 409 `node_not_drainable` for a server that is
 * still pending.
 */
export const drainNode = defineRoute(session("nodes:manage", ["node.drain_started"]), {
  method: "post",
  path: "/v1/workspaces/{workspaceId}/nodes/{nodeId}/drain",
  tags: ["nodes"],
  summary: "Drain a server",
  security: sessionAuth,
  request: { params: NodeParams, ...body(DrainNodeBody) },
  responses: { 202: json(NodeDrainSchema, "Drain started"), ...errors(400, 401, 403, 404, 409) },
});

/** The server's latest drain and its moves; `drain: null` when it was never drained. */
export const getNodeDrain = defineRoute(session("nodes:read"), {
  method: "get",
  path: "/v1/workspaces/{workspaceId}/nodes/{nodeId}/drain",
  tags: ["nodes"],
  summary: "Get a server's drain progress",
  security: sessionAuth,
  request: { params: NodeParams },
  responses: {
    200: json(z.object({ drain: NodeDrainSchema.nullable() })),
    ...errors(401, 403, 404),
  },
});

/**
 * Takes a `draining` or `maintenance` server back into service: it may get
 * new replicas again (nothing moves back on its own), a running drain is
 * cancelled, and volume services a forced drain stopped start again. 409
 * `node_not_draining` otherwise.
 */
export const resumeNode = defineRoute(session("nodes:manage", ["node.resumed"]), {
  method: "post",
  path: "/v1/workspaces/{workspaceId}/nodes/{nodeId}/resume",
  tags: ["nodes"],
  summary: "Resume a server",
  security: sessionAuth,
  request: { params: NodeParams },
  responses: { 200: json(NodeSchema), ...errors(401, 403, 404, 409) },
});

/** Every mesh and node-lifecycle route, for the contract tests. */
export const MESH_ROUTES = { getMesh, rotateMeshKey, drainNode, getNodeDrain, resumeNode } as const;

/** The workspace's mesh. */
export type Mesh = z.infer<typeof MeshSchema>;
/** A drain of one server. */
export type NodeDrain = z.infer<typeof NodeDrainSchema>;
/** One server in the mesh. */
export type MeshNode = z.infer<typeof MeshNodeSchema>;
/** A pair of servers in the mesh. */
export type MeshPair = z.infer<typeof MeshPairSchema>;
