import type { QueryClient } from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";

/** Paths that handle signed-out visitors themselves. */
const PUBLIC_PREFIXES = ["/login", "/invite", "/setup"];

/**
 * Handles a session that ended mid-use (a 401 from the API, or a realtime socket the
 * API refused): drops every cached query, so nothing from the old session leaks into the
 * next, and sends the user to sign in, returning them here afterwards.
 *
 * @param queryClient - Shared query client.
 * @param router - The app router.
 */
export function endSession(queryClient: QueryClient, router: AnyRouter): void {
  const { pathname, href } = router.state.location;
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return;
  queryClient.clear();
  void router.navigate({ to: "/login", search: { redirect: href } });
}
