/**
 * The MongoDB 8.0+ kernel incompatibility in the dashboard (SERVER-121912): the
 * sentence that explains it for a server and for a service running on one, and the
 * warning badge a service's header shows while its data sits on such a server. The
 * scheduler keeps new placements off these kernels; this covers the ones placed
 * before the server's kernel changed.
 *
 * @module
 */
import { isKernelSensitiveDatabase, isMongoRseqAffectedKernel } from "@roundhouse/shared";
import { Badge, Tooltip } from "@roundhouse/ui";
import { TriangleAlertIcon } from "lucide-react";
import { useId } from "react";
import type { Service } from "../../lib/api/deploy-types";
import type { Node } from "../../lib/api/types";
import { useVolume } from "../../queries/databases";
import { useNodes } from "../../queries/nodes";

/**
 * Why a server can't run MongoDB 8.0 and later, for its detail page.
 *
 * @param kernel - The server's kernel release.
 * @returns The explanation, or `null` when the kernel is fine or unknown.
 * @example
 * describeServerKernel("7.0.0-14-generic");
 * // "Linux kernel 7.0.0-14-generic is in 6.19 to 7.0.13, where MongoDB 8.0 and later exit at startup. …"
 */
export function describeServerKernel(kernel: string | null): string | null {
  if (!kernel || !isMongoRseqAffectedKernel(kernel)) return null;
  return (
    `Linux kernel ${kernel} is in 6.19 to 7.0.13, where MongoDB 8.0 and later exit at startup. ` +
    "New MongoDB 8.0+ services go to other servers; upgrade this one's kernel to 7.0.14 or later to run them here."
  );
}

/**
 * Why a service can't start on the server holding its data.
 *
 * @param service - The service.
 * @param node - The server holding its volume, when known.
 * @returns The explanation, or `null` when the service isn't affected.
 * @example
 * describeServiceKernel(
 *   { database: { engine: "mongodb", version: "8.0" } },
 *   { name: "hel-1", kernel: "7.0.0-14-generic" },
 * );
 * // "hel-1 runs Linux kernel 7.0.0-14-generic, where MongoDB 8.0 and later exit at startup. …"
 */
export function describeServiceKernel(
  service: Pick<Service, "database">,
  node: Pick<Node, "name" | "kernel"> | undefined,
): string | null {
  if (!isKernelSensitiveDatabase(service.database?.engine, service.database?.version)) return null;
  if (!node?.kernel || !isMongoRseqAffectedKernel(node.kernel)) return null;
  return (
    `${node.name} runs Linux kernel ${node.kernel}, where MongoDB 8.0 and later exit at startup ` +
    "(6.19 to 7.0.13). Upgrade the server's kernel to 7.0.14 or later, or move the volume to another server."
  );
}

/** Props for {@link KernelWarningBadge}. */
export interface KernelWarningBadgeProps {
  workspaceId: string;
  service: Pick<Service, "id" | "database">;
  environmentId: string | undefined;
}

/**
 * A warning badge reading "Kernel" while a MongoDB 8.0+ service's data sits on a server
 * whose kernel it can't start on, with the reason as its tooltip and as a visually hidden
 * description. Renders nothing otherwise; other services don't fetch the volume or servers.
 *
 * NOTE: The tooltip bubble is hidden from assistive technology because the hidden
 * description already carries the reason; Radix would otherwise announce it twice.
 *
 * @param props - Workspace, the service and the selected environment.
 * @returns The badge, or `null`.
 */
export function KernelWarningBadge(props: KernelWarningBadgeProps) {
  const { database } = props.service;
  if (!isKernelSensitiveDatabase(database?.engine, database?.version)) return null;
  return <HeldDataKernelBadge {...props} />;
}

function HeldDataKernelBadge({ workspaceId, service, environmentId }: KernelWarningBadgeProps) {
  const id = useId();
  const volume = useVolume(service.id, environmentId);
  const nodes = useNodes(workspaceId, false);
  const nodeId = volume.data?.node_id;
  const holder = nodeId ? nodes.data?.find((node) => node.id === nodeId) : undefined;
  const reason = describeServiceKernel(service, holder);
  if (!reason) return null;
  return (
    <>
      <Tooltip content={<span aria-hidden="true">{reason}</span>} className="max-w-72">
        <Badge
          tone="warning"
          tabIndex={0}
          aria-describedby={id}
          className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <TriangleAlertIcon className="size-3" aria-hidden="true" />
          Kernel
        </Badge>
      </Tooltip>
      <span id={id} className="sr-only">
        {reason}
      </span>
    </>
  );
}
