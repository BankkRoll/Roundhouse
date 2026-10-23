import { createFileRoute } from "@tanstack/react-router";
import { GithubCallbackPage } from "../../../features/settings/github-callback-page";

/** What the API's GitHub setup callback reports back. */
export interface GithubSetupSearch {
  /** `installed`, or `requested` when an organization owner must approve the install. */
  status?: string;
  /**
   * `exchange_failed`, `installation_not_found`, `installation_claimed`, or why an
   * installation was refused: `authorization_required`, `authorization_failed`,
   * `installation_not_accessible` or `link_used`.
   */
  error?: string;
}

/**
 * Where the API sends the browser after GitHub's App creation and installation flow
 * (`GITHUB_SETTINGS_PATH` in the API's GitHub routes).
 */
export const Route = createFileRoute("/_app/settings/github")({
  staticData: { title: "GitHub" },
  validateSearch: (search: Record<string, unknown>): GithubSetupSearch => ({
    status: typeof search.status === "string" ? search.status : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: GithubSetupRoute,
});

function GithubSetupRoute() {
  const search = Route.useSearch();
  return <GithubCallbackPage status={search.status} error={search.error} />;
}
