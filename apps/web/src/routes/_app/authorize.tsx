import { createFileRoute } from "@tanstack/react-router";
import { ConsentPage } from "../../features/oauth/consent-page";
import { decodeForwardedRequest } from "../../features/oauth/forwarded-request";

interface AuthorizeSearch {
  request?: string;
}

/**
 * MCP client consent screen. `/oauth/authorize` validates the client's request and
 * forwards it here as one `request` value; signing in first returns here with it intact.
 */
export const Route = createFileRoute("/_app/authorize")({
  staticData: { title: "Connect an app" },
  validateSearch: (search: Record<string, unknown>): AuthorizeSearch => ({
    request: typeof search.request === "string" ? search.request : undefined,
  }),
  component: AuthorizeRoute,
});

function AuthorizeRoute() {
  const { request } = Route.useSearch();
  return <ConsentPage params={decodeForwardedRequest(request)} />;
}
