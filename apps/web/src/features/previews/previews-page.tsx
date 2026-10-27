import { SettingsStack, Skeleton } from "@roundhouse/ui";
import { InfoIcon } from "lucide-react";
import { ErrorState } from "../../components/error-state";
import { errorMessage } from "../../lib/api/client";
import { useProjectPermissions } from "../../lib/permissions";
import { usePreviewSettings } from "../../queries/previews";
import { ProjectSettingsFrame } from "../projects/project-settings-frame";
import { useProjectEnvironment } from "../projects/use-project-environment";
import { PreviewSettingsForm } from "./preview-settings-form";
import { PreviewsList } from "./previews-list";

function PullRequestEventsNotice() {
  return (
    <div
      role="note"
      className="mb-8 flex items-start gap-2 rounded-lg border border-info/40 bg-info/10 px-4 py-3 text-sm text-foreground"
    >
      <InfoIcon className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
      <span>
        No pull request event has reached this instance yet. A GitHub App created before previews
        existed must subscribe to the <strong>Pull request</strong> event: on GitHub, open the App's
        settings, then <em>Permissions &amp; events</em>, and tick <em>Pull request</em> under{" "}
        <em>Subscribe to events</em>.
      </span>
    </div>
  );
}

/**
 * Project → Previews (ADR 0007): the project's pull request previews with their actions,
 * then the preview settings. GitHub commit statuses link here.
 *
 * @param props - Workspace and project ids.
 * @returns The page.
 */
export function PreviewsPage({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  const { project } = useProjectEnvironment(projectId);
  const access = useProjectPermissions(workspaceId, projectId);
  const settings = usePreviewSettings(projectId);
  if (!project.data) return null;
  return (
    <ProjectSettingsFrame
      workspaceId={workspaceId}
      projectId={projectId}
      title="Previews"
      description="An environment for every pull request, torn down when it closes."
    >
      {settings.data && !settings.data.pull_request_events_seen ? (
        <PullRequestEventsNotice />
      ) : null}
      <SettingsStack>
        <PreviewsList workspaceId={workspaceId} projectId={projectId} />
        {settings.isPending ? (
          <Skeleton className="h-64" />
        ) : settings.isError ? (
          <ErrorState
            message={errorMessage(settings.error)}
            onRetry={() => void settings.refetch()}
          />
        ) : (
          <PreviewSettingsForm
            projectId={projectId}
            settings={settings.data}
            environments={project.data.environments}
            canEdit={access.can("previews:manage")}
          />
        )}
      </SettingsStack>
    </ProjectSettingsFrame>
  );
}
