import {
  Avatar,
  Button,
  DangerZone,
  EmptyState,
  SaveBar,
  Select,
  SettingsRow,
  SettingsSection,
  SettingsStack,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  toast,
} from "@roundhouse/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, LockIcon, UserPlusIcon, UsersIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorState } from "../../components/error-state";
import { SettingsField } from "../../components/settings-field";
import type { TeamDetail, TeamMember } from "../../lib/api/access-types";
import { errorMessage, isApiError } from "../../lib/api/client";
import type { Member } from "../../lib/api/types";
import { formatRelativeTime, formatTimestamp } from "../../lib/format";
import { usePermissions } from "../../lib/permissions";
import { useDeleteTeam, useSetTeamMembers, useTeam, useUpdateTeam } from "../../queries/access";
import { useMembers } from "../../queries/members";
import { SettingsFrame } from "../settings/settings-frame";
import { roleLabel } from "./role-select";

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function GeneralForm({
  workspaceId,
  team,
  canManage,
}: {
  workspaceId: string;
  team: TeamDetail;
  canManage: boolean;
}) {
  const update = useUpdateTeam(workspaceId, team.id);
  const [name, setName] = useState<string | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ name?: string; slug?: string; form?: string }>({});
  const descriptionId = useId();
  const nextName = (name ?? team.name).trim();
  const nextSlug = (slug ?? team.slug).trim();
  const nextDescription = (description ?? team.description ?? "").trim();
  const dirty =
    nextName !== team.name ||
    nextSlug !== team.slug ||
    nextDescription !== (team.description ?? "");

  function discard() {
    setName(null);
    setSlug(null);
    setDescription(null);
    setErrors({});
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const found: typeof errors = {};
    if (!nextName) found.name = "Enter a team name.";
    if (!SLUG.test(nextSlug) || nextSlug.length > 40) {
      found.slug = "Use lowercase letters, digits and dashes, up to 40 characters.";
    }
    setErrors(found);
    if (found.name || found.slug) return;
    update.mutate(
      {
        ...(nextName !== team.name ? { name: nextName } : {}),
        ...(nextSlug !== team.slug ? { slug: nextSlug } : {}),
        ...(nextDescription !== (team.description ?? "")
          ? { description: nextDescription || null }
          : {}),
      },
      {
        onSuccess: () => {
          discard();
          toast({ title: "Team saved", tone: "success" });
        },
        onError: (cause) =>
          setErrors(
            isApiError(cause, 409)
              ? { slug: "Another team already uses this handle." }
              : { form: errorMessage(cause) },
          ),
      },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="General">
      <SettingsSection title="General" description="How the team shows up in grants and rules.">
        <SettingsField
          label="Name"
          value={name ?? team.name}
          onChange={(event) => setName(event.target.value)}
          disabled={!canManage}
          error={errors.name}
          maxLength={100}
        />
        <SettingsField
          label="Handle"
          description="A short, unique name for the API and CLI."
          value={slug ?? team.slug}
          onChange={(event) => setSlug(event.target.value.toLowerCase())}
          disabled={!canManage}
          error={errors.slug}
          inputClassName="font-mono"
          spellCheck={false}
          maxLength={40}
        />
        <SettingsRow label="Description" description="Optional." htmlFor={descriptionId}>
          <Textarea
            id={descriptionId}
            aria-describedby={`${descriptionId}-description`}
            value={description ?? team.description ?? ""}
            onChange={(event) => setDescription(event.target.value)}
            disabled={!canManage}
            maxLength={500}
            className="min-h-16 font-sans text-sm"
          />
        </SettingsRow>
        {errors.form ? (
          <p role="alert" className="py-3 text-sm text-danger">
            {errors.form}
          </p>
        ) : null}
      </SettingsSection>
      {canManage ? <SaveBar dirty={dirty} saving={update.isPending} onDiscard={discard} /> : null}
    </form>
  );
}

function AddMemberRow({
  team,
  candidates,
  pending,
  onAdd,
}: {
  team: TeamDetail;
  candidates: readonly Member[];
  pending: boolean;
  onAdd: (userId: string) => void;
}) {
  const [picked, setPicked] = useState("");
  const selectId = useId();
  if (candidates.length === 0) {
    return (
      <SettingsRow
        label="Add a member"
        description="Every workspace member is already in this team."
      />
    );
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (picked) onAdd(picked);
        setPicked("");
      }}
      aria-label={`Add a member to ${team.name}`}
    >
      <SettingsRow
        label="Add a member"
        description="Only workspace members can join a team."
        htmlFor={selectId}
      >
        <div className="flex gap-2">
          <Select
            id={selectId}
            aria-describedby={`${selectId}-description`}
            value={picked}
            onChange={(event) => setPicked(event.target.value)}
            className="min-w-0 flex-1"
          >
            <option value="">Choose a member…</option>
            {candidates.map((member) => (
              <option key={member.user_id} value={member.user_id}>
                {member.name || member.email}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="secondary" disabled={!picked} loading={pending}>
            <UserPlusIcon />
            Add
          </Button>
        </div>
      </SettingsRow>
    </form>
  );
}

function MembersSection({
  workspaceId,
  team,
  canManage,
}: {
  workspaceId: string;
  team: TeamDetail;
  canManage: boolean;
}) {
  const members = useMembers(workspaceId, canManage);
  const setMembers = useSetTeamMembers(workspaceId, team.id);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const inTeam = new Set(team.members.map((member) => member.user_id));
  const candidates = (members.data ?? []).filter((member) => !inTeam.has(member.user_id));

  function add(userId: string) {
    const added = members.data?.find((member) => member.user_id === userId);
    setMembers.mutate([...inTeam, userId], {
      onSuccess: () =>
        toast({
          title: `${added?.name || added?.email || "Member"} added to ${team.name}`,
          tone: "success",
        }),
      onError: (cause) =>
        toast({
          title: "Could not add the member",
          description: errorMessage(cause),
          tone: "error",
        }),
    });
  }

  return (
    <SettingsSection
      title="Members"
      description={`${team.members.length} ${team.members.length === 1 ? "person" : "people"}. Everyone gets the project roles granted to this team.`}
    >
      {team.members.length === 0 ? (
        <EmptyState
          icon={<UsersIcon />}
          title="No members"
          description="Grants to this team give nobody access until someone joins it."
          className="my-4 border-none"
        />
      ) : (
        <Table stack aria-label={`Members of ${team.name}`}>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Workspace role</TableHead>
              <TableHead className="text-right">Added</TableHead>
              {canManage ? (
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {team.members.map((member) => (
              <TableRow key={member.user_id}>
                <TableCell cell="primary">
                  <div className="flex items-center gap-3">
                    <Avatar name={member.name || member.email} seed={member.user_id} size={28} />
                    <div className="min-w-0">
                      <p className="truncate text-sm text-foreground">
                        {member.name || member.email}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {roleLabel(member.workspace_role)}
                </TableCell>
                <TableCell className="text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                  <span title={formatTimestamp(member.added_at)}>
                    <span className="sm:hidden">Added </span>
                    {formatRelativeTime(member.added_at)}
                  </span>
                </TableCell>
                {canManage ? (
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove ${member.name || member.email} from ${team.name}`}
                      onClick={() => setRemoving(member)}
                    >
                      Remove
                    </Button>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {canManage ? (
        <AddMemberRow
          team={team}
          candidates={candidates}
          pending={setMembers.isPending && !removing}
          onAdd={add}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(null);
            setMembers.reset();
          }
        }}
        title={`Remove ${removing?.name || removing?.email || "member"} from ${team.name}?`}
        description="They lose every project role granted through this team right away. Their own grants and default role stay."
        confirmLabel="Remove from team"
        pending={setMembers.isPending}
        error={setMembers.isError ? errorMessage(setMembers.error) : null}
        onConfirm={() => {
          if (!removing) return;
          setMembers.mutate(
            team.members.map((m) => m.user_id).filter((id) => id !== removing.user_id),
            {
              onSuccess: () => {
                toast({
                  title: `${removing.name || removing.email} removed from ${team.name}`,
                  tone: "success",
                });
                setRemoving(null);
              },
            },
          );
        }}
      />
    </SettingsSection>
  );
}

function DeleteTeamSection({ workspaceId, team }: { workspaceId: string; team: TeamDetail }) {
  const remove = useDeleteTeam(workspaceId);
  const navigate = useNavigate();
  const [confirming, setConfirming] = useState(false);
  return (
    <DangerZone>
      <SettingsRow
        label="Delete team"
        description="Removes its project grants and its entries in protection rules. Members stay in the workspace."
      >
        <div className="md:flex md:justify-end">
          <Button variant="danger-outline" onClick={() => setConfirming(true)}>
            Delete team
          </Button>
        </div>
      </SettingsRow>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) remove.reset();
        }}
        title={`Delete ${team.name}?`}
        description={`${team.members.length} ${team.members.length === 1 ? "member loses" : "members lose"} whatever access this team granted. This can't be undone.`}
        confirmLabel="Delete team"
        confirmText={team.slug}
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() =>
          remove.mutate(team.id, {
            onSuccess: async () => {
              setConfirming(false);
              toast({ title: `${team.name} deleted`, tone: "success" });
              await navigate({ to: "/w/$workspaceId/teams", params: { workspaceId } });
            },
          })
        }
      />
    </DangerZone>
  );
}

/**
 * One team: its name, handle and description, its members (added and removed one at a
 * time), and deletion. Read-only for roles without `members:manage`; hidden from roles
 * without `members:read`. Membership changes and deletion need a fresh session, which
 * the API client asks for.
 *
 * @param props - Workspace and team ids.
 * @returns The page.
 */
export function TeamDetailPage({ workspaceId, teamId }: { workspaceId: string; teamId: string }) {
  const { can } = usePermissions(workspaceId);
  const canRead = can("members:read");
  const canManage = can("members:manage");
  const team = useTeam(teamId, canRead);
  const back = (
    <Link
      to="/w/$workspaceId/teams"
      params={{ workspaceId }}
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
    >
      <ArrowLeftIcon className="size-3.5" aria-hidden="true" />
      Teams
    </Link>
  );

  return (
    <SettingsFrame workspaceId={workspaceId} title={team.data?.name ?? "Team"} description={back}>
      {!canRead ? (
        <EmptyState
          icon={<LockIcon />}
          title="Teams are hidden for your role"
          description="Ask a workspace admin if you need to see who belongs to which team."
        />
      ) : team.isPending ? (
        <Skeleton className="h-56" />
      ) : team.isError ? (
        isApiError(team.error, 404) ? (
          <EmptyState
            icon={<UsersIcon />}
            title="Team not found"
            description="It may have been deleted."
          />
        ) : (
          <ErrorState message={errorMessage(team.error)} onRetry={() => void team.refetch()} />
        )
      ) : (
        <SettingsStack>
          <GeneralForm
            key={team.data.updated_at}
            workspaceId={workspaceId}
            team={team.data}
            canManage={canManage}
          />
          <MembersSection workspaceId={workspaceId} team={team.data} canManage={canManage} />
          {canManage ? <DeleteTeamSection workspaceId={workspaceId} team={team.data} /> : null}
        </SettingsStack>
      )}
    </SettingsFrame>
  );
}
