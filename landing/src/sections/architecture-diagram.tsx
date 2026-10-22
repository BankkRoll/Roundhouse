import { cn } from "@openrail/ui";
import { useId, useState } from "react";

/** A box on the schematic. */
interface DiagramNode {
  id: string;
  label: string;
  sub?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Tooltip body. */
  tip: string;
  tone?: "client" | "edge" | "server";
}

const NODES: readonly DiagramNode[] = [
  {
    id: "browser",
    label: "Dashboard",
    sub: "browser",
    x: 24,
    y: 14,
    w: 128,
    h: 44,
    tone: "client",
    tip: "The dashboard is a static app served by your Worker. Sessions, roles and every API call stay inside your account.",
  },
  {
    id: "cli",
    label: "CLI · MCP",
    sub: "terminal, agents",
    x: 176,
    y: 14,
    w: 128,
    h: 44,
    tone: "client",
    tip: "The CLI and the MCP server for coding agents call the same HTTPS API the dashboard uses, with scoped tokens.",
  },
  {
    id: "git",
    label: "Git push",
    sub: "webhook",
    x: 328,
    y: 14,
    w: 128,
    h: 44,
    tone: "client",
    tip: "A push to a tracked branch sends a webhook to your Worker, which queues a build.",
  },
  {
    id: "worker",
    label: "Worker",
    sub: "API · dashboard · auth",
    x: 24,
    y: 124,
    w: 212,
    h: 56,
    tone: "edge",
    tip: "A single Cloudflare Worker serves the API and the dashboard. Installed with a Deploy to Cloudflare button; about $5/mo on Workers Paid.",
  },
  {
    id: "queues",
    label: "Queues · Workflows",
    sub: "builds, backups, jobs",
    x: 256,
    y: 124,
    w: 200,
    h: 56,
    tone: "edge",
    tip: "Durable background work: build jobs, deploy rollouts and scheduled backups survive restarts and retry on failure.",
  },
  {
    id: "d1",
    label: "D1",
    sub: "state",
    x: 24,
    y: 196,
    w: 100,
    h: 52,
    tone: "edge",
    tip: "SQLite at the edge holds users, workspaces, servers, deployments and the audit log.",
  },
  {
    id: "r2",
    label: "R2",
    sub: "images, backups",
    x: 136,
    y: 196,
    w: 100,
    h: 52,
    tone: "edge",
    tip: "Object storage in your account backs the image registry and database backups. No egress fees.",
  },
  {
    id: "do",
    label: "Durable Objects",
    sub: "1 per server · holds its socket",
    x: 256,
    y: 196,
    w: 200,
    h: 52,
    tone: "edge",
    tip: "Each server's WebSocket terminates in its own Durable Object, the only place that sends it signed desired state and records its heartbeats.",
  },
  {
    id: "hetzner",
    label: "hetzner-fsn1",
    sub: "agent · docker · caddy",
    x: 8,
    y: 352,
    w: 144,
    h: 80,
    tone: "server",
    tip: "A rented server running the Go agent. It opened the connection; nothing listens for control traffic on it.",
  },
  {
    id: "ovh",
    label: "ovh-gra",
    sub: "agent · docker · caddy",
    x: 168,
    y: 352,
    w: 144,
    h: 80,
    tone: "server",
    tip: "Any provider works: the agent only needs Linux, Docker and an outbound connection on 443.",
  },
  {
    id: "nuc",
    label: "home-nuc",
    sub: "agent · docker · caddy",
    x: 328,
    y: 352,
    w: 144,
    h: 80,
    tone: "server",
    tip: "A machine behind NAT at home joins the same way, because the agent dials out. No port forwarding for management.",
  },
];

/** A connection between two boxes. */
interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  d: string;
  kind: "https" | "internal" | "wss" | "wireguard";
  /** Send packets both ways. */
  duplex?: boolean;
}

const EDGES: readonly DiagramEdge[] = [
  {
    id: "e-browser",
    from: "browser",
    to: "worker",
    d: "M88 58 C88 92 100 96 100 124",
    kind: "https",
    duplex: true,
  },
  {
    id: "e-cli",
    from: "cli",
    to: "worker",
    d: "M240 58 C240 92 190 96 190 124",
    kind: "https",
    duplex: true,
  },
  { id: "e-git", from: "git", to: "worker", d: "M392 58 C392 100 226 84 226 124", kind: "https" },
  { id: "e-queues", from: "worker", to: "queues", d: "M236 152 L256 152", kind: "internal" },
  { id: "e-d1", from: "worker", to: "d1", d: "M74 180 L74 196", kind: "internal" },
  { id: "e-r2", from: "worker", to: "r2", d: "M186 180 L186 196", kind: "internal" },
  {
    id: "e-do",
    from: "worker",
    to: "do",
    d: "M236 170 C247 170 245 222 256 222",
    kind: "internal",
  },
  {
    id: "e-hetzner",
    from: "hetzner",
    to: "do",
    d: "M80 352 C80 300 290 306 290 248",
    kind: "wss",
    duplex: true,
  },
  {
    id: "e-ovh",
    from: "ovh",
    to: "do",
    d: "M240 352 C240 300 356 306 356 248",
    kind: "wss",
    duplex: true,
  },
  {
    id: "e-nuc",
    from: "nuc",
    to: "do",
    d: "M400 352 C400 304 422 300 422 248",
    kind: "wss",
    duplex: true,
  },
  { id: "w-1", from: "hetzner", to: "ovh", d: "M152 392 L168 392", kind: "wireguard" },
  { id: "w-2", from: "ovh", to: "nuc", d: "M312 392 L328 392", kind: "wireguard" },
  {
    id: "w-3",
    from: "hetzner",
    to: "nuc",
    d: "M80 432 C80 470 400 470 400 432",
    kind: "wireguard",
  },
];

const VIEW = { width: 480, height: 486 };

/** Static CPU and RAM fill for the server boxes' mini meters. */
const METER_FILL: Record<string, [number, number]> = {
  hetzner: [0.38, 0.61],
  ovh: [0.22, 0.47],
  nuc: [0.74, 0.83],
};

/** Text alternative describing the whole schematic. */
export const ARCHITECTURE_DESCRIPTION =
  "Architecture schematic. At the top, the dashboard, a CLI or MCP client, and Git webhooks talk HTTPS to a Worker inside your Cloudflare account. The Worker uses D1 for state, R2 for images and backups, Queues and Workflows for jobs, and one Durable Object per server. At the bottom, three servers (hetzner-fsn1, ovh-gra and home-nuc) each run an agent that dials out over WSS to its Durable Object; nothing connects inward to them. The servers are meshed with WireGuard.";

function tooltipPosition(node: DiagramNode) {
  const cx = ((node.x + node.w / 2) / VIEW.width) * 100;
  const below = node.tone !== "server";
  const top = ((below ? node.y + node.h + 8 : node.y - 8) / VIEW.height) * 100;
  const align = cx < 30 ? "left" : cx > 70 ? "right" : "center";
  const left =
    align === "left"
      ? (node.x / VIEW.width) * 100
      : align === "right"
        ? ((node.x + node.w) / VIEW.width) * 100
        : cx;
  return { top, left, below, align };
}

/**
 * Animated, interactive architecture schematic: clients, the Cloudflare control plane and
 * three servers dialing out. Hovering or focusing a box highlights its connections and
 * shows what it does.
 *
 * @param props - `paused` stops the packet animation; `thirdPartyRequests` feeds the readout.
 * @returns The schematic as a figure with a text description.
 */
export function ArchitectureDiagram({
  paused,
  thirdPartyRequests = null,
}: {
  paused: boolean;
  /** Requests this page made to other origins, printed as a live readout. */
  thirdPartyRequests?: number | null;
}) {
  const [active, setActive] = useState<string | null>(null);
  const baseId = useId();
  const descriptionId = `${baseId}-desc`;
  const tooltipId = `${baseId}-tip`;
  const activeNode = NODES.find((node) => node.id === active);
  const hot = new Set(
    active
      ? EDGES.filter((edge) => edge.from === active || edge.to === active).flatMap((edge) => [
          edge.id,
          edge.from,
          edge.to,
        ])
      : [],
  );

  return (
    <figure
      data-ui
      className="relative m-0 rounded-xl bg-background p-3 sm:p-4"
      data-testid="architecture"
      data-paused={paused || undefined}
      aria-describedby={descriptionId}
    >
      <p id={descriptionId} className="sr-only">
        {ARCHITECTURE_DESCRIPTION}
      </p>
      {/* biome-ignore lint/a11y/useSemanticElements: a <fieldset> cannot hold SVG content; the group names the focusable boxes inside */}
      <svg
        viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
        className="block h-auto w-full select-none"
        role="group"
        aria-label="Architecture: control plane on Cloudflare, compute on your servers"
      >
        <defs>
          <marker
            id={`${baseId}-arrow`}
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 0L8 4L0 8z" className="fill-border-strong" />
          </marker>
        </defs>

        <rect
          x="8"
          y="88"
          width="464"
          height="176"
          rx="10"
          className="fill-accent-subtle/40 stroke-accent/40"
          strokeDasharray="4 4"
        />
        <text x="20" y="108" className="fill-accent-text text-[9px] tracking-[0.14em]">
          YOUR CLOUDFLARE ACCOUNT
        </text>
        <text x="460" y="108" textAnchor="end" className="fill-subtle-foreground text-[9px]">
          ~$5/mo
        </text>

        <text x="314" y="298" className="fill-accent-text text-[9px] tracking-[0.12em]">
          WSS · OUTBOUND
        </text>
        <text x="314" y="311" className="fill-subtle-foreground text-[9px]">
          no inbound port
        </text>
        <text
          x="240"
          y="482"
          textAnchor="middle"
          className="fill-subtle-foreground text-[9px] tracking-[0.12em]"
        >
          WIREGUARD MESH
        </text>

        {EDGES.map((edge) => {
          const isHot = hot.has(edge.id);
          const dim = active !== null && !isHot;
          return (
            <g key={edge.id} className={cn("transition-opacity duration-300", dim && "opacity-25")}>
              <path
                d={edge.d}
                fill="none"
                pathLength={100}
                className={cn(
                  "transition-colors duration-300",
                  edge.kind === "wireguard" ? "stroke-info/60" : "stroke-border-strong",
                  isHot && "stroke-accent",
                )}
                strokeWidth={isHot ? 1.6 : 1.2}
                strokeDasharray={edge.kind === "wireguard" ? "3 3" : undefined}
                markerEnd={
                  edge.kind === "wss" || edge.kind === "https" ? `url(#${baseId}-arrow)` : undefined
                }
              />
              {edge.kind === "internal" ? null : (
                <path
                  d={edge.d}
                  fill="none"
                  pathLength={100}
                  className={cn(
                    "lp-packet",
                    edge.kind === "wireguard" ? "stroke-info" : "stroke-accent",
                    edge.kind === "wss" && "lp-packet-slow",
                  )}
                  strokeWidth={2.4}
                  strokeLinecap="round"
                  style={{ animationDelay: `${(edge.id.length * 0.37) % 2}s` }}
                />
              )}
              {edge.duplex ? (
                <path
                  d={edge.d}
                  fill="none"
                  pathLength={100}
                  className="lp-packet lp-packet-reverse stroke-foreground/70"
                  strokeWidth={2}
                  strokeLinecap="round"
                  style={{ animationDelay: `${(edge.id.length * 0.53) % 2.4}s` }}
                />
              ) : null}
            </g>
          );
        })}

        {NODES.map((node) => {
          const isActive = active === node.id;
          const related = hot.has(node.id);
          const dim = active !== null && !related && !isActive;
          return (
            // biome-ignore lint/a11y/useSemanticElements: SVG has no <button>; the group must stay inside the drawing
            <g
              key={node.id}
              role="button"
              tabIndex={0}
              aria-label={`${node.label}${node.sub ? `, ${node.sub}` : ""}`}
              aria-describedby={isActive ? tooltipId : undefined}
              aria-pressed={isActive}
              data-node={node.id}
              className={cn(
                "cursor-pointer outline-none transition-opacity duration-300 [&:focus-visible>rect:first-child]:stroke-ring",
                dim && "opacity-40",
              )}
              onPointerEnter={() => setActive(node.id)}
              onPointerLeave={() => setActive((current) => (current === node.id ? null : current))}
              onFocus={() => setActive(node.id)}
              onBlur={() => setActive((current) => (current === node.id ? null : current))}
              onClick={() => setActive(node.id)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setActive(null);
              }}
            >
              <rect
                x={node.x}
                y={node.y}
                width={node.w}
                height={node.h}
                rx={6}
                strokeWidth={isActive ? 1.6 : 1}
                className={cn(
                  "transition-colors duration-300",
                  node.tone === "edge" ? "fill-surface-raised" : "fill-surface",
                  isActive || related ? "stroke-accent" : "stroke-border-strong",
                )}
              />
              {node.tone === "server" ? (
                <>
                  {[0, 1].map((row) => (
                    <g key={row}>
                      <rect
                        x={node.x + 12}
                        y={node.y + node.h - 26 + row * 9}
                        width={node.w - 24}
                        height={3}
                        rx={1.5}
                        className="fill-meter-track"
                      />
                      <rect
                        x={node.x + 12}
                        y={node.y + node.h - 26 + row * 9}
                        width={(node.w - 24) * (METER_FILL[node.id]?.[row] ?? 0.4)}
                        height={3}
                        rx={1.5}
                        className={row === 0 ? "fill-meter-fill" : "fill-accent/70"}
                      />
                    </g>
                  ))}
                  <circle
                    cx={node.x + node.w - 14}
                    cy={node.y + 16}
                    r={3.5}
                    className="fill-success"
                  />
                </>
              ) : null}
              <text
                x={node.x + 12}
                y={node.y + (node.tone === "server" ? 22 : node.h / 2 - 2)}
                className="fill-foreground text-[13px] font-semibold"
              >
                {node.label}
              </text>
              {node.sub ? (
                <text
                  x={node.x + 12}
                  y={node.y + (node.tone === "server" ? 38 : node.h / 2 + 13)}
                  className={cn(
                    "fill-muted-foreground",
                    node.tone === "server" ? "text-[9px]" : "text-[10px]",
                  )}
                >
                  {node.sub}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      {activeNode ? <DiagramTooltip id={tooltipId} node={activeNode} /> : null}
      <figcaption className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 font-mono text-[12px] text-muted-foreground">
        <span>Hover or tab through the boxes</span>
        {thirdPartyRequests === null ? null : (
          <span data-testid="third-party-readout">
            Third-party requests from this page:{" "}
            <span className={thirdPartyRequests === 0 ? "text-success" : "text-warning"}>
              {thirdPartyRequests}
            </span>
          </span>
        )}
      </figcaption>
    </figure>
  );
}

function DiagramTooltip({ id, node }: { id: string; node: DiagramNode }) {
  const { top, left, below, align } = tooltipPosition(node);
  const shift = align === "left" ? "0%" : align === "right" ? "-100%" : "-50%";
  return (
    <div
      id={id}
      role="tooltip"
      className="pointer-events-none absolute z-10 w-[min(260px,80vw)] rounded-md border border-border-strong bg-surface-raised/95 px-3 py-2 shadow-xl shadow-black/30"
      style={{
        top: `${top}%`,
        left: `${left}%`,
        transform: `translate(${shift}, ${below ? "0" : "-100%"})`,
      }}
    >
      <p className="font-mono text-[11px] font-semibold text-accent-text">{node.label}</p>
      <p className="mt-1 text-xs leading-relaxed text-foreground">{node.tip}</p>
    </div>
  );
}
