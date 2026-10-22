import type { QueryClient } from "@tanstack/react-query";
import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { NotFound } from "./components/not-found";
import { RouteError } from "./components/route-error";
import { routeTree } from "./routeTree.gen";

/** Values every route can read from `context` in `beforeLoad` / loaders. */
export interface RouterContext {
  /** The app's query client, for guards that read or prefetch API data. */
  queryClient: QueryClient;
}

/**
 * Creates the app router.
 *
 * @param queryClient - Shared QueryClient, exposed to routes through context.
 * @param history - Optional history (memory history in tests).
 * @returns The configured router.
 */
export function createAppRouter(queryClient: QueryClient, history?: RouterHistory) {
  return createRouter({
    routeTree,
    history,
    context: { queryClient },
    defaultPreload: "intent",
    defaultNotFoundComponent: NotFound,
    defaultErrorComponent: RouteError,
    scrollRestoration: true,
  });
}

/** The app router type. */
export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
  interface StaticDataRouteOption {
    /** Page name for the top bar breadcrumb and the browser tab title. */
    title?: string;
  }
}
