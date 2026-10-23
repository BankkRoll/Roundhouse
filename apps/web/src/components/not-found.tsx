import { Button, EmptyState } from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import { CompassIcon } from "lucide-react";

/**
 * Fallback for unknown routes.
 *
 * @returns A not-found message with a way home.
 */
export function NotFound() {
  return (
    <div className="mx-auto max-w-lg px-4 py-16">
      <EmptyState
        icon={<CompassIcon />}
        title="Page not found"
        description="The page you were looking for does not exist or you no longer have access."
        action={
          <Button asChild variant="secondary">
            <Link to="/dashboard">Go to dashboard</Link>
          </Button>
        }
      />
    </div>
  );
}
