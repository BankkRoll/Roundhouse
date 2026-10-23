import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@roundhouse/ui";
import { AddServerFlow } from "./add-server-flow";

/** Props for {@link AddServerDialog}. */
export interface AddServerDialogProps {
  /** Workspace the new server joins. */
  workspaceId: string;
  /** Whether the dialog is open. */
  open: boolean;
  /** Called to open or close the dialog. */
  onOpenChange: (open: boolean) => void;
  /** Override the node polling interval (tests). */
  pollIntervalMs?: number;
}

/**
 * Dialog hosting {@link AddServerFlow}. Each opening mints a fresh token because the
 * flow unmounts when the dialog closes.
 *
 * @param props - Workspace and controlled open state.
 * @returns The dialog.
 */
export function AddServerDialog({
  workspaceId,
  open,
  onOpenChange,
  pollIntervalMs,
}: AddServerDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a server</DialogTitle>
          <DialogDescription>
            Any VPS or bare-metal machine works. You keep root; the agent only talks outbound.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <AddServerFlow
            workspaceId={workspaceId}
            pollIntervalMs={pollIntervalMs}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
