import { Button, EmptyState } from "@roundhouse/ui";
import { TriangleAlertIcon } from "lucide-react";

/** Props for {@link ErrorState}. */
export interface ErrorStateProps {
  /** Headline. Defaults to "Something went wrong". */
  title?: string;
  /** Detail, usually the API error message. */
  message: string;
  /** Shows a retry button when provided. */
  onRetry?: () => void;
}

/**
 * Inline error panel for failed queries.
 *
 * @param props - Title, message and optional retry handler.
 * @returns The error panel.
 */
export function ErrorState({ title = "Something went wrong", message, onRetry }: ErrorStateProps) {
  return (
    <div role="alert">
      <EmptyState
        icon={<TriangleAlertIcon className="text-danger" />}
        title={title}
        description={message}
        action={
          onRetry ? (
            <Button variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
