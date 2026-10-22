import type { ErrorComponentProps } from "@tanstack/react-router";
import { errorMessage } from "../lib/api/client";
import { ErrorState } from "./error-state";

/**
 * Router-level error boundary content.
 *
 * @param props - The thrown error and a reset callback from the router.
 * @returns An error panel with a retry button.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <ErrorState message={errorMessage(error)} onRetry={reset} />
    </div>
  );
}
