import type { RouterHistory } from "@tanstack/react-router";
import { createQueryClient } from "./lib/query-client";
import { createAppRouter } from "./router";

/** Options for {@link createAppContext}. */
export interface AppContextOptions {
  /** Router history; defaults to browser history. Tests pass memory history. */
  history?: RouterHistory;
  /** Disable query retries (tests). */
  retry?: boolean;
}

/**
 * Creates the query client and router, wired so that any 401 from the API (an expired or
 * revoked session) clears cached data and sends the user to sign in, returning them to
 * where they were afterwards.
 *
 * @param options - History and retry overrides.
 * @returns The query client and router to hand to `<App>`.
 */
export function createAppContext(options: AppContextOptions = {}) {
  const queryClient = createQueryClient({
    retry: options.retry,
    onUnauthorized: () => {
      const { pathname, href } = router.state.location;
      if (pathname.startsWith("/login") || pathname.startsWith("/invite")) return;
      if (pathname.startsWith("/setup")) return;
      queryClient.clear();
      void router.navigate({ to: "/login", search: { redirect: href } });
    },
  });
  const router = createAppRouter(queryClient, options.history);
  return { queryClient, router };
}
