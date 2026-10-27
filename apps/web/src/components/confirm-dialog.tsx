import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@roundhouse/ui";
import { type FormEvent, type ReactNode, useId, useState } from "react";

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
  /** Label of the confirm button. */
  confirmLabel: string;
  /** Runs when confirmed. The dialog stays open; close it on success. */
  onConfirm: () => void;
  /** Shows a spinner on the confirm button. */
  pending?: boolean;
  /** Error from the last attempt, shown inline. */
  error?: string | null;
  /**
   * Text the user must type before confirming (e.g. the project name), for actions that
   * can't be undone.
   */
  confirmText?: string;
  /** Paints the confirm button as destructive. Defaults to `true`. */
  destructive?: boolean;
  /** Keeps the confirm button disabled, e.g. until a required choice is made. */
  confirmDisabled?: boolean;
  /** Extra controls between the description and the buttons, e.g. an opt-out checkbox. */
  children?: ReactNode;
}

/**
 * Confirmation dialog for destructive or consequential actions, optionally requiring the
 * user to type a name first.
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
  confirmText,
  destructive = true,
  confirmDisabled = false,
  children,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const matches = confirmText === undefined || typed === confirmText;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (matches && !confirmDisabled) onConfirm();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setTyped("");
      }}
    >
      <DialogContent className="max-w-md">
        <form onSubmit={onSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {children}
          {confirmText !== undefined ? (
            <div className="grid gap-1.5">
              <Label htmlFor={inputId}>
                Type <span className="font-mono text-foreground">{confirmText}</span> to confirm
              </Label>
              <Input
                id={inputId}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button
              type="submit"
              variant={destructive ? "danger" : "primary"}
              loading={pending}
              disabled={!matches || confirmDisabled}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
