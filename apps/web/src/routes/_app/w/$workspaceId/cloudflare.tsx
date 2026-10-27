import { createFileRoute } from "@tanstack/react-router";
import { CloudflarePage } from "../../../../features/settings/cloudflare-page";

/** The instance's Cloudflare account, for services that run on Cloudflare Containers. */
export const Route = createFileRoute("/_app/w/$workspaceId/cloudflare")({
  staticData: { title: "Cloudflare" },
  component: CloudflareRoute,
});

function CloudflareRoute() {
  const { workspaceId } = Route.useParams();
  return <CloudflarePage workspaceId={workspaceId} />;
}
