import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@openrail/ui";
import type { ReactNode } from "react";

/** Props for {@link ConfirmDialog}. */
export interface ConfirmDialogProps {
  /** Whether the dialog is open. */
  open: boolean;
  /** Called to open or close the dialog, including from Cancel and Escape. */
  onOpenChange: (open: boolean) => void;
  /** Question in the title, e.g. "Remove hel-1?". */
  title: string;
  /** Consequences of confirming. */
  description: ReactNode;
  /** Label of the destructive button. */
  confirmLabel: string;
  /** Runs when confirmed. The dialog stays open; close it on success. */
  onConfirm: () => void;
  /** Shows a spinner on the confirm button. */
  pending?: boolean;
  /** Error from the last attempt, shown inline. */
  error?: string | null;
}

/**
 * Confirmation dialog for destructive actions.
 *
 * @param props - Copy, state and handlers.
 * @returns The dialog.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  pending = false,
  error,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button variant="danger" loading={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
