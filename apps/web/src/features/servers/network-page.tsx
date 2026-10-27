/**
 * Servers → Network (ADR 0005): the private WireGuard network between the workspace's
 * servers.
 *
 * - a figures row: servers in the mesh, ready, and pairs by path;
 * - a diagram with a line per pair, coloured and dashed by path, whose handshake,
 *   endpoints and traffic show on hover, focus or click; relay servers are marked;
 * - the same facts as tables, so nothing depends on seeing the diagram or its colours.
 *
 * @module
 */
import {
  Badge,
  Button,
  EmptyState,
  Kpi,
  KpiStrip,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import { NetworkIcon, ServerIcon } from "lucide-react";
import { type KeyboardEvent, useState } from "react";
import { ErrorState } from "../../components/error-state";
import { PageHeader } from "../../components/page-header";
import { SectionHeader } from "../../components/section-header";
import { errorMessage } from "../../lib/api/client";
import type { Mesh, MeshNode, MeshPair } from "../../lib/api/mesh-client";
import { EMPTY, formatBytes, formatTimestamp } from "../../lib/format";
import { canManageInstance } from "../../lib/permissions";
import { useNow } from "../../lib/use-now";
import { useMe } from "../../queries/me";
import { useMesh } from "../../queries/mesh";
import {
  countPaths,
  DIAGRAM_SIZE,
  formatHandshake,
  handshakeHealth,
  MESH_STATE_META,
  meshNodeState,
  PATH_META,
  ringLayout,
} from "./mesh-format";
import { ServersNav } from "./servers-nav";

/** Above this many servers the diagram drops its labels; the tables still name them. */
const LABELLED_NODES = 16;

const pairKey = (pair: MeshPair) => `${pair.nodes[0]}:${pair.nodes[1]}`;

function nameOf(nodes: ReadonlyMap<string, MeshNode>, id: string | null): string {
  if (id === null) return EMPTY;
  return nodes.get(id)?.name ?? id;
}

function pairLabel(nodes: ReadonlyMap<string, MeshNode>, pair: MeshPair, now: number): string {
  const [a, b] = pair.nodes;
  const relay = pair.relay_node_id ? ` via ${nameOf(nodes, pair.relay_node_id)}` : "";
  return `${nameOf(nodes, a)} to ${nameOf(nodes, b)}: ${PATH_META[pair.path].label.toLowerCase()}${relay}, last handshake ${formatHandshake(pair.last_handshake_at, now)}`;
}

/** Bytes a pair moved, as both sides counted them; the larger count wins. */
function pairTraffic(pair: MeshPair): { rx: number; tx: number } | null {
  if (pair.sides.length === 0) return null;
  const [first] = pair.sides;
  return pair.sides.reduce(
    (most, side) => ({
      rx: Math.max(most.rx, side.rx_bytes),
      tx: Math.max(most.tx, side.tx_bytes),
    }),
    { rx: first!.rx_bytes, tx: first!.tx_bytes },
  );
}

function PathBadge({ pair, nodes }: { pair: MeshPair; nodes: ReadonlyMap<string, MeshNode> }) {
  const meta = PATH_META[pair.path];
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge tone={meta.tone}>{meta.label}</Badge>
      {pair.relay_node_id ? (
        <span className="text-xs text-muted-foreground">
          via {nameOf(nodes, pair.relay_node_id)}
        </span>
      ) : null}
    </span>
  );
}

// -----------------------------------------------------------------------------
// Diagram
// -----------------------------------------------------------------------------

function PathSwatch({ path }: { path: MeshPair["path"] }) {
  const meta = PATH_META[path];
  return (
    <svg width="28" height="8" viewBox="0 0 28 8" aria-hidden="true" className="shrink-0">
      <line
        x1="1"
        y1="4"
        x2="27"
        y2="4"
        strokeWidth="2.5"
        strokeDasharray={meta.dash}
        strokeLinecap="round"
        className={meta.stroke}
      />
    </svg>
  );
}

function Legend() {
  return (
    <ul
      aria-label="Legend"
      className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground"
    >
      {(Object.keys(PATH_META) as MeshPair["path"][]).map((path) => (
        <li key={path} className="flex items-center gap-1.5">
          <PathSwatch path={path} />
          {PATH_META[path].label}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span
          className="size-3 rounded-full border-2 border-dashed border-warning"
          aria-hidden="true"
        />
        Relay server
      </li>
    </ul>
  );
}

function PairDetails({
  pair,
  nodes,
  now,
}: {
  pair: MeshPair;
  nodes: ReadonlyMap<string, MeshNode>;
  now: number;
}) {
  const [a, b] = pair.nodes;
  const health = handshakeHealth(pair.last_handshake_at, now);
  return (
    <div className="grid gap-3">
      <p className="text-sm font-medium text-foreground">
        <span className="font-mono">{nameOf(nodes, a)}</span>
        <span className="text-muted-foreground"> ↔ </span>
        <span className="font-mono">{nameOf(nodes, b)}</span>
      </p>
      <PathBadge pair={pair} nodes={nodes} />
      <p className="text-xs text-muted-foreground">{PATH_META[pair.path].description}</p>
      <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Last handshake</dt>
        <dd
          className={health === "fresh" ? "text-foreground" : "text-warning"}
          title={formatTimestamp(pair.last_handshake_at)}
        >
          {formatHandshake(pair.last_handshake_at, now)}
        </dd>
      </dl>
      {pair.sides.length > 0 ? (
        <ul aria-label="Each side" className="grid gap-2 border-t border-border/70 pt-3">
          {pair.sides.map((side) => {
            const peer = side.node_id === a ? b : a;
            return (
              <li key={side.node_id} className="grid gap-0.5 text-xs">
                <span className="text-foreground">
                  <span className="font-mono">{nameOf(nodes, side.node_id)}</span> sees{" "}
                  <span className="font-mono">{nameOf(nodes, peer)}</span> at{" "}
                  <span className="font-mono">{side.endpoint ?? "no endpoint yet"}</span>
                </span>
                <span className="text-muted-foreground tabular-nums">
                  received {formatBytes(side.rx_bytes)} · sent {formatBytes(side.tx_bytes)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : pair.path === "relayed" ? (
        <p className="text-xs text-muted-foreground">
          Relayed pairs report through their tunnels to the relay, not to each other.
        </p>
      ) : null}
    </div>
  );
}

function NetworkDiagram({
  mesh,
  nodes,
  now,
}: {
  mesh: Mesh;
  nodes: ReadonlyMap<string, MeshNode>;
  now: number;
}) {
  const joined = mesh.nodes.filter((node) => node.mesh_index !== null);
  const points = new Map(ringLayout(joined.map((node) => node.id)).map((p) => [p.id, p]));
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const activeKey = hovered ?? pinned;
  const active = mesh.pairs.find((pair) => pairKey(pair) === activeKey) ?? null;
  const labelled = joined.length <= LABELLED_NODES;

  function onKeyDown(event: KeyboardEvent, key: string) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setPinned((current) => (current === key ? null : key));
    } else if (event.key === "Escape") {
      setPinned(null);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
      <div className="grid gap-3">
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset can't hold SVG; this groups the pair buttons */}
        <svg
          viewBox={`0 0 ${DIAGRAM_SIZE} ${DIAGRAM_SIZE}`}
          role="group"
          aria-label="Network diagram: a line per pair of servers; focus a line for its details"
          className="mx-auto aspect-square w-full max-w-md overflow-visible"
        >
          {mesh.pairs.map((pair) => {
            const from = points.get(pair.nodes[0]);
            const to = points.get(pair.nodes[1]);
            if (!from || !to) return null;
            const key = pairKey(pair);
            const meta = PATH_META[pair.path];
            const isActive = key === activeKey;
            return (
              // biome-ignore lint/a11y/useSemanticElements: an SVG line can't be a <button>; it toggles the pinned details like one
              <g
                key={key}
                role="button"
                tabIndex={0}
                aria-pressed={pinned === key}
                aria-label={pairLabel(nodes, pair, now)}
                data-path={pair.path}
                className="cursor-pointer outline-none [&:focus-visible>line:last-child]:stroke-ring"
                onMouseEnter={() => setHovered(key)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(key)}
                onBlur={() => setHovered(null)}
                onClick={() => setPinned((current) => (current === key ? null : key))}
                onKeyDown={(event) => onKeyDown(event, key)}
              >
                {/* A wide transparent stroke makes the thin line easy to hover. */}
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke="transparent"
                  strokeWidth="14"
                />
                <line
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  strokeWidth={isActive ? 4 : 2}
                  strokeDasharray={meta.dash}
                  strokeLinecap="round"
                  className={meta.stroke}
                  opacity={activeKey && !isActive ? 0.35 : 1}
                />
              </g>
            );
          })}
          {joined.map((node) => {
            const point = points.get(node.id)!;
            const state = meshNodeState(node);
            return (
              // biome-ignore lint/a11y/noAriaHiddenOnFocusable: this <g> has no tabindex; the tables below name every server
              <g key={node.id} aria-hidden="true">
                {node.relay ? (
                  <circle
                    cx={point.x}
                    cy={point.y}
                    r="17"
                    fill="none"
                    strokeWidth="2"
                    strokeDasharray="3 3"
                    className="stroke-warning"
                  />
                ) : null}
                <circle
                  cx={point.x}
                  cy={point.y}
                  r="11"
                  strokeWidth="2"
                  className={
                    state === "ready"
                      ? "fill-surface-raised stroke-foreground"
                      : "fill-surface-raised stroke-danger"
                  }
                />
                {labelled ? (
                  <text
                    x={point.x}
                    y={point.y + (point.y > DIAGRAM_SIZE / 2 ? 34 : -24)}
                    textAnchor="middle"
                    className="fill-foreground font-mono text-[12px]"
                  >
                    {node.name}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        <Legend />
      </div>
      <aside
        aria-label="Selected pair"
        aria-live="polite"
        className="min-h-40 border-t border-border/70 pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6"
      >
        {active ? (
          <PairDetails pair={active} nodes={nodes} now={now} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Hover, focus or select a line for its last handshake, endpoints and traffic.
          </p>
        )}
      </aside>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Tables
// -----------------------------------------------------------------------------

function reachability(node: MeshNode): string {
  if (node.nat === null) return EMPTY;
  return node.nat === "public" ? (node.endpoint ?? "public") : "behind NAT";
}

function ServersTable({ workspaceId, mesh }: { workspaceId: string; mesh: Mesh }) {
  return (
    <Table stack aria-labelledby="mesh-servers-heading">
      <TableHeader>
        <TableRow>
          <TableHead>Server</TableHead>
          <TableHead>Address</TableHead>
          <TableHead>Mode</TableHead>
          <TableHead>Reachability</TableHead>
          <TableHead>State</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {mesh.nodes.map((node) => {
          const state = meshNodeState(node);
          return (
            <TableRow key={node.id}>
              <TableCell cell="primary">
                <Link
                  to="/w/$workspaceId/servers/$nodeId"
                  params={{ workspaceId, nodeId: node.id }}
                  className="font-mono text-foreground outline-none hover:underline focus-visible:underline"
                >
                  {node.name}
                </Link>
                {node.relay ? (
                  <Badge tone="warning" className="ml-2">
                    Relay
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell className="font-mono text-xs">{node.address ?? EMPTY}</TableCell>
              <TableCell>{node.mode ?? EMPTY}</TableCell>
              <TableCell className="font-mono text-xs">{reachability(node)}</TableCell>
              <TableCell>
                <Badge tone={MESH_STATE_META[state].tone} title={node.error ?? undefined}>
                  {MESH_STATE_META[state].label}
                </Badge>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function PairsTable({
  mesh,
  nodes,
  now,
}: {
  mesh: Mesh;
  nodes: ReadonlyMap<string, MeshNode>;
  now: number;
}) {
  return (
    <Table stack aria-labelledby="pairs-heading">
      <TableHeader>
        <TableRow>
          <TableHead>Servers</TableHead>
          <TableHead>Path</TableHead>
          <TableHead>Last handshake</TableHead>
          <TableHead>Traffic</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {mesh.pairs.map((pair) => {
          const traffic = pairTraffic(pair);
          const health = handshakeHealth(pair.last_handshake_at, now);
          return (
            <TableRow key={pairKey(pair)}>
              <TableCell cell="primary" className="font-mono text-xs">
                {nameOf(nodes, pair.nodes[0])} ↔ {nameOf(nodes, pair.nodes[1])}
              </TableCell>
              <TableCell>
                <PathBadge pair={pair} nodes={nodes} />
              </TableCell>
              <TableCell
                className={health === "fresh" ? "tabular-nums" : "text-warning"}
                title={formatTimestamp(pair.last_handshake_at)}
              >
                {formatHandshake(pair.last_handshake_at, now)}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground tabular-nums">
                {traffic ? `${formatBytes(traffic.rx)} in · ${formatBytes(traffic.tx)} out` : EMPTY}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

function MeshOff({ workspaceId, owner }: { workspaceId: string; owner: boolean }) {
  return (
    <EmptyState
      icon={<NetworkIcon />}
      title="The private network is off"
      description={
        owner
          ? "Turn on the WireGuard mesh so environments can span servers and every ingress server can route to every replica. Until then each environment runs on one server."
          : "An instance owner can turn on the WireGuard mesh in the platform settings. Until then each environment runs on one server."
      }
      action={
        owner ? (
          <Button asChild variant="secondary">
            <Link to="/w/$workspaceId/platform" params={{ workspaceId }} hash="network">
              Open network settings
            </Link>
          </Button>
        ) : undefined
      }
      className="py-16"
    />
  );
}

function MeshOverview({ workspaceId, mesh }: { workspaceId: string; mesh: Mesh }) {
  const now = useNow(5000);
  const nodes = new Map(mesh.nodes.map((node) => [node.id, node]));
  const joined = mesh.nodes.filter((node) => node.mesh_index !== null);
  const ready = joined.filter((node) => node.ready).length;
  const paths = countPaths(mesh.pairs);
  return (
    <div className="grid gap-12">
      <KpiStrip label="Network at a glance">
        <Kpi label="In the mesh" value={joined.length} unit={`of ${mesh.nodes.length}`} />
        <Kpi
          label="Ready"
          value={ready}
          unit={`of ${joined.length}`}
          alert={ready < joined.length}
        />
        <Kpi label="Direct pairs" value={paths.direct} />
        <Kpi label="Relayed pairs" value={paths.relayed} />
        <Kpi label="Down pairs" value={paths.down} alert={paths.down > 0} />
      </KpiStrip>
      {joined.length > 0 ? (
        <section aria-labelledby="topology-heading">
          <SectionHeader
            id="topology-heading"
            title="Topology"
            meta={`${mesh.pairs.length} ${mesh.pairs.length === 1 ? "pair" : "pairs"}`}
          />
          {joined.length === 1 ? (
            <p className="text-sm text-muted-foreground">
              One server in the mesh: add another and they connect automatically.
            </p>
          ) : (
            <NetworkDiagram mesh={mesh} nodes={nodes} now={now} />
          )}
        </section>
      ) : null}
      <section aria-labelledby="mesh-servers-heading">
        <SectionHeader id="mesh-servers-heading" title="Servers" />
        <ServersTable workspaceId={workspaceId} mesh={mesh} />
      </section>
      {mesh.pairs.length > 0 ? (
        <section aria-labelledby="pairs-heading">
          <SectionHeader id="pairs-heading" title="Pairs" />
          <PairsTable mesh={mesh} nodes={nodes} now={now} />
        </section>
      ) : null}
    </div>
  );
}

/**
 * Servers → Network: the private network between the workspace's servers, as a diagram
 * and as tables, or how to turn it on.
 *
 * @param props - Workspace id.
 * @returns The page.
 */
export function NetworkPage({ workspaceId }: { workspaceId: string }) {
  const mesh = useMesh(workspaceId);
  const { data: me } = useMe();
  const owner = canManageInstance(me);

  return (
    <>
      <PageHeader
        title="Servers"
        subline={
          mesh.data?.enabled
            ? `Private network ${mesh.data.supernet} · WireGuard between every pair of servers`
            : undefined
        }
      />
      <ServersNav workspaceId={workspaceId} />
      {mesh.isPending ? (
        <div className="grid gap-6">
          <Skeleton className="h-20" />
          <Skeleton className="h-80" />
        </div>
      ) : mesh.isError ? (
        <ErrorState message={errorMessage(mesh.error)} onRetry={() => void mesh.refetch()} />
      ) : !mesh.data.enabled ? (
        <MeshOff workspaceId={workspaceId} owner={owner} />
      ) : mesh.data.nodes.length === 0 ? (
        <EmptyState
          icon={<ServerIcon />}
          title="No servers yet"
          description="Servers join the private network as soon as their agent connects."
          className="py-16"
        />
      ) : (
        <MeshOverview workspaceId={workspaceId} mesh={mesh.data} />
      )}
    </>
  );
}
