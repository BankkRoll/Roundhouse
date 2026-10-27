import {
  Avatar,
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Textarea,
  toast,
} from "@roundhouse/ui";
import { type FormEvent, useId, useState } from "react";
import { FormField } from "../../components/form-field";
import type { TeamDetail } from "../../lib/api/access-types";
import { errorMessage, isApiError } from "../../lib/api/client";
import type { Member } from "../../lib/api/types";
import { useCreateTeam } from "../../queries/access";
import { roleLabel } from "./role-select";

/** Props for {@link CreateTeamDialog}. */
export interface CreateTeamDialogProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Workspace members who can be added right away. */
  members: readonly Member[];
  /** Runs after the team exists. */
  onCreated?: (team: TeamDetail) => void;
}

/**
 * Creates a team with a name, an optional description and its first members.
 *
 * @param props - Workspace, open state, members to pick from and a callback.
 * @returns The dialog.
 */
export function CreateTeamDialog({
  workspaceId,
  open,
  onOpenChange,
  members,
  onCreated,
}: CreateTeamDialogProps) {
  const create = useCreateTeam(workspaceId);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const descriptionId = useId();
  const membersId = useId();

  function reset() {
    setName("");
    setDescription("");
    setPicked(new Set());
    setError(null);
    create.reset();
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Enter a team name.");
      return;
    }
    setError(null);
    create.mutate(
      {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        user_ids: [...picked],
      },
      {
        onSuccess: (team) => {
          toast({ title: `${team.name} created`, tone: "success" });
          onOpenChange(false);
          reset();
          onCreated?.(team);
        },
        onError: (cause) =>
          setError(
            isApiError(cause, 409)
              ? "A team with this name already exists. Pick another name."
              : errorMessage(cause),
          ),
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="max-w-lg">
        <form onSubmit={onSubmit} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New team</DialogTitle>
            <DialogDescription>
              Teams group members so projects and protection rules can name them once.
            </DialogDescription>
          </DialogHeader>
          <FormField
            label="Name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Platform"
            maxLength={100}
            error={error}
            autoFocus
          />
          <div className="grid gap-1.5">
            <label htmlFor={descriptionId} className="text-sm font-medium text-foreground">
              Description <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <Textarea
              id={descriptionId}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={500}
              className="min-h-16 font-sans text-sm"
            />
          </div>
          <fieldset className="grid gap-1.5" aria-describedby={`${membersId}-hint`}>
            <legend className="text-sm font-medium text-foreground">Members</legend>
            <p id={`${membersId}-hint`} className="text-xs text-subtle-foreground">
              Optional. You can add people later.
            </p>
            <ul className="max-h-56 divide-y divide-border/70 overflow-y-auto rounded-md border border-border">
              {members.map((member) => {
                const label = member.name || member.email;
                return (
                  <li key={member.user_id}>
                    <label
                      htmlFor={`${membersId}-${member.user_id}`}
                      className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50"
                    >
                      <Checkbox
                        id={`${membersId}-${member.user_id}`}
                        checked={picked.has(member.user_id)}
                        onChange={(event) =>
                          setPicked((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(member.user_id);
                            else next.delete(member.user_id);
                            return next;
                          })
                        }
                      />
                      <Avatar name={label} seed={member.user_id} size={24} />
                      <span className="min-w-0 flex-1 truncate text-foreground">{label}</span>
                      <span className="text-xs text-muted-foreground">
                        {roleLabel(member.role)}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" loading={create.isPending}>
              Create team
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
