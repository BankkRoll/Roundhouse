import type { NodeStatus } from "@openrail/shared";
import { cn } from "../lib/cn";

type StatusShape = "dot" | "half" | "cross";

interface StatusMeta {
  label: string;
  shape: StatusShape;
  color: string;
  pulse?: boolean;
}

/** Display label, glyph and color for every node status. */
export const NODE_STATUS_META: Record<NodeStatus, Readonly<StatusMeta>> = {
  pending: { label: "Pending", shape: "dot", color: "text-subtle-foreground", pulse: true },
  online: { label: "Online", shape: "dot", color: "text-success" },
  degraded: { label: "Degraded", shape: "half", color: "text-warning" },
  offline: { label: "Offline", shape: "cross", color: "text-danger" },
  draining: { label: "Draining", shape: "half", color: "text-warning" },
  maintenance: { label: "Maintenance", shape: "half", color: "text-info" },
};

/**
 * Human-readable label for a node status, tolerating unknown values from newer servers.
 *
 * @param status - Status string from the API.
 * @returns The display label.
 */
export function nodeStatusLabel(status: string): string {
  return NODE_STATUS_META[status as NodeStatus]?.label ?? status;
}

function metaFor(status: string): StatusMeta {
  return (
    NODE_STATUS_META[status as NodeStatus] ?? {
      label: status,
      shape: "dot",
      color: "text-subtle-foreground",
    }
  );
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
  /** Node status. Unknown strings render as a neutral dot. */
  status: NodeStatus | (string & {});
  /** Extra classes. */
  className?: string;
  /**
   * Accessible label. Defaults to the status label; pass `null` when a visible label sits
   * next to the dot so it is not announced twice.
   */
  label?: string | null;
}

/**
 * Status glyph: green dot for online, amber half circle for degraded/draining, red cross
 * for offline, pulsing gray dot while pending.
 *
 * @param props - Status and labelling options.
 * @returns The rendered glyph.
 */
export function StatusDot({ status, className, label }: StatusDotProps) {
  const meta = metaFor(status);
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
  /** Node status. */
  status: NodeStatus | (string & {});
  /** Extra classes. */
  className?: string;
}

/**
 * Status glyph followed by its label in mono, e.g. "● online".
 *
 * @param props - Status to show.
 * @returns The rendered badge.
 */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  const meta = metaFor(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[11px] lowercase",
        meta.color,
        className,
      )}
    >
      <StatusDot status={status} label={null} />
      <span>{meta.label}</span>
    </span>
  );
}
