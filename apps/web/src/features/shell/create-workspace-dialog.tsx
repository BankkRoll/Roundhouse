import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@roundhouse/ui";
import { CreateWorkspaceForm } from "./create-workspace-form";

/**
 * Dialog wrapper around {@link CreateWorkspaceForm}.
 *
 * @param props - Controlled open state.
 * @returns The dialog.
 */
export function CreateWorkspaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>New workspace</DialogTitle>
          <DialogDescription>
            Workspaces keep servers, projects and members separate.
          </DialogDescription>
        </DialogHeader>
        <CreateWorkspaceForm onCreated={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
