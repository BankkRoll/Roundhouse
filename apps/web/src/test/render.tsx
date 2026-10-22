import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { expect } from "vitest";
import { App } from "../app";
import { createAppContext } from "../bootstrap";
import { createQueryClient } from "../lib/query-client";
import type { AppRouter } from "../router";

/**
 * Renders the whole app (real route tree, guards, shell and session-expiry handling) at
 * a URL, against the MSW contract handlers.
 *
 * @param path - Initial URL, e.g. `/w/ws_acme/servers`.
 * @returns The router, query client and a user-event instance.
 */
export function renderApp(path: string) {
  const { queryClient, router } = createAppContext({
    retry: false,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  const user = userEvent.setup();
  const utils = render(<App queryClient={queryClient} router={router} />);
  return { ...utils, router, queryClient, user };
}

/**
 * Renders a single component inside a minimal router (so `<Link>` works) and a fresh
 * query client.
 *
 * @param element - Component under test.
 * @returns The query client and a user-event instance.
 */
export function renderWithProviders(element: ReactElement) {
  const queryClient: QueryClient = createQueryClient({ retry: false });
  const rootRoute = createRootRoute({ component: () => element });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const user = userEvent.setup();
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as unknown as AppRouter} />
    </QueryClientProvider>,
  );
  return { ...utils, queryClient, user, router };
}

/**
 * Waits until the router has settled on a pathname.
 *
 * @param router - Router returned by {@link renderApp}.
 * @param pathname - Expected pathname.
 */
export async function expectPath(router: AppRouter, pathname: string) {
  await waitFor(() => expect(router.state.location.pathname).toBe(pathname));
}

/**
 * Waits for the page's h1.
 *
 * @param name - Expected heading text.
 * @returns The heading element.
 */
export function findPageHeading(name: string | RegExp) {
  return screen.findByRole("heading", { level: 1, name });
}
