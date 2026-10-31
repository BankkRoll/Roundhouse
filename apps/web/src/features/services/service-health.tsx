/**
 * Service health in the dashboard (ADR 0005, "Node lifecycle"): the Degraded badge the
 * service header and the project canvas share, and the sentence that explains it.
 *
 * @module
 */
import { Badge, cn, Tooltip } from "@roundhouse/ui";
import { TriangleAlertIcon } from "lucide-react";
import { useId } from "react";
import type { Service } from "../../lib/api/deploy-types";

/** The fields of a service its health is read from. */
export type ServiceHealthFields = Pick<Service, "health" | "health_reason" | "health_node">;

/**
 * Why a service is degraded, in words, naming the server it waits on when known.
 *
 * @param service - The service.
 * @returns The explanation, or `null` for a healthy service.
 * @example
 * describeServiceHealth({ health: "degraded", health_reason: "node_offline",
 *   health_node: { id: "node_1", name: "hel-1" } });
 * // "Server hel-1 went offline. This service keeps its data there, so it can't move; …"
 */
export function describeServiceHealth(service: ServiceHealthFields): string | null {
  if (service.health !== "degraded") return null;
  const name = service.health_node?.name;
  if (service.health_reason === "node_maintenance") {
    return name
      ? `A forced drain of server ${name} stopped it. It starts again there when ${name} is resumed.`
      : "A forced drain of its server stopped it. It starts again when the server is resumed.";
  }
  return name
    ? `Server ${name} went offline. This service keeps its data there, so it can't move; it recovers when ${name} reconnects.`
    : "Its server went offline. This service keeps its data there, so it can't move; it recovers when the server reconnects.";
}

/** Props for {@link DegradedBadge}. */
export interface DegradedBadgeProps {
  service: ServiceHealthFields;
  /**
   * Set when the badge sits inside another control (a canvas node): the badge then isn't
   * focusable, and the control points its `aria-describedby` at this id, which the
   * visually hidden explanation carries.
   */
  descriptionId?: string;
  className?: string;
}

/**
 * A warning badge reading "Degraded", with the reason as its tooltip and as a visually
 * hidden description, so the state never rests on colour alone. Renders nothing for a
 * healthy service.
 *
 * NOTE: The tooltip bubble is hidden from assistive technology because the hidden
 * description already carries the reason; Radix would otherwise announce it twice.
 *
 * @param props - The service, and the description id when nested in a control.
 * @returns The badge, or `null`.
 */
export function DegradedBadge({ service, descriptionId, className }: DegradedBadgeProps) {
  const ownId = useId();
  const reason = describeServiceHealth(service);
  if (!reason) return null;
  const nested = descriptionId !== undefined;
  const id = descriptionId ?? ownId;
  return (
    <>
      <Tooltip content={<span aria-hidden="true">{reason}</span>} className="max-w-72">
        <Badge
          tone="warning"
          tabIndex={nested ? undefined : 0}
          aria-describedby={nested ? undefined : id}
          className={cn(
            !nested && "outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          <TriangleAlertIcon className="size-3" aria-hidden="true" />
          Degraded
        </Badge>
      </Tooltip>
      <span id={id} className="sr-only">
        {reason}
      </span>
    </>
  );
}
