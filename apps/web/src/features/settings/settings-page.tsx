import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  CodeBlock,
  Skeleton,
  toast,
} from "@roundhouse/ui";
import { type FormEvent, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorState } from "../../components/error-state";
import { FormField } from "../../components/form-field";
import { PageHeader } from "../../components/page-header";
import { errorMessage } from "../../lib/api/client";
import { usePermissions } from "../../lib/permissions";
import { useMe } from "../../queries/me";
import { useLeaveWorkspace } from "../../queries/members";
import { useRenameWorkspace, useWorkspace } from "../../queries/workspaces";
import { SettingsTabs } from "./settings-tabs";

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
    <Card>
      <form onSubmit={onSubmit} noValidate>
        <CardHeader>
          <div>
            <CardTitle>Workspace name</CardTitle>
            <CardDescription>Shown in the sidebar and to everyone you invite.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <FormField
            label="Name"
            value={name}
            onChange={(event) => setDraft(event.target.value)}
            disabled={!allowed}
            error={error}
            hint={allowed ? undefined : "Only owners and admins can rename the workspace."}
            className="grid max-w-sm gap-1.5"
          />
        </CardContent>
        {allowed ? (
          <CardFooter className="justify-end">
            <Button type="submit" variant="primary" disabled={!dirty} loading={rename.isPending}>
              Save
            </Button>
          </CardFooter>
        ) : null}
      </form>
    </Card>
  );
}

function LeaveCard({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const { data: me } = useMe();
  const leave = useLeaveWorkspace(workspaceId);
  const [confirming, setConfirming] = useState(false);
  const memberId = me?.workspaces.find((w) => w.id === workspaceId)?.member_id;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Leave workspace</CardTitle>
          <CardDescription>
            You lose access straight away. Someone will have to invite you again to come back.
          </CardDescription>
        </div>
      </CardHeader>
      <CardFooter className="justify-end">
        <Button variant="secondary" disabled={!memberId} onClick={() => setConfirming(true)}>
          Leave workspace
        </Button>
      </CardFooter>
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
    </Card>
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
    <>
      <PageHeader
        title="Settings"
        subline={workspace.data ? `/${workspace.data.slug}` : undefined}
      />
      <SettingsTabs workspaceId={workspaceId} />
      {workspace.isPending ? (
        <Skeleton className="h-40" />
      ) : workspace.isError ? (
        <ErrorState
          message={errorMessage(workspace.error)}
          onRetry={() => void workspace.refetch()}
        />
      ) : (
        <div className="grid max-w-3xl gap-4">
          <RenameForm workspaceId={workspaceId} currentName={workspace.data.name} />
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Workspace ID</CardTitle>
                <CardDescription>
                  Use this when talking to the API or filing an issue.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <CodeBlock code={workspace.data.id} />
            </CardContent>
          </Card>
          <LeaveCard workspaceId={workspaceId} workspaceName={workspace.data.name} />
        </div>
      )}
    </>
  );
}
