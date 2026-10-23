import { freeSlug, slugify } from "@roundhouse/shared";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Textarea,
  toast,
} from "@roundhouse/ui";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { FormField } from "../../components/form-field";
import { errorMessage } from "../../lib/api/client";
import { useCreateProject, useProjects } from "../../queries/projects";

/** Longest project description the API accepts. */
const MAX_DESCRIPTION = 500;

/** Props for {@link NewProjectDialog}. */
export interface NewProjectDialogProps {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Creates a project (with its `production` environment) and opens it.
 *
 * @param props - Workspace and controlled open state.
 * @returns The dialog.
 */
export function NewProjectDialog({ workspaceId, open, onOpenChange }: NewProjectDialogProps) {
  const navigate = useNavigate();
  const create = useCreateProject(workspaceId);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const descriptionId = useId();
  const projects = useProjects(workspaceId, open);
  const base = slugify(name, 40, "");
  // NOTE: The API suffixes a taken slug the same way, so this predicts what it will pick.
  const slug = base ? freeSlug(new Set(projects.data?.map((project) => project.slug)), base) : "";

  function reset() {
    setName("");
    setDescription("");
    setError(null);
    create.reset();
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a project name.");
      return;
    }
    setError(null);
    try {
      const project = await create.mutateAsync({
        name: trimmed,
        description: description.trim() || undefined,
      });
      onOpenChange(false);
      reset();
      toast({ title: `Created ${project.name}`, tone: "success" });
      await navigate({
        to: "/w/$workspaceId/p/$projectId",
        params: { workspaceId, projectId: project.id },
      });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A project groups services that deploy together. It starts with a production environment.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <FormField
            label="Project name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            placeholder="storefront"
            maxLength={100}
            error={error}
            hint={slug ? `Slug: ${slug}${slug === base ? "" : ` (${base} is taken)`}` : undefined}
            autoFocus
          />
          <div className="grid gap-1.5">
            <Label htmlFor={descriptionId}>
              Description <span className="text-subtle-foreground">(optional)</span>
            </Label>
            <Textarea
              id={descriptionId}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={MAX_DESCRIPTION}
              className="min-h-16 font-sans text-sm"
              placeholder="What runs here"
            />
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={create.isPending}>
              Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
