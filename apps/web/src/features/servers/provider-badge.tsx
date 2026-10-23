import { isProviderId, PROVIDERS, type ProviderInfo } from "@roundhouse/providers";
import { Badge } from "@roundhouse/ui";
import type { Node } from "../../lib/api/types";
import { formatTimestamp } from "../../lib/format";

/**
 * The provider that created a node, when Roundhouse provisioned it there. Hand-joined
 * machines (`provider: "server"`, or a provider the agent merely detected) have none.
 *
 * @param node - Node record.
 * @returns The provider's info, or `null`.
 */
export function managedProvider(
  node: Pick<Node, "provider" | "provider_server_id">,
): ProviderInfo | null {
  if (node.provider_server_id === null || !isProviderId(node.provider)) return null;
  return PROVIDERS[node.provider];
}

/**
 * Badges for a provider-managed node: the provider's name, and a warning once the
 * provider no longer has the server.
 *
 * @param props - The node.
 * @returns The badges, or nothing for hand-joined machines.
 */
export function ProviderBadges({
  node,
}: {
  node: Pick<Node, "provider" | "provider_server_id" | "provider_server_missing_at">;
}) {
  const provider = managedProvider(node);
  if (!provider) return null;
  return (
    <>
      <Badge tone="neutral">{provider.displayName}</Badge>
      {node.provider_server_missing_at !== null ? (
        <Badge
          tone="warning"
          title={`${provider.displayName} reported the server gone on ${formatTimestamp(node.provider_server_missing_at)}`}
        >
          Deleted at provider
        </Badge>
      ) : null}
    </>
  );
}
