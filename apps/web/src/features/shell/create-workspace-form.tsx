import { Button } from "@openrail/ui";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { FormField } from "../../components/form-field";
import { errorMessage } from "../../lib/api/client";
import { useCreateWorkspace } from "../../queries/me";

/**
 * Form that creates a workspace and opens it.
 *
 * @param props - Optional callback after the workspace is created.
 * @returns The form.
 */
export function CreateWorkspaceForm({ onCreated }: { onCreated?: () => void }) {
  const navigate = useNavigate();
  const create = useCreateWorkspace();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Enter a workspace name.");
      return;
    }
    setError(null);
    try {
      const workspace = await create.mutateAsync(name.trim());
      onCreated?.();
      await navigate({ to: "/w/$workspaceId", params: { workspaceId: workspace.id } });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <FormField
        label="Workspace name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="Your team"
        error={error}
        autoFocus
      />
      <Button type="submit" variant="primary" loading={create.isPending}>
        Create workspace
      </Button>
    </form>
  );
}
