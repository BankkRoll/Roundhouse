/**
 * Pure helpers behind Servers → Network and a server's mesh status (ADR 0005): path and
 * readiness wording, the per-server readiness checklist with its fixes, handshake
 * freshness, and the ring layout of the network diagram.
 *
 * @module
 */
import type { Mesh, MeshNode, MeshPair, MeshPath } from "../../lib/api/mesh-client";
import { formatRelativeTime } from "../../lib/format";

type Tone = "success" | "warning" | "danger" | "neutral" | "info";

/** WireGuard's listen port when the agent config doesn't set another. */
export const MESH_DEFAULT_PORT = 51820;

/**
 * A handshake older than this means the tunnel is idle or broken. WireGuard re-handshakes
 * every two minutes while traffic flows, and a path is relayed after 120 s without one.
 */
export const HANDSHAKE_STALE_MS = 180_000;

/** The `daemon.json` entry Docker's nftables backend needs to pass marked mesh packets. */
export const DOCKER_FWMARK_SETTING = `"bridge-accept-fwmark": "0x2000000/0x2000000"`;

/** How each path is named, coloured and drawn; the dash keeps paths apart without colour. */
export const PATH_META: Record<
  MeshPath,
  { label: string; tone: Tone; stroke: string; dash: string | undefined; description: string }
> = {
  direct: {
    label: "Direct",
    tone: "success",
    stroke: "stroke-success",
    dash: undefined,
    description: "WireGuard straight between the two servers.",
  },
  relayed: {
    label: "Relayed",
    tone: "warning",
    stroke: "stroke-warning",
    dash: "6 4",
    description: "Through a public relay server, which sees this traffic decrypted.",
  },
  down: {
    label: "Down",
    tone: "danger",
    stroke: "stroke-danger",
    dash: "2 4",
    description: "No working tunnel: traffic between these servers fails.",
  },
};

/** Where a server stands in the mesh, most specific first. */
export type MeshNodeState =
  | "unsupported"
  | "not_joined"
  | "rotating"
  | "error"
  | "waiting"
  | "ready";

/** Label and badge tone of each {@link MeshNodeState}. */
export const MESH_STATE_META: Record<MeshNodeState, { label: string; tone: Tone }> = {
  unsupported: { label: "Agent too old", tone: "neutral" },
  not_joined: { label: "Not joined", tone: "neutral" },
  rotating: { label: "Rotating key", tone: "info" },
  error: { label: "Not ready", tone: "danger" },
  waiting: { label: "Waiting for report", tone: "warning" },
  ready: { label: "Ready", tone: "success" },
};

/**
 * Classifies a server's mesh state.
 *
 * @param node - The server as the mesh reports it.
 * @returns Its state.
 */
export function meshNodeState(node: MeshNode): MeshNodeState {
  if (!node.supported) return "unsupported";
  if (node.mesh_index === null) return "not_joined";
  if (node.rotating) return "rotating";
  if (node.ready) return "ready";
  return node.error || node.status_at !== null ? "error" : "waiting";
}

/** One line of a server's readiness checklist. */
export interface MeshCheck {
  id: "agent" | "interface" | "reachability" | "firewall" | "health";
  label: string;
  /** `pending` when the agent hasn't reported it yet. */
  state: "ok" | "warning" | "failed" | "pending";
  /** What was found. */
  detail: string;
  /** What to do about it; `null` when nothing needs doing. */
  fix: string | null;
  /** A shell command or config line that goes with the fix. */
  snippet?: string;
}

/**
 * The readiness checklist of one server: agent support, `wg0`, reachability, Docker's
 * firewall, and the agent's own verdict, each with the exact fix when it fails.
 *
 * @param node - The server as the mesh reports it.
 * @returns The checks, in the order an operator would work through them.
 */
export function meshChecks(node: MeshNode): MeshCheck[] {
  const port = node.listen_port ?? MESH_DEFAULT_PORT;
  const checks: MeshCheck[] = [
    node.supported
      ? { id: "agent", label: "Agent", state: "ok", detail: "Speaks the mesh protocol.", fix: null }
      : {
          id: "agent",
          label: "Agent",
          state: "failed",
          detail: "This agent predates the mesh, so the server stays a single-node host.",
          fix: "Upgrade the agent on the server by running the install command again.",
        },
  ];
  if (!node.supported) return checks;

  checks.push(
    node.mode === null
      ? {
          id: "interface",
          label: "WireGuard",
          state: "pending",
          detail: "Not reported yet.",
          fix: null,
        }
      : node.mode === "unavailable"
        ? {
            id: "interface",
            label: "WireGuard",
            state: "failed",
            detail: "Neither the wireguard kernel module nor /dev/net/tun is available.",
            fix: "Load the kernel module, or let the agent use /dev/net/tun for userspace WireGuard, then restart the agent.",
            snippet: "modprobe wireguard",
          }
        : {
            id: "interface",
            label: "WireGuard",
            state: "ok",
            detail:
              node.mode === "kernel"
                ? "wg0 runs in the kernel."
                : "wg0 runs in userspace (wireguard-go): it works, with more CPU per packet.",
            fix: null,
          },
  );

  checks.push(
    node.nat === null
      ? {
          id: "reachability",
          label: "Reachability",
          state: "pending",
          detail: "Not reported yet.",
          fix: null,
        }
      : node.nat === "public"
        ? {
            id: "reachability",
            label: "Reachability",
            state: "ok",
            detail: `Public: peers send to ${node.endpoint ?? `UDP ${port}`}.`,
            fix: `UDP ${port} must stay open in the host firewall and in the cloud provider's firewall; a direct path that never handshakes falls back to a relay.`,
          }
        : {
            id: "reachability",
            label: "Reachability",
            state: "warning",
            detail:
              "Behind NAT: other servers can't reach it first, so pairs with servers also behind NAT go through a relay.",
            fix: `For direct paths, forward UDP ${port} to this server and set mesh.endpoint (host:port) in the agent config.`,
          },
  );

  if (node.accept_fwmark === null) {
    checks.push({
      id: "firewall",
      label: "Docker firewall",
      state: "pending",
      detail: "Not reported yet.",
      fix: null,
    });
  } else if (node.accept_fwmark) {
    checks.push({
      id: "firewall",
      label: "Docker firewall",
      state: "ok",
      detail: `${node.docker_firewall ?? "Docker"} backend passes marked mesh packets.`,
      fix: null,
    });
  } else if (node.docker_firewall === "nftables") {
    checks.push({
      id: "firewall",
      label: "Docker firewall",
      state: "failed",
      detail: "Docker's nftables backend drops forwarded mesh packets.",
      fix: "Add this to /etc/docker/daemon.json, then restart Docker (systemctl restart docker).",
      snippet: DOCKER_FWMARK_SETTING,
    });
  } else {
    checks.push({
      id: "firewall",
      label: "Docker firewall",
      state: "failed",
      detail: "The accept rule for marked mesh packets is missing from Docker's iptables chains.",
      fix: "With the iptables backend the agent adds this rule itself and retries; if it stays missing, check the agent log for the iptables error.",
    });
  }

  checks.push(
    node.ready
      ? {
          id: "health",
          label: "Ready",
          state: "ok",
          detail: "wg0 is up, firewall rules are applied and private DNS is listening.",
          fix: null,
        }
      : node.status_at === null
        ? {
            id: "health",
            label: "Ready",
            state: "pending",
            detail: "The agent hasn't reported mesh health yet.",
            fix: null,
          }
        : {
            id: "health",
            label: "Ready",
            state: "failed",
            detail: node.error ?? "The agent reports the mesh isn't ready.",
            fix: null,
          },
  );
  return checks;
}

/**
 * Whether a handshake is recent enough to trust the tunnel.
 *
 * @param at - Last handshake, unix ms, or `null` for never.
 * @param now - Reference time.
 * @returns `fresh`, `stale`, or `never`.
 */
export function handshakeHealth(at: number | null, now: number): "fresh" | "stale" | "never" {
  if (at === null) return "never";
  return now - at <= HANDSHAKE_STALE_MS ? "fresh" : "stale";
}

/**
 * A handshake time as people say it.
 *
 * @param at - Last handshake, unix ms, or `null`.
 * @param now - Reference time.
 * @returns "never", "just now", or an age like "42s ago".
 */
export function formatHandshake(at: number | null, now: number): string {
  return formatRelativeTime(at, now);
}

/**
 * The pairs one server is part of.
 *
 * @param mesh - The workspace's mesh.
 * @param nodeId - The server.
 * @returns Its pairs, each with the other server's id.
 */
export function pairsOf(mesh: Mesh, nodeId: string): { pair: MeshPair; peerId: string }[] {
  return mesh.pairs.flatMap((pair) => {
    const [a, b] = pair.nodes;
    if (a === nodeId) return [{ pair, peerId: b }];
    if (b === nodeId) return [{ pair, peerId: a }];
    return [];
  });
}

/** Counts of pairs by path. */
export type PathCounts = Record<MeshPath, number>;

/**
 * Counts the mesh's pairs by path.
 *
 * @param pairs - Every pair.
 * @returns The counts.
 */
export function countPaths(pairs: readonly MeshPair[]): PathCounts {
  const counts: PathCounts = { direct: 0, relayed: 0, down: 0 };
  for (const pair of pairs) counts[pair.path] += 1;
  return counts;
}

/**
 * The servers that route a service's traffic over the mesh to a replica elsewhere: ready
 * themselves, with a working pair (direct or relayed) to a ready server that runs one.
 * They answer for the service's domains although no replica runs on them.
 *
 * @param mesh - The workspace's mesh.
 * @param servingIds - Servers running a replica of the service.
 * @returns Ids of the other servers that reach a replica over the mesh.
 */
export function meshRoutedNodes(mesh: Mesh, servingIds: readonly string[]): Set<string> {
  const routed = new Set<string>();
  if (!mesh.enabled) return routed;
  const ready = new Set(mesh.nodes.filter((node) => node.ready).map((node) => node.id));
  const serving = new Set(servingIds.filter((id) => ready.has(id)));
  for (const pair of mesh.pairs) {
    if (pair.path === "down") continue;
    const [a, b] = pair.nodes;
    if (serving.has(a) && ready.has(b) && !serving.has(b)) routed.add(b);
    if (serving.has(b) && ready.has(a) && !serving.has(a)) routed.add(a);
  }
  for (const id of servingIds) routed.delete(id);
  return routed;
}

/** A server's place in the network diagram, in viewBox units. */
export interface DiagramPoint {
  id: string;
  x: number;
  y: number;
}

/** Side of the square viewBox the diagram is drawn in. */
export const DIAGRAM_SIZE = 400;

/**
 * Places servers on a ring, first at the top and clockwise, so every pair's line is a
 * chord that never passes through a third server.
 *
 * @param ids - Server ids in display order.
 * @returns Each server's centre.
 */
export function ringLayout(ids: readonly string[]): DiagramPoint[] {
  const centre = DIAGRAM_SIZE / 2;
  if (ids.length === 1) return [{ id: ids[0]!, x: centre, y: centre }];
  const radius = DIAGRAM_SIZE / 2 - 56;
  return ids.map((id, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / ids.length;
    return {
      id,
      x: Math.round((centre + radius * Math.cos(angle)) * 10) / 10,
      y: Math.round((centre + radius * Math.sin(angle)) * 10) / 10,
    };
  });
}
