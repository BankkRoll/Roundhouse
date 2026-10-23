import { Toaster } from "@roundhouse/ui";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import type { AppRouter } from "./router";

/** Props for {@link App}. */
export interface AppProps {
  /** Query client shared with the router context. */
  queryClient: QueryClient;
  /** Router created by `createAppContext`. */
  router: AppRouter;
}

/**
 * Root providers: TanStack Query, the router, and the toast viewport.
 *
 * @param props - The query client and router to provide.
 * @returns The application.
 */
export function App({ queryClient, router }: AppProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
  );
}
