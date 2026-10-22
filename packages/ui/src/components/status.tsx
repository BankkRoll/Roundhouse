import type { DeploymentStatus, NodeStatus } from "@openrail/shared";
import { cn } from "../lib/cn";

type StatusShape = "dot" | "half" | "cross";

/** How a status is drawn: label, glyph, color class, and whether it pulses. */
export interface StatusMeta {
  label: string;
  shape: StatusShape;
  color: string;
  pulse?: boolean;
}

/** Which vocabulary a status string belongs to. */
export type StatusKind = "node" | "deployment" | "workload";

/** Replica states reported by the agent; mirrors `WORKLOAD_STATES` in `@openrail/protocol`. */
export type WorkloadState =
  | "pending"
  | "pulling"
  | "starting"
  | "running"
  | "healthy"
  | "unhealthy"
  | "exited"
  | "crashed"
  | "removed";

/** Display label, glyph and color for every node status. */
export const NODE_STATUS_META: Record<NodeStatus, Readonly<StatusMeta>> = {
  pending: { label: "Pending", shape: "dot", color: "text-subtle-foreground", pulse: true },
  online: { label: "Online", shape: "dot", color: "text-success" },
  degraded: { label: "Degraded", shape: "half", color: "text-warning" },
  offline: { label: "Offline", shape: "cross", color: "text-danger" },
  draining: { label: "Draining", shape: "half", color: "text-warning" },
  maintenance: { label: "Maintenance", shape: "half", color: "text-info" },
};

/** Display label, glyph and color for every deployment status. */
export const DEPLOYMENT_STATUS_META: Record<DeploymentStatus, Readonly<StatusMeta>> = {
  queued: { label: "Queued", shape: "dot", color: "text-subtle-foreground", pulse: true },
  building: { label: "Building", shape: "dot", color: "text-info", pulse: true },
  deploying: { label: "Deploying", shape: "dot", color: "text-info", pulse: true },
  active: { label: "Active", shape: "dot", color: "text-success" },
  failed: { label: "Failed", shape: "cross", color: "text-danger" },
  crashed: { label: "Crashed", shape: "cross", color: "text-danger" },
  cancelled: { label: "Cancelled", shape: "half", color: "text-subtle-foreground" },
  removed: { label: "Removed", shape: "dot", color: "text-subtle-foreground" },
  rolled_back: { label: "Rolled back", shape: "half", color: "text-subtle-foreground" },
};

/** Display label, glyph and color for every replica (workload) state. */
export const WORKLOAD_STATE_META: Record<WorkloadState, Readonly<StatusMeta>> = {
  pending: { label: "Pending", shape: "dot", color: "text-subtle-foreground", pulse: true },
  pulling: { label: "Pulling", shape: "dot", color: "text-info", pulse: true },
  starting: { label: "Starting", shape: "dot", color: "text-info", pulse: true },
  running: { label: "Running", shape: "dot", color: "text-info" },
  healthy: { label: "Healthy", shape: "dot", color: "text-success" },
  unhealthy: { label: "Unhealthy", shape: "half", color: "text-warning" },
  exited: { label: "Exited", shape: "dot", color: "text-subtle-foreground" },
  crashed: { label: "Crashed", shape: "cross", color: "text-danger" },
  removed: { label: "Removed", shape: "dot", color: "text-subtle-foreground" },
};

const META_BY_KIND: Record<StatusKind, Readonly<Record<string, Readonly<StatusMeta>>>> = {
  node: NODE_STATUS_META,
  deployment: DEPLOYMENT_STATUS_META,
  workload: WORKLOAD_STATE_META,
};

/**
 * Looks up how to draw a status, tolerating unknown values from newer servers.
 *
 * @param status - Status string from the API.
 * @param kind - Vocabulary the status belongs to. Defaults to `node`.
 * @returns Label, glyph and color; unknown statuses get a neutral dot.
 */
export function statusMeta(status: string, kind: StatusKind = "node"): StatusMeta {
  const table = META_BY_KIND[kind];
  if (Object.hasOwn(table, status)) return table[status] as StatusMeta;
  return { label: status, shape: "dot", color: "text-subtle-foreground" };
}

/**
 * Human-readable label for a node status, tolerating unknown values from newer servers.
 *
 * @param status - Status string from the API.
 * @returns The display label.
 */
export function nodeStatusLabel(status: string): string {
  return statusMeta(status, "node").label;
}

function Glyph({ shape }: { shape: StatusShape }) {
  if (shape === "cross") {
    return (
      <path
        d="M2.5 2.5l5 5m0-5l-5 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    );
  }
  if (shape === "half") {
    return (
      <>
        <circle cx="5" cy="5" r="3.75" stroke="currentColor" strokeWidth="1.5" fill="none" />
        <path d="M5 1.25a3.75 3.75 0 0 0 0 7.5z" fill="currentColor" />
      </>
    );
  }
  return <circle cx="5" cy="5" r="4" fill="currentColor" />;
}

/** Props for {@link StatusDot}. */
export interface StatusDotProps {
  /** Status string. Unknown strings render as a neutral dot. */
  status: NodeStatus | DeploymentStatus | WorkloadState | (string & {});
  /** Vocabulary of `status`. Defaults to `node`. */
  kind?: StatusKind;
  /** Extra classes. */
  className?: string;
  /**
   * Accessible label. Defaults to the status label; pass `null` when a visible label sits
   * next to the dot so it is not announced twice.
   */
  label?: string | null;
}

/**
 * Status glyph: green dot for online/active, amber half circle for degraded states, red
 * cross for offline/failed, pulsing dot while something is in progress.
 *
 * @param props - Status, vocabulary and labelling options.
 * @returns The rendered glyph.
 */
export function StatusDot({ status, kind, className, label }: StatusDotProps) {
  const meta = statusMeta(status, kind);
  const accessibleLabel = label === undefined ? meta.label : label;
  return (
    <svg
      viewBox="0 0 10 10"
      className={cn("size-2.5 shrink-0", meta.color, meta.pulse && "animate-pulse-dot", className)}
      role={accessibleLabel ? "img" : undefined}
      aria-label={accessibleLabel ?? undefined}
      aria-hidden={accessibleLabel ? undefined : true}
      data-status={status}
    >
      <Glyph shape={meta.shape} />
    </svg>
  );
}

/** Props for {@link StatusBadge}. */
export interface StatusBadgeProps {
  /** Status string. */
  status: NodeStatus | DeploymentStatus | WorkloadState | (string & {});
  /** Vocabulary of `status`. Defaults to `node`. */
  kind?: StatusKind;
  /** Extra classes. */
  className?: string;
}

/**
 * Status glyph followed by its label in mono, e.g. "● online".
 *
 * @param props - Status to show.
 * @returns The rendered badge.
 */
export function StatusBadge({ status, kind, className }: StatusBadgeProps) {
  const meta = statusMeta(status, kind);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[11px] lowercase",
        meta.color,
        className,
      )}
    >
      <StatusDot status={status} kind={kind} label={null} />
      <span>{meta.label}</span>
    </span>
  );
}
