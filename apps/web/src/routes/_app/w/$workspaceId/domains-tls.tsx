import { createFileRoute } from "@tanstack/react-router";
import { DomainsTlsPage } from "../../../../features/settings/domains-tls-page";

/** Instance-wide TLS mode, ingress hostname, ACME CA, Cloudflare DNS and certificates. */
export const Route = createFileRoute("/_app/w/$workspaceId/domains-tls")({
  staticData: { title: "Domains & TLS" },
  component: DomainsTlsRoute,
});

function DomainsTlsRoute() {
  const { workspaceId } = Route.useParams();
  return <DomainsTlsPage workspaceId={workspaceId} />;
}
