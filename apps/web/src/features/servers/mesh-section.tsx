/**
 * A server's place in the private network (ADR 0005), on its detail page: address, how
 * `wg0` runs, reachability, Docker's firewall, the readiness checklist with exact fixes,
 * a health row per peer, and rotating the server's WireGuard key (`nodes:manage`).
 *
 * @module
 */
import {
  Badge,
  Button,
  copyText,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleXIcon,
  CopyIcon,
  KeyRoundIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { SectionHeader } from "../../components/section-header";
import { errorMessage, isApiError } from "../../lib/api/client";
import type { Mesh, MeshNode } from "../../lib/api/mesh-client";
import { EMPTY, formatBytes, formatRelativeTime, formatTimestamp } from "../../lib/format";
import { useMesh, useRotateMeshKey } from "../../queries/mesh";
import {
  formatHandshake,
  handshakeHealth,
  MESH_DEFAULT_PORT,
  MESH_STATE_META,
  type MeshCheck,
  meshChecks,
  meshNodeState,
  PATH_META,
  pairsOf,
} from "./mesh-format";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 border-b border-border/70 py-2.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-sm text-foreground tabular-nums">{children}</dd>
    </div>
  );
}

const CHECK_ICON: Record<MeshCheck["state"], { icon: ReactNode; label: string }> = {
  ok: { icon: <CircleCheckIcon className="size-4 text-success" />, label: "OK" },
  warning: { icon: <CircleAlertIcon className="size-4 text-warning" />, label: "Attention" },
  failed: { icon: <CircleXIcon className="size-4 text-danger" />, label: "Failed" },
  pending: {
    icon: <CircleDashedIcon className="size-4 text-muted-foreground" />,
    label: "Pending",
  },
};

function Snippet({ value }: { value: string }) {
  return (
    <span className="mt-1 flex max-w-full items-center gap-1 rounded-md border border-border bg-surface px-2 py-1">
      <code className="min-w-0 overflow-x-auto font-mono text-xs whitespace-nowrap text-foreground">
        {value}
      </code>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Copy ${value}`}
        onClick={() =>
          void copyText(value).then((ok) =>
            toast({ title: ok ? "Copied" : "Could not copy", tone: ok ? "success" : "error" }),
          )
        }
      >
        <CopyIcon />
      </Button>
    </span>
  );
}

function Checklist({ node }: { node: MeshNode }) {
  return (
    <ul aria-label="Readiness" className="grid border-t border-border/70">
      {meshChecks(node).map((check) => (
        <li
          key={check.id}
          className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-3 border-b border-border/70 py-2.5"
        >
          <span className="mt-0.5" aria-hidden="true">
            {CHECK_ICON[check.state].icon}
          </span>
          <div className="grid min-w-0 gap-0.5">
            <p className="text-sm text-foreground">
              {check.label}
              <span className="sr-only">: {CHECK_ICON[check.state].label}</span>
            </p>
            <p className="text-[13px] text-muted-foreground">{check.detail}</p>
            {check.fix ? <p className="text-[13px] text-foreground">{check.fix}</p> : null}
            {check.snippet ? <Snippet value={check.snippet} /> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

function PeersTable({
  workspaceId,
  mesh,
  node,
  now,
}: {
  workspaceId: string;
  mesh: Mesh;
  node: MeshNode;
  now: number;
}) {
  const names = new Map(mesh.nodes.map((row) => [row.id, row.name]));
  const peers = pairsOf(mesh, node.id);
  if (peers.length === 0) {
    return <p className="text-sm text-muted-foreground">No other server in the mesh yet.</p>;
  }
  return (
    <Table stack aria-label="Peers">
      <TableHeader>
        <TableRow>
          <TableHead>Peer</TableHead>
          <TableHead>Path</TableHead>
          <TableHead>Last handshake</TableHead>
          <TableHead>Endpoint</TableHead>
          <TableHead className="text-right">Traffic</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {peers.map(({ pair, peerId }) => {
          const meta = PATH_META[pair.path];
          const side = pair.sides.find((view) => view.node_id === node.id);
          const health = handshakeHealth(pair.last_handshake_at, now);
          return (
            <TableRow key={peerId}>
              <TableCell cell="primary">
                <Link
                  to="/w/$workspaceId/servers/$nodeId"
                  params={{ workspaceId, nodeId: peerId }}
                  className="font-mono text-foreground outline-none hover:underline focus-visible:underline"
                >
                  {names.get(peerId) ?? peerId}
                </Link>
              </TableCell>
              <TableCell>
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  {pair.relay_node_id ? (
                    <span className="text-xs text-muted-foreground">
                      via {names.get(pair.relay_node_id) ?? pair.relay_node_id}
                    </span>
                  ) : null}
                </span>
              </TableCell>
              <TableCell
                className={health === "fresh" ? "tabular-nums" : "text-warning"}
                title={formatTimestamp(pair.last_handshake_at)}
              >
                {formatHandshake(pair.last_handshake_at, now)}
              </TableCell>
              <TableCell className="font-mono text-xs">{side?.endpoint ?? EMPTY}</TableCell>
              <TableCell className="text-right text-xs text-muted-foreground tabular-nums">
                {side
                  ? `${formatBytes(side.rx_bytes)} in · ${formatBytes(side.tx_bytes)} out`
                  : EMPTY}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function rotateErrorMessage(error: unknown): string {
  if (isApiError(error, "mesh_rotation_in_progress")) {
    return `${errorMessage(error)} Servers rotate one at a time; try again in a minute.`;
  }
  return errorMessage(error);
}

function firewallSummary(node: MeshNode): string {
  if (node.docker_firewall === null) return EMPTY;
  if (node.accept_fwmark === null) return node.docker_firewall;
  return `${node.docker_firewall} · ${node.accept_fwmark ? "mesh packets accepted" : "mesh packets dropped"}`;
}

function reachabilitySummary(node: MeshNode): string {
  if (node.nat === null) return EMPTY;
  return node.nat === "public"
    ? `Public${node.endpoint ? ` · ${node.endpoint}` : ""}`
    : "Behind NAT · peers reach it through a relay or its own first packet";
}

/**
 * The mesh part of a server's detail page. Renders nothing for callers who can't read
 * the mesh, and one line while the mesh is off.
 *
 * @param props - Workspace, server, whether the caller may rotate keys, and the clock.
 * @returns The section, or `null`.
 */
export function MeshSection({
  workspaceId,
  nodeId,
  canManage,
  now,
}: {
  workspaceId: string;
  nodeId: string;
  canManage: boolean;
  now: number;
}) {
  const mesh = useMesh(workspaceId);
  const rotate = useRotateMeshKey(workspaceId);
  const [confirming, setConfirming] = useState(false);
  if (!mesh.data) return null;
  const node = mesh.data.nodes.find((row) => row.id === nodeId);
  if (!node) return null;

  if (!mesh.data.enabled) {
    return (
      <section aria-labelledby="mesh-heading">
        <SectionHeader id="mesh-heading" title="Private network" meta="off" />
        <p className="text-sm text-muted-foreground">
          The WireGuard mesh is off for this instance, so environments stay on one server. An
          instance owner turns it on under Settings → Platform → Network.
        </p>
      </section>
    );
  }

  const state = meshNodeState(node);
  const joined = node.mesh_index !== null;
  const relayed = mesh.data.pairs.filter((pair) => pair.relay_node_id === node.id).length;

  return (
    <section aria-labelledby="mesh-heading">
      <SectionHeader
        id="mesh-heading"
        title="Private network"
        meta={<Badge tone={MESH_STATE_META[state].tone}>{MESH_STATE_META[state].label}</Badge>}
        action={
          canManage && joined ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={node.rotating}
              onClick={() => setConfirming(true)}
            >
              <KeyRoundIcon />
              Rotate mesh key
            </Button>
          ) : undefined
        }
      />
      {node.error && state === "error" ? (
        <p role="alert" className="mb-4 text-sm text-danger">
          {node.error}
        </p>
      ) : null}
      <div className="grid gap-8">
        {joined ? (
          <dl className="grid border-t border-border/70 md:grid-cols-2 md:gap-x-10">
            <Fact label="Address">
              <span className="font-mono">{node.address ?? EMPTY}</span>
            </Fact>
            <Fact label="Mode">{node.mode ?? EMPTY}</Fact>
            <Fact label="Reachability">
              <span className="font-mono text-xs">{reachabilitySummary(node)}</span>
            </Fact>
            <Fact label="Listen port">
              <span className="font-mono">UDP {node.listen_port ?? MESH_DEFAULT_PORT}</span>
            </Fact>
            <Fact label="Docker firewall">{firewallSummary(node)}</Fact>
            <Fact label="Key">
              <span title={formatTimestamp(node.key_rotated_at)}>
                epoch {node.key_epoch}
                {node.key_rotated_at !== null
                  ? ` · rotated ${formatRelativeTime(node.key_rotated_at, now)}`
                  : ""}
                {node.rotating ? " · rotating now" : ""}
              </span>
            </Fact>
            <Fact label="Relay">
              {node.relay
                ? `Yes, for ${relayed} ${relayed === 1 ? "pair" : "pairs"} behind NAT`
                : "No"}
            </Fact>
            <Fact label="Last report">
              <span title={formatTimestamp(node.status_at)}>
                {formatRelativeTime(node.status_at, now)}
              </span>
            </Fact>
          </dl>
        ) : null}
        <div className="grid gap-2">
          <h3 className="text-sm font-medium text-foreground">Readiness</h3>
          <Checklist node={node} />
        </div>
        {joined ? (
          <div className="grid gap-2">
            <h3 className="text-sm font-medium text-foreground">Peers</h3>
            <PeersTable workspaceId={workspaceId} mesh={mesh.data} node={node} now={now} />
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) rotate.reset();
        }}
        title={`Rotate the mesh key of ${node.name}?`}
        description={`${node.name} generates a new WireGuard key and its peers switch to it. Tunnels to ${node.name} pause for about two seconds while they do. Keys also rotate on their own every 90 days; rotate now after a suspected compromise.`}
        confirmLabel="Rotate key"
        destructive={false}
        pending={rotate.isPending}
        error={rotate.isError ? rotateErrorMessage(rotate.error) : null}
        onConfirm={() =>
          rotate.mutate(node.id, {
            onSuccess: () => {
              setConfirming(false);
              toast({ title: `Rotating the mesh key of ${node.name}`, tone: "success" });
            },
          })
        }
      />
    </section>
  );
}
