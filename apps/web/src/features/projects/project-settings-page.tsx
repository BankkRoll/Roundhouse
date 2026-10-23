import {
  Button,
  CodeBlock,
  DangerZone,
  SaveBar,
  SettingsRow,
  SettingsSection,
  SettingsStack,
  Textarea,
  toast,
} from "@roundhouse/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { SettingsField } from "../../components/settings-field";
import { errorMessage } from "../../lib/api/client";
import type { ProjectDetail } from "../../lib/api/deploy-types";
import { usePermissions } from "../../lib/permissions";
import { forgetProject, useDeleteProject, useUpdateProject } from "../../queries/projects";
import { ProjectSettingsFrame } from "./project-settings-frame";
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
    <form onSubmit={onSubmit} noValidate aria-label="General">
      <SettingsSection title="General" description="Shown in the sidebar and on the home page.">
        <SettingsField
          label="Project name"
          value={currentName}
          onChange={(event) => setName(event.target.value)}
          disabled={!allowed}
          error={error}
          maxLength={100}
        />
        <SettingsRow
          label="Description"
          description="One line on what the project runs. Optional."
          htmlFor={descriptionId}
        >
          <Textarea
            id={descriptionId}
            aria-describedby={`${descriptionId}-description`}
            value={currentDescription}
            onChange={(event) => setDescription(event.target.value)}
            disabled={!allowed}
            maxLength={500}
            className="min-h-20 font-sans text-sm"
          />
        </SettingsRow>
      </SettingsSection>
      {allowed ? (
        <SaveBar
          dirty={dirty}
          saving={update.isPending}
          onDiscard={() => {
            setName(null);
            setDescription(null);
            setError(null);
          }}
        />
      ) : null}
    </form>
  );
}

function DeleteProjectSection({
  workspaceId,
  project,
}: {
  workspaceId: string;
  project: ProjectDetail;
}) {
  const remove = useDeleteProject(workspaceId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const count = project.services.length;
  return (
    <DangerZone>
      <SettingsRow
        label="Delete project"
        description={`Removes ${count} ${count === 1 ? "service" : "services"} and stops their containers on every server. The slug becomes free immediately.`}
      >
        <div className="md:flex md:justify-end">
          <Button variant="danger-outline" onClick={() => setConfirming(true)}>
            Delete project
          </Button>
        </div>
      </SettingsRow>
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
    </DangerZone>
  );
}

/**
 * Project settings, General view: name and description, the project's identifiers, and
 * deletion with a typed confirmation.
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
    <ProjectSettingsFrame
      workspaceId={workspaceId}
      projectId={projectId}
      title="Project settings"
      description={`Applies to every environment of ${project.data.name}.`}
    >
      <SettingsStack>
        <GeneralForm workspaceId={workspaceId} project={project.data} />
        <SettingsSection title="Identifiers" description="Use these when talking to the API.">
          <SettingsRow label="Project ID">
            <CodeBlock dense code={project.data.id} />
          </SettingsRow>
          <SettingsRow label="Slug" description="Stays the same when the project is renamed.">
            <CodeBlock dense code={`/${project.data.slug}`} />
          </SettingsRow>
        </SettingsSection>
        {can("projects:manage") ? (
          <DeleteProjectSection workspaceId={workspaceId} project={project.data} />
        ) : null}
      </SettingsStack>
    </ProjectSettingsFrame>
  );
}
