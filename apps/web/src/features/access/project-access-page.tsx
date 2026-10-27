import { PROJECT_ROLES, type ProjectRole, type ProtectedOperation } from "@roundhouse/shared";
import {
  Badge,
  Button,
  EmptyState,
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
  toast,
} from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import { CheckIcon, LockIcon, MinusIcon, ShieldIcon, UserIcon, UsersIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorState } from "../../components/error-state";
import type { ProjectAccess, ProjectAccessGrant } from "../../lib/api/access-types";
import { errorMessage } from "../../lib/api/client";
import type { Environment } from "../../lib/api/deploy-types";
import type { Member } from "../../lib/api/types";
import { formatRelativeTime, formatTimestamp } from "../../lib/format";
import { usePermissions, useProjectPermissions } from "../../lib/permissions";
import {
  useDeleteProjectGrant,
  useProjectAccess,
  useProtection,
  usePutProjectGrant,
  useTeamDetails,
  useTeams,
} from "../../queries/access";
import { useMembers } from "../../queries/members";
import { roleLabel } from "../members/role-select";
import { ProjectSettingsFrame } from "../projects/project-settings-frame";
import { useProjectEnvironment } from "../projects/use-project-environment";
import { DefaultAccessSection } from "./default-access-section";
import { explainProjectAccess, type MemberAccess } from "./effective-access";
import { OPERATION_COPY, PROJECT_ROLE_COPY, projectRoleLabel } from "./roles";

function ProjectRoleSelect({
  value,
  onValueChange,
  ...props
}: {
  value: ProjectRole;
  onValueChange: (role: ProjectRole) => void;
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Select
      value={value}
      onChange={(event) => onValueChange(event.target.value as ProjectRole)}
      {...props}
    >
      {PROJECT_ROLES.map((role) => (
        <option key={role} value={role}>
          {projectRoleLabel(role)}
        </option>
      ))}
    </Select>
  );
}

// -----------------------------------------------------------------------------
// Grants
// -----------------------------------------------------------------------------

type PrincipalKey = `user:${string}` | `team:${string}`;

function AddGrantForm({
  workspaceId,
  projectId,
  access,
  members,
  teams,
}: {
  workspaceId: string;
  projectId: string;
  access: ProjectAccess;
  members: readonly Member[];
  teams: readonly { id: string; name: string }[];
}) {
  const put = usePutProjectGrant(workspaceId, projectId);
  const [principal, setPrincipal] = useState<PrincipalKey | "">("");
  const [role, setRole] = useState<ProjectRole>("developer");
  const [error, setError] = useState<string | null>(null);
  const principalId = useId();
  const roleId = useId();
  const granted = new Set(
    access.grants.map((grant) => `${grant.principal.type}:${grant.principal.id}`),
  );
  // NOTE: Owners and admins are project admins everywhere; a grant to them changes
  // nothing, so they aren't offered.
  const people = members.filter(
    (member) =>
      member.role !== "owner" && member.role !== "admin" && !granted.has(`user:${member.user_id}`),
  );
  const groups = teams.filter((team) => !granted.has(`team:${team.id}`));

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!principal) {
      setError("Choose a member or a team.");
      return;
    }
    const [type, id] = principal.split(/:(.*)/s) as ["user" | "team", string];
    setError(null);
    put.mutate(
      { principal: { type, id }, role },
      {
        onSuccess: (grant) => {
          setPrincipal("");
          toast({
            title: `${grant.principal_name} is now ${projectRoleLabel(grant.role).toLowerCase()}`,
            tone: "success",
          });
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  }

  if (people.length === 0 && groups.length === 0) {
    return (
      <SettingsRow
        label="Grant access"
        description="Every member and team already has a grant here. Change their roles above."
      />
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Grant access">
      <SettingsRow
        label="Grant access"
        description="A grant raises someone's role on this project only. It never lowers the default role, and owners and admins are always project admins."
        control="wide"
      >
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end">
          <div className="grid gap-1.5">
            <label htmlFor={principalId} className="text-xs font-medium text-muted-foreground">
              Member or team
            </label>
            <Select
              id={principalId}
              value={principal}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${principalId}-error` : undefined}
              onChange={(event) => setPrincipal(event.target.value as PrincipalKey)}
            >
              <option value="">Choose…</option>
              {people.length ? (
                <optgroup label="Members">
                  {people.map((member) => (
                    <option key={member.user_id} value={`user:${member.user_id}`}>
                      {member.name || member.email}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {groups.length ? (
                <optgroup label="Teams">
                  {groups.map((team) => (
                    <option key={team.id} value={`team:${team.id}`}>
                      {team.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </Select>
          </div>
          <div className="grid gap-1.5">
            <label htmlFor={roleId} className="text-xs font-medium text-muted-foreground">
              Project role
            </label>
            <ProjectRoleSelect
              id={roleId}
              value={role}
              onValueChange={setRole}
              aria-describedby={`${roleId}-hint`}
            />
          </div>
          <Button type="submit" variant="primary" loading={put.isPending}>
            Grant
          </Button>
        </div>
        <p id={`${roleId}-hint`} className="mt-1.5 text-xs text-muted-foreground">
          {PROJECT_ROLE_COPY[role].summary}
        </p>
        {error ? (
          <p id={`${principalId}-error`} role="alert" className="mt-1.5 text-xs text-danger">
            {error}
          </p>
        ) : null}
      </SettingsRow>
    </form>
  );
}

function GrantsSection({
  workspaceId,
  projectId,
  access,
  members,
  teams,
}: {
  workspaceId: string;
  projectId: string;
  access: ProjectAccess;
  members: readonly Member[];
  teams: readonly { id: string; name: string }[];
}) {
  const put = usePutProjectGrant(workspaceId, projectId);
  const remove = useDeleteProjectGrant(workspaceId, projectId);
  const [revoking, setRevoking] = useState<ProjectAccessGrant | null>(null);

  function changeRole(grant: ProjectAccessGrant, role: ProjectRole) {
    put.mutate(
      { principal: grant.principal, role },
      {
        onSuccess: () =>
          toast({
            title: `${grant.principal_name} is now ${projectRoleLabel(role).toLowerCase()}`,
            tone: "success",
          }),
        onError: (cause) =>
          toast({
            title: "Could not change the role",
            description: errorMessage(cause),
            tone: "error",
          }),
      },
    );
  }

  return (
    <SettingsSection
      title="Grants"
      description="People and teams with a role on this project beyond the workspace default."
    >
      {access.grants.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          No grants yet. Everyone has their default role.
        </p>
      ) : (
        <Table stack aria-label="Grants">
          <TableHeader>
            <TableRow>
              <TableHead>Member or team</TableHead>
              <TableHead>Project role</TableHead>
              <TableHead className="text-right">Granted</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {access.grants.map((grant) => (
              <TableRow key={grant.id}>
                <TableCell cell="primary">
                  <span className="flex items-center gap-2 text-sm text-foreground">
                    {grant.principal.type === "team" ? (
                      <UsersIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                    ) : (
                      <UserIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                    )}
                    {grant.principal.type === "team" ? (
                      <Link
                        to="/w/$workspaceId/teams/$teamId"
                        params={{ workspaceId, teamId: grant.principal.id }}
                        className="outline-none hover:underline focus-visible:underline"
                      >
                        {grant.principal_name}
                      </Link>
                    ) : (
                      grant.principal_name
                    )}
                    <span className="text-xs text-muted-foreground">
                      {grant.principal.type === "team" ? "team" : "member"}
                    </span>
                  </span>
                </TableCell>
                <TableCell cell="action">
                  <ProjectRoleSelect
                    aria-label={`Project role for ${grant.principal_name}`}
                    value={grant.role}
                    disabled={put.isPending}
                    onValueChange={(role) => changeRole(grant, role)}
                    className="h-7 w-36 text-xs"
                  />
                </TableCell>
                <TableCell className="text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                  <span title={formatTimestamp(grant.updated_at)}>
                    {formatRelativeTime(grant.updated_at)}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Revoke access of ${grant.principal_name}`}
                    onClick={() => setRevoking(grant)}
                  >
                    Revoke
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <AddGrantForm
        workspaceId={workspaceId}
        projectId={projectId}
        access={access}
        members={members}
        teams={teams}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRevoking(null);
            remove.reset();
          }
        }}
        title={`Revoke access of ${revoking?.principal_name ?? ""}?`}
        description={
          revoking?.principal.type === "team"
            ? "Its members fall back to their default role or their own grants. Open pages refresh their access right away."
            : "They fall back to their default role and any team grants. Open pages refresh their access right away."
        }
        confirmLabel="Revoke access"
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() => {
          if (!revoking) return;
          remove.mutate(revoking.id, {
            onSuccess: () => {
              toast({ title: `Access of ${revoking.principal_name} revoked`, tone: "success" });
              setRevoking(null);
            },
          });
        }}
      />
    </SettingsSection>
  );
}

// -----------------------------------------------------------------------------
// Effective access
// -----------------------------------------------------------------------------

function OperationCell({
  operation,
  access,
  environmentName,
}: {
  operation: ProtectedOperation;
  access: MemberAccess;
  environmentName: string;
}) {
  const { allowed, reason } = access.operations[operation];
  const verb = OPERATION_COPY[operation].label.toLowerCase();
  if (allowed) {
    return (
      <span className="inline-flex text-success" title={`Can ${verb} in ${environmentName}`}>
        <CheckIcon className="size-4" aria-hidden="true" />
        <span className="sr-only">Allowed</span>
      </span>
    );
  }
  if (reason === "environment_protected") {
    return (
      <span
        className="inline-flex text-warning"
        title={`${environmentName} is protected and its ${verb} rule doesn't list them`}
      >
        <LockIcon className="size-3.5" aria-hidden="true" />
        <span className="sr-only">Blocked by protection</span>
      </span>
    );
  }
  return (
    <span className="inline-flex text-subtle-foreground" title="Their project role can't">
      <MinusIcon className="size-4" aria-hidden="true" />
      <span className="sr-only">Not with this role</span>
    </span>
  );
}

function EffectiveAccessSection({
  workspaceId,
  projectId,
  access,
  members,
  teamIds,
  environments,
}: {
  workspaceId: string;
  projectId: string;
  access: ProjectAccess;
  members: readonly Member[];
  teamIds: readonly string[];
  environments: readonly Environment[];
}) {
  const { environment: selected } = useProjectEnvironment(projectId);
  const [environmentId, setEnvironmentId] = useState<string | undefined>(undefined);
  const environment =
    environments.find((entry) => entry.id === environmentId) ?? selected ?? environments[0];
  const protection = useProtection(environment?.id);
  const teamQueries = useTeamDetails(teamIds);
  const teams = teamQueries.flatMap((query) => (query.data ? [query.data] : []));
  const teamsLoaded = teamQueries.every((query) => !query.isPending);
  const rows = explainProjectAccess({
    projectId,
    members,
    teams,
    access,
    protection: protection.data,
  });
  const selectId = useId();
  const environmentName = environment?.name ?? "this environment";
  const operations = Object.keys(OPERATION_COPY) as ProtectedOperation[];

  return (
    <SettingsSection
      title="Who can do what"
      description={
        <>
          Everyone in the workspace, their effective role here and where it comes from. Checked the
          same way the API checks each request.{" "}
          <Link
            to="/w/$workspaceId/p/$projectId/settings/environments"
            params={{ workspaceId, projectId }}
            search={{ env: environment?.kind === "production" ? undefined : environment?.slug }}
            className="text-accent-text underline underline-offset-4"
          >
            Edit protection rules
          </Link>
        </>
      }
      actions={
        environments.length > 1 ? (
          <div className="flex items-center gap-2">
            <label htmlFor={selectId} className="text-xs text-muted-foreground">
              Environment
            </label>
            <Select
              id={selectId}
              value={environment?.id ?? ""}
              onChange={(event) => setEnvironmentId(event.target.value)}
              className="h-7 w-40 text-xs"
            >
              {environments.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null
      }
    >
      {protection.isPending || !teamsLoaded ? (
        <Skeleton className="my-4 h-40" />
      ) : (
        <>
          <p className="py-3 text-xs text-muted-foreground">
            {protection.data?.protected ? (
              <>
                <LockIcon className="mr-1 inline size-3 text-warning" aria-hidden="true" />
                <span className="font-mono text-foreground">{environmentName}</span> is protected:
                its rules narrow who may deploy, change config and change variables.
              </>
            ) : (
              <>
                <span className="font-mono text-foreground">{environmentName}</span> isn't
                protected: every role does what it allows.
              </>
            )}
          </p>
          <Table stack aria-label={`Effective access in ${environmentName}`}>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Project role</TableHead>
                <TableHead>Why</TableHead>
                {operations.map((op) => (
                  <TableHead key={op} className="text-center">
                    {OPERATION_COPY[op].label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const winning = row.sources.filter((source) => source.role === row.role);
                const others = row.sources.filter((source) => source.role !== row.role);
                return (
                  <TableRow key={row.userId}>
                    <TableCell cell="primary">
                      <p className="truncate text-sm text-foreground">{row.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {roleLabel(row.workspaceRole)}
                      </p>
                    </TableCell>
                    <TableCell>
                      {row.role ? (
                        <Badge tone={row.role === "project_admin" ? "accent" : "neutral"}>
                          {projectRoleLabel(row.role)}
                        </Badge>
                      ) : (
                        <Badge tone="danger">No access</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {winning.length ? (
                        <span className="text-foreground">
                          {winning.map((source) => source.label).join(", ")}
                        </span>
                      ) : (
                        "No default role and no grant"
                      )}
                      {others.length ? (
                        <span className="block">
                          Also{" "}
                          {others
                            .map(
                              (source) =>
                                `${projectRoleLabel(source.role).toLowerCase()} via ${source.label}`,
                            )
                            .join(", ")}
                        </span>
                      ) : null}
                    </TableCell>
                    {operations.map((op) => (
                      <TableCell key={op} className="sm:text-center">
                        <span className="sm:hidden text-xs text-muted-foreground">
                          {OPERATION_COPY[op].label}{" "}
                        </span>
                        <OperationCell
                          operation={op}
                          access={row}
                          environmentName={environmentName}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </>
      )}
    </SettingsSection>
  );
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

/**
 * Project → Access: the project's grants to members and teams (add, change, revoke, each
 * with a fresh session), the workspace's default project roles, and "who can do what
 * here and why" for an environment, computed with `resolveAccess` like the API. Only
 * project admins (`access:manage`) can open it; others see why.
 *
 * @param props - Workspace and project ids.
 * @returns The page.
 */
export function ProjectAccessPage({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  const { project } = useProjectEnvironment(projectId);
  const permissions = useProjectPermissions(workspaceId, projectId);
  const workspace = usePermissions(workspaceId);
  const canManage = permissions.can("access:manage");
  const canReadMembers = workspace.can("members:read");
  const access = useProjectAccess(projectId, permissions.loaded && canManage);
  const members = useMembers(workspaceId, canManage && canReadMembers);
  const teams = useTeams(workspaceId, canManage && canReadMembers);

  return (
    <ProjectSettingsFrame
      workspaceId={workspaceId}
      projectId={projectId}
      title="Access"
      description={`Who can open ${project.data?.name ?? "this project"}, and with which role.`}
    >
      {!permissions.loaded ? (
        <Skeleton className="h-48" />
      ) : !canManage ? (
        <EmptyState
          icon={<ShieldIcon />}
          title="Only project admins manage access"
          description={
            permissions.role
              ? `Your role here is ${projectRoleLabel(permissions.role).toLowerCase()}. Ask a project admin to change who has access.`
              : "Ask a project admin to change who has access."
          }
        />
      ) : access.isPending ? (
        <Skeleton className="h-48" />
      ) : access.isError ? (
        <ErrorState message={errorMessage(access.error)} onRetry={() => void access.refetch()} />
      ) : (
        <SettingsStack>
          <GrantsSection
            workspaceId={workspaceId}
            projectId={projectId}
            access={access.data}
            members={members.data ?? []}
            teams={teams.data ?? []}
          />
          <DefaultAccessSection workspaceId={workspaceId} />
          {canReadMembers ? (
            members.data && teams.data ? (
              <EffectiveAccessSection
                workspaceId={workspaceId}
                projectId={projectId}
                access={access.data}
                members={members.data}
                teamIds={teams.data.map((team) => team.id)}
                environments={project.data?.environments ?? []}
              />
            ) : (
              <Skeleton className="h-40" />
            )
          ) : (
            <SettingsSection
              title="Who can do what"
              description="Your workspace role can't list members, so the per-person view isn't available. Grants above still apply."
            />
          )}
        </SettingsStack>
      )}
    </ProjectSettingsFrame>
  );
}
