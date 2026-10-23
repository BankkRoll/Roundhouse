import { cn } from "@openrail/ui";
import { AvatarStack } from "@openrail/ui/controls";
import type { RealtimeStatus } from "../../lib/realtime/client";
import { useRealtime } from "../../lib/realtime/provider";

const STATUS_COPY = {
  connecting: { label: "Connecting", dot: "bg-subtle-foreground animate-pulse-dot" },
  open: { label: "Live", dot: "bg-success" },
  reconnecting: { label: "Reconnecting", dot: "bg-warning animate-pulse-dot" },
  closed: { label: "Offline", dot: "bg-subtle-foreground" },
  expired: { label: "Signed out", dot: "bg-danger" },
  forbidden: { label: "No access", dot: "bg-subtle-foreground" },
  not_found: { label: "Unavailable", dot: "bg-subtle-foreground" },
} as const satisfies Record<RealtimeStatus, { label: string; dot: string }>;

/**
 * Who else is looking at this project, from the realtime socket's presence messages,
 * plus the socket's connection state.
 *
 * @param props - Optional extra classes.
 * @returns The avatars and a "Live" indicator, or nothing outside a project.
 */
export function ProjectPresence({ className }: { className?: string }) {
  const realtime = useRealtime();
  if (!realtime) return null;
  const copy = STATUS_COPY[realtime.status];
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <AvatarStack
        label="Viewing now"
        people={realtime.presence.map((user) => ({ id: user.user_id, name: user.name }))}
      />
      <span
        role="status"
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", copy.dot)} />
        {copy.label}
      </span>
    </div>
  );
}
