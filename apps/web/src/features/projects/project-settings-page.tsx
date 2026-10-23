import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  CodeBlock,
  Label,
  Textarea,
  toast,
} from "@roundhouse/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { FormField } from "../../components/form-field";
import { PageHeader } from "../../components/page-header";
import { errorMessage } from "../../lib/api/client";
import type { ProjectDetail } from "../../lib/api/deploy-types";
import { usePermissions } from "../../lib/permissions";
import { forgetProject, useDeleteProject, useUpdateProject } from "../../queries/projects";
import { useProjectEnvironment } from "./use-project-environment";

function GeneralForm({ workspaceId, project }: { workspaceId: string; project: ProjectDetail }) {
  const update = useUpdateProject(workspaceId, project.id);
  const { can } = usePermissions(workspaceId);
  const allowed = can("projects:manage");
  const [name, setName] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const descriptionId = useId();
  const currentName = name ?? project.name;
  const currentDescription = description ?? project.description ?? "";
  const dirty =
    (name !== null && name.trim() !== project.name) ||
    (description !== null && description.trim() !== (project.description ?? ""));

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!currentName.trim()) {
      setError("Enter a project name.");
      return;
    }
    setError(null);
    update.mutate(
      {
        name: name === null ? undefined : name.trim(),
        description: description === null ? undefined : description.trim() || null,
      },
      {
        onSuccess: () => {
          setName(null);
          setDescription(null);
          toast({ title: "Project saved", tone: "success" });
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  }

  return (
    <Card>
      <form onSubmit={onSubmit} noValidate>
        <CardHeader>
          <div>
            <CardTitle>General</CardTitle>
            <CardDescription>Shown in the sidebar and on the home page.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid max-w-lg gap-4">
          <FormField
            label="Project name"
            value={currentName}
            onChange={(event) => setName(event.target.value)}
            disabled={!allowed}
            error={error}
            maxLength={100}
          />
          <div className="grid gap-1.5">
            <Label htmlFor={descriptionId}>Description</Label>
            <Textarea
              id={descriptionId}
              value={currentDescription}
              onChange={(event) => setDescription(event.target.value)}
              disabled={!allowed}
              maxLength={500}
              className="min-h-16 font-sans text-sm"
            />
          </div>
        </CardContent>
        {allowed ? (
          <CardFooter className="justify-end">
            <Button type="submit" variant="primary" disabled={!dirty} loading={update.isPending}>
              Save
            </Button>
          </CardFooter>
        ) : null}
      </form>
    </Card>
  );
}

function DangerZone({ workspaceId, project }: { workspaceId: string; project: ProjectDetail }) {
  const remove = useDeleteProject(workspaceId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  return (
    <Card className="border-danger/40">
      <CardHeader>
        <div>
          <CardTitle>Delete project</CardTitle>
          <CardDescription>
            Removes {project.services.length}{" "}
            {project.services.length === 1 ? "service" : "services"} and stops their containers on
            every server. The slug becomes free immediately.
          </CardDescription>
        </div>
      </CardHeader>
      <CardFooter className="justify-end">
        <Button variant="danger" onClick={() => setConfirming(true)}>
          Delete project
        </Button>
      </CardFooter>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) remove.reset();
        }}
        title={`Delete ${project.name}?`}
        description="Every service in this project stops and its deployments, variables and domains are removed. This can't be undone."
        confirmLabel="Delete project"
        confirmText={project.name}
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() =>
          remove.mutate(project.id, {
            onSuccess: async () => {
              setConfirming(false);
              toast({ title: `${project.name} deleted`, tone: "success" });
              // NOTE: Leave first, so the mounted project pages don't refetch into a 404.
              await navigate({ to: "/w/$workspaceId", params: { workspaceId } });
              forgetProject(queryClient, project.id);
            },
          })
        }
      />
    </Card>
  );
}

/**
 * Project settings: name and description, the project id, and deletion with a typed
 * confirmation.
 *
 * @param props - Workspace and project ids.
 * @returns The page.
 */
export function ProjectSettingsPage({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  const { project } = useProjectEnvironment(projectId);
  const { can } = usePermissions(workspaceId);
  if (!project.data) return null;
  return (
    <>
      <PageHeader title="Project settings" subline={`/${project.data.slug}`} />
      <div className="grid max-w-3xl gap-4">
        <GeneralForm workspaceId={workspaceId} project={project.data} />
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Project ID</CardTitle>
              <CardDescription>Use this when talking to the API.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <CodeBlock code={project.data.id} />
          </CardContent>
        </Card>
        {can("projects:manage") ? (
          <DangerZone workspaceId={workspaceId} project={project.data} />
        ) : null}
      </div>
    </>
  );
}
