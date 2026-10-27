import {
  MEMBER_DEFAULT_PROJECT_ROLES,
  type MemberDefaultProjectRole,
  VIEWER_DEFAULT_PROJECT_ROLES,
  type ViewerDefaultProjectRole,
} from "@roundhouse/shared";
import { SaveBar, Select, SettingsRow, SettingsSection, Skeleton, toast } from "@roundhouse/ui";
import { type FormEvent, useId, useState } from "react";
import { ErrorState } from "../../components/error-state";
import type { WorkspaceAccessSettings } from "../../lib/api/access-types";
import { errorMessage } from "../../lib/api/client";
import { usePermissions } from "../../lib/permissions";
import { useAccessSettings, useUpdateAccessSettings } from "../../queries/access";
import { defaultRoleLabel } from "./roles";

function DefaultAccessForm({
  workspaceId,
  settings,
  canManage,
}: {
  workspaceId: string;
  settings: WorkspaceAccessSettings;
  canManage: boolean;
}) {
  const update = useUpdateAccessSettings(workspaceId);
  const [member, setMember] = useState<MemberDefaultProjectRole | null>(null);
  const [viewer, setViewer] = useState<ViewerDefaultProjectRole | null>(null);
  const [error, setError] = useState<string | null>(null);
  const memberId = useId();
  const viewerId = useId();
  const nextMember = member ?? settings.member_default_project_role;
  const nextViewer = viewer ?? settings.viewer_default_project_role;
  const dirty =
    nextMember !== settings.member_default_project_role ||
    nextViewer !== settings.viewer_default_project_role;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    update.mutate(
      {
        ...(nextMember !== settings.member_default_project_role
          ? { member_default_project_role: nextMember }
          : {}),
        ...(nextViewer !== settings.viewer_default_project_role
          ? { viewer_default_project_role: nextViewer }
          : {}),
      },
      {
        onSuccess: () => {
          setMember(null);
          setViewer(null);
          toast({ title: "Default project access saved", tone: "success" });
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Default project access">
      <SettingsSection
        title="Default project access"
        description="The role people get on every project of this workspace before any grant. Owners and admins are always project admins; a grant can raise anyone further on one project."
      >
        <SettingsRow
          label="Workspace members"
          description="Developer matches what members could do before project roles existed."
          htmlFor={memberId}
        >
          <Select
            id={memberId}
            aria-describedby={`${memberId}-description`}
            value={nextMember}
            disabled={!canManage}
            onChange={(event) => setMember(event.target.value as MemberDefaultProjectRole)}
          >
            {MEMBER_DEFAULT_PROJECT_ROLES.map((role) => (
              <option key={role} value={role}>
                {defaultRoleLabel(role)}
              </option>
            ))}
          </Select>
        </SettingsRow>
        <SettingsRow
          label="Workspace viewers"
          description="Viewers can never be given more than viewer by default."
          htmlFor={viewerId}
        >
          <Select
            id={viewerId}
            aria-describedby={`${viewerId}-description`}
            value={nextViewer}
            disabled={!canManage}
            onChange={(event) => setViewer(event.target.value as ViewerDefaultProjectRole)}
          >
            {VIEWER_DEFAULT_PROJECT_ROLES.map((role) => (
              <option key={role} value={role}>
                {defaultRoleLabel(role)}
              </option>
            ))}
          </Select>
        </SettingsRow>
        {error ? (
          <p role="alert" className="py-3 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </SettingsSection>
      {canManage ? (
        <SaveBar
          dirty={dirty}
          saving={update.isPending}
          onDiscard={() => {
            setMember(null);
            setViewer(null);
            setError(null);
          }}
        />
      ) : null}
    </form>
  );
}

/**
 * The workspace's default project roles for members and viewers. Read by anyone who can
 * read members; changed by those who manage them (with a fresh session).
 *
 * @param props - Workspace id.
 * @returns The section, or nothing for roles that can't read members.
 */
export function DefaultAccessSection({ workspaceId }: { workspaceId: string }) {
  const { can } = usePermissions(workspaceId);
  const canRead = can("members:read");
  const settings = useAccessSettings(workspaceId, canRead);
  if (!canRead) return null;
  if (settings.isPending) return <Skeleton className="h-36" />;
  if (settings.isError) {
    return (
      <ErrorState message={errorMessage(settings.error)} onRetry={() => void settings.refetch()} />
    );
  }
  return (
    <DefaultAccessForm
      workspaceId={workspaceId}
      settings={settings.data}
      canManage={can("members:manage")}
    />
  );
}
