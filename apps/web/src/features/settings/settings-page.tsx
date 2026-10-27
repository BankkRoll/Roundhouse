import {
  Button,
  CodeBlock,
  DangerZone,
  SaveBar,
  SettingsRow,
  SettingsSection,
  SettingsStack,
  Skeleton,
  toast,
} from "@roundhouse/ui";
import { Switch } from "@roundhouse/ui/controls";
import { type FormEvent, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorState } from "../../components/error-state";
import { SettingsField } from "../../components/settings-field";
import { errorMessage } from "../../lib/api/client";
import { usePermissions } from "../../lib/permissions";
import { useMe } from "../../queries/me";
import { useLeaveWorkspace } from "../../queries/members";
import {
  useRenameWorkspace,
  useStagedChangesSetting,
  useWorkspace,
} from "../../queries/workspaces";
import { SettingsFrame } from "./settings-frame";

function RenameForm({ workspaceId, currentName }: { workspaceId: string; currentName: string }) {
  const { can } = usePermissions(workspaceId);
  const allowed = can("workspace:update");
  const rename = useRenameWorkspace(workspaceId);
  // NOTE: `null` until the user types, so the field follows the saved name (a rename from
  // another tab, say) without overwriting an edit in progress.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const name = draft ?? currentName;
  const trimmed = name.trim();
  const dirty = draft !== null && trimmed !== currentName;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!trimmed) {
      setError("Enter a workspace name.");
      return;
    }
    setError(null);
    rename.mutate(trimmed, {
      onSuccess: () => {
        setDraft(null);
        toast({ title: "Workspace renamed", tone: "success" });
      },
      onError: (cause) => setError(errorMessage(cause)),
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Workspace">
      <SettingsSection title="Workspace" description="How this workspace appears to its members.">
        <SettingsField
          label="Name"
          description="Shown in the sidebar and to everyone you invite."
          value={name}
          onChange={(event) => setDraft(event.target.value)}
          disabled={!allowed}
          error={error}
          hint={allowed ? undefined : "Only owners and admins can rename the workspace."}
        />
      </SettingsSection>
      {allowed ? (
        <SaveBar
          dirty={dirty}
          saving={rename.isPending}
          onDiscard={() => {
            setDraft(null);
            setError(null);
          }}
        />
      ) : null}
    </form>
  );
}

function StagingSection({ workspaceId, on }: { workspaceId: string; on: boolean }) {
  const { can } = usePermissions(workspaceId);
  const allowed = can("workspace:update");
  const setting = useStagedChangesSetting(workspaceId);
  return (
    <SettingsSection
      title="Changes"
      description="How edits made on a project's canvas reach what runs."
    >
      <SettingsRow
        label="Stage canvas edits"
        description="Edits on the canvas collect in a shared draft that someone reviews and applies as one. Off, each edit applies as it is saved. Protected environments that require approval still need one either way."
      >
        <div className="flex items-center gap-2 md:justify-end">
          <Switch
            id="staged-changes"
            aria-label="Stage canvas edits"
            checked={on}
            disabled={!allowed || setting.isPending}
            onCheckedChange={(next) =>
              setting.mutate(next, {
                onSuccess: () =>
                  toast({
                    title: next
                      ? "Canvas edits now stage for review"
                      : "Canvas edits now apply as saved",
                    tone: "success",
                  }),
                onError: (cause) =>
                  toast({
                    title: "Could not change the setting",
                    description: errorMessage(cause),
                    tone: "error",
                  }),
              })
            }
          />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

function LeaveSection({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName: string;
}) {
  const { data: me } = useMe();
  const leave = useLeaveWorkspace(workspaceId);
  const [confirming, setConfirming] = useState(false);
  const memberId = me?.workspaces.find((w) => w.id === workspaceId)?.member_id;

  return (
    <DangerZone>
      <SettingsRow
        label="Leave workspace"
        description="You lose access straight away. Someone will have to invite you again to come back."
      >
        <div className="md:flex md:justify-end">
          <Button variant="danger-outline" disabled={!memberId} onClick={() => setConfirming(true)}>
            Leave workspace
          </Button>
        </div>
      </SettingsRow>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) leave.reset();
        }}
        title={`Leave ${workspaceName}?`}
        description="You lose access to its servers, members and audit log immediately."
        confirmLabel="Leave workspace"
        pending={leave.isPending}
        error={leave.isError ? errorMessage(leave.error) : null}
        onConfirm={() => {
          if (memberId) leave.mutate(memberId);
        }}
      />
    </DangerZone>
  );
}

/**
 * General workspace settings: name, identifiers, and leaving the workspace.
 *
 * @param props - Workspace id.
 * @returns The page.
 */
export function SettingsPage({ workspaceId }: { workspaceId: string }) {
  const workspace = useWorkspace(workspaceId);

  return (
    <SettingsFrame
      workspaceId={workspaceId}
      title="General"
      description={workspace.data ? `Settings for ${workspace.data.name}.` : undefined}
    >
      {workspace.isPending ? (
        <Skeleton className="h-40" />
      ) : workspace.isError ? (
        <ErrorState
          message={errorMessage(workspace.error)}
          onRetry={() => void workspace.refetch()}
        />
      ) : (
        <SettingsStack>
          <RenameForm workspaceId={workspaceId} currentName={workspace.data.name} />
          <StagingSection workspaceId={workspaceId} on={workspace.data.staged_changes ?? true} />
          <SettingsSection
            title="Identifiers"
            description="Use these when talking to the API or filing an issue."
          >
            <SettingsRow label="Workspace ID">
              <CodeBlock dense code={workspace.data.id} />
            </SettingsRow>
            <SettingsRow label="Slug" description="Part of the workspace's URLs.">
              <CodeBlock dense code={`/${workspace.data.slug}`} />
            </SettingsRow>
          </SettingsSection>
          <LeaveSection workspaceId={workspaceId} workspaceName={workspace.data.name} />
        </SettingsStack>
      )}
    </SettingsFrame>
  );
}
