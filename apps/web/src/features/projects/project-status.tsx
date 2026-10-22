import { StatusDot } from "@openrail/ui";
import type { ProjectHealth } from "../../queries/projects";

/** Label and drawing of each project health, reusing the node/deployment glyphs. */
export const PROJECT_HEALTH: Record<
  ProjectHealth,
  { label: string; status: string; kind: "node" | "deployment" }
> = {
  healthy: { label: "All services live", status: "active", kind: "deployment" },
  deploying: { label: "Deploying", status: "deploying", kind: "deployment" },
  failing: { label: "A service is failing", status: "failed", kind: "deployment" },
  idle: { label: "Nothing deployed", status: "idle", kind: "deployment" },
  unknown: { label: "Loading status", status: "pending", kind: "node" },
};

/**
 * Status dot summarising a project's services.
 *
 * @param props - The project's health and an optional visible-label override.
 * @returns The dot, labelled for assistive tech.
 */
export function ProjectStatusDot({
  health,
  className,
}: {
  health: ProjectHealth;
  className?: string;
}) {
  const meta = PROJECT_HEALTH[health];
  return (
    <StatusDot status={meta.status} kind={meta.kind} label={meta.label} className={className} />
  );
}
