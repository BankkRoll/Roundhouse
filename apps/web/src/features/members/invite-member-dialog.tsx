import { ROLES, type Role } from "@openrail/shared";
import {
  Button,
  CodeBlock,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
} from "@openrail/ui";
import { type FormEvent, useId, useState } from "react";
import { FormField } from "../../components/form-field";
import { errorMessage } from "../../lib/api/client";
import { assignableRoles, usePermissions } from "../../lib/permissions";
import { isValidEmail } from "../../lib/validation";
import { useCreateInvite } from "../../queries/members";
import { RoleSelect } from "./role-select";

/** Props for {@link InviteMemberDialog}. */
export interface InviteMemberDialogProps {
  /** Workspace to invite into. */
  workspaceId: string;
  /** Whether the dialog is open. */
  open: boolean;
  /** Called to open or close the dialog. */
  onOpenChange: (open: boolean) => void;
}

function InviteForm({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const { role } = usePermissions(workspaceId);
  const allowed = assignableRoles(role, ROLES);
  const create = useCreateInvite(workspaceId);
  const roleId = useId();
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!isValidEmail(email)) {
      setError("Enter a valid email address.");
      return;
    }
    setError(null);
    create.mutate({ email: email.trim(), role: inviteRole });
  }

  if (create.data) {
    return (
      <div className="grid gap-4">
        <p className="text-sm text-muted-foreground">
          Email delivery is not set up yet, so share this link with{" "}
          <span className="font-mono text-foreground">{create.data.invite.email}</span> yourself. It
          works once.
        </p>
        <CodeBlock code={create.data.url} label="Invite link" />
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => {
              create.reset();
              setEmail("");
            }}
          >
            Invite another
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <FormField
        label="Email"
        type="email"
        autoComplete="off"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="teammate@example.com"
        error={error}
        autoFocus
      />
      <div className="grid gap-1.5">
        <Label htmlFor={roleId}>Role</Label>
        <RoleSelect
          id={roleId}
          value={inviteRole}
          onValueChange={setInviteRole}
          allowed={allowed}
          className="w-full"
        />
      </div>
      {create.isError ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(create.error)}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={create.isPending}>
          Create invite
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * Dialog that creates an invite and shows the link to share.
 *
 * @param props - Workspace and controlled open state.
 * @returns The dialog.
 */
export function InviteMemberDialog({ workspaceId, open, onOpenChange }: InviteMemberDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Invite a member</DialogTitle>
          <DialogDescription>
            They get access to this workspace with the role you pick.
          </DialogDescription>
        </DialogHeader>
        {open ? <InviteForm workspaceId={workspaceId} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}
