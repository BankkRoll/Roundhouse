import {
  PROTECTED_OPERATIONS,
  type ProtectedOperation,
  type ProtectionRuleRole,
} from "@roundhouse/shared";
import {
  Avatar,
  Badge,
  Button,
  Checkbox,
  SaveBar,
  Select,
  SettingsRow,
  SettingsSection,
  SettingsStack,
  Skeleton,
  toast,
} from "@roundhouse/ui";
import { Switch } from "@roundhouse/ui/controls";
import { useNavigate } from "@tanstack/react-router";
import { LockIcon, LockOpenIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ErrorState } from "../../components/error-state";
import type { EnvironmentProtection, ProtectionRuleWire } from "../../lib/api/access-types";
import { errorMessage } from "../../lib/api/client";
import type { Environment } from "../../lib/api/deploy-types";
import { usePermissions, useProjectPermissions } from "../../lib/permissions";
import {
  useProjectDirectory,
  useProtection,
  usePutProtection,
  useTeams,
} from "../../queries/access";
import { EnvironmentLifecycle } from "../environments/environment-lifecycle";
import { ProjectSettingsFrame } from "../projects/project-settings-frame";
import { useProjectEnvironment } from "../projects/use-project-environment";
import { OPERATION_COPY, RULE_ROLES_FOR } from "./roles";

type Rules = EnvironmentProtection["rules"];

const ROLE_PLURAL: Record<ProtectionRuleRole, string> = {
  developer: "developers",
  deployer: "deployers",
};

const RULE_VERB: Record<ProtectedOperation, string> = {
  deploy: "deploy to",
  config: "change config in",
  variables: "change variables in",
};

/**
 * Names for the user and team ids in the rules, from the project directory. `options`
 * are what the pickers offer: people with a role on the project, and teams.
 */
interface Directory {
  users: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  options: { users: { id: string; name: string }[]; teams: { id: string; name: string }[] };
}

/**
 * The name behind an id. The directory names every current member a rule mentions, so a
 * miss is someone who left the workspace or a deleted team; never show the raw id.
 */
const nameOf = (list: Directory["users"], id: string, kind: "People" | "Teams") =>
  list.find((entry) => entry.id === id)?.name ??
  (kind === "People" ? "Former member" : "Deleted team");

/**
 * "Project admins, developers, Ada and team Platform": who passes a rule, in words.
 */
function describeRule(rule: ProtectionRuleWire, directory: Directory): string {
  const parts = [
    "project admins",
    ...rule.roles.map((role) => ROLE_PLURAL[role]),
    ...rule.user_ids.map((id) => nameOf(directory.users, id, "People")),
    ...rule.team_ids.map((id) => `team ${nameOf(directory.teams, id, "Teams")}`),
  ];
  if (parts.length === 1) return "Only project admins";
  const last = parts.pop();
  const sentence = `${parts.join(", ")} and ${last}`;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function PrincipalPicker({
  label,
  operation,
  ids,
  names,
  options,
  disabled,
  onChange,
}: {
  label: "People" | "Teams";
  operation: ProtectedOperation;
  ids: string[];
  /** Everyone the chips may name. */
  names: Directory["users"];
  /** What the picker offers. */
  options: Directory["users"];
  disabled: boolean;
  onChange: (ids: string[]) => void;
}) {
  const [picked, setPicked] = useState("");
  const selectId = useId();
  const available = options.filter((option) => !ids.includes(option.id));
  const ruleName = OPERATION_COPY[operation].label.toLowerCase();
  return (
    <div className="grid gap-1.5">
      <label htmlFor={selectId} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {ids.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${label} in the ${ruleName} rule`}>
          {ids.map((id) => (
            <li
              key={id}
              className="inline-flex h-6 items-center gap-1 rounded-sm border border-border-strong bg-muted pr-0.5 pl-2 text-xs text-foreground"
            >
              {label === "People" ? (
                <Avatar name={nameOf(names, id, label)} seed={id} size={16} className="-ml-1" />
              ) : (
                "team "
              )}
              {nameOf(names, id, label)}
              {disabled ? null : (
                <button
                  type="button"
                  aria-label={`Remove ${nameOf(names, id, label)} from the ${ruleName} rule`}
                  onClick={() => onChange(ids.filter((entry) => entry !== id))}
                  className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <XIcon className="size-3" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {disabled ? null : (
        <div className="flex gap-2">
          <Select
            id={selectId}
            value={picked}
            onChange={(event) => setPicked(event.target.value)}
            disabled={available.length === 0}
            className="h-8 min-w-0 flex-1 text-xs"
          >
            <option value="">
              {available.length === 0
                ? `No ${label.toLowerCase()} left to add`
                : `Add ${label === "People" ? "a person" : "a team"}…`}
            </option>
            {available.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </Select>
          <Button
            variant="secondary"
            size="sm"
            className="h-8"
            disabled={!picked}
            aria-label={`Add ${label === "People" ? "person" : "team"} to the ${ruleName} rule`}
            onClick={() => {
              if (!picked) return;
              onChange([...ids, picked]);
              setPicked("");
            }}
          >
            Add
          </Button>
        </div>
      )}
    </div>
  );
}

function RuleRow({
  operation,
  rule,
  directory,
  environmentName,
  editable,
  onChange,
}: {
  operation: ProtectedOperation;
  rule: ProtectionRuleWire;
  directory: Directory;
  environmentName: string;
  editable: boolean;
  onChange: (rule: ProtectionRuleWire) => void;
}) {
  const copy = OPERATION_COPY[operation];
  const summaryId = useId();
  return (
    <SettingsRow
      label={copy.label}
      description={
        <>
          {copy.covers}{" "}
          <span id={summaryId} className="mt-1 block text-foreground">
            {describeRule(rule, directory)} can {RULE_VERB[operation]} {environmentName}.
          </span>
        </>
      }
      control="field"
    >
      <fieldset
        className="grid gap-3"
        aria-describedby={summaryId}
        disabled={!editable}
        aria-label={`${copy.label} rule`}
      >
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-muted-foreground">Roles</span>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              <Checkbox checked disabled aria-label="Project admins (always)" />
              Project admins
            </span>
            {RULE_ROLES_FOR[operation].map((role) => (
              <label
                key={role}
                htmlFor={`${summaryId}-${role}`}
                className="inline-flex items-center gap-1.5 text-sm text-foreground"
              >
                <Checkbox
                  id={`${summaryId}-${role}`}
                  checked={rule.roles.includes(role)}
                  onChange={(event) =>
                    onChange({
                      ...rule,
                      roles: event.target.checked
                        ? [...rule.roles, role]
                        : rule.roles.filter((entry) => entry !== role),
                    })
                  }
                />
                {ROLE_PLURAL[role].charAt(0).toUpperCase() + ROLE_PLURAL[role].slice(1)}
              </label>
            ))}
          </div>
        </div>
        <PrincipalPicker
          label="People"
          operation={operation}
          ids={rule.user_ids}
          names={directory.users}
          options={directory.options.users}
          disabled={!editable}
          onChange={(user_ids) => onChange({ ...rule, user_ids })}
        />
        <PrincipalPicker
          label="Teams"
          operation={operation}
          ids={rule.team_ids}
          names={directory.teams}
          options={directory.options.teams}
          disabled={!editable}
          onChange={(team_ids) => onChange({ ...rule, team_ids })}
        />
      </fieldset>
    </SettingsRow>
  );
}

function ProtectionForm({
  workspaceId,
  projectId,
  environment,
  protection,
  directory,
  canManage,
}: {
  workspaceId: string;
  projectId: string;
  environment: Environment;
  protection: EnvironmentProtection;
  directory: Directory;
  canManage: boolean;
}) {
  const put = usePutProtection(workspaceId, projectId, environment.id);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  const [approval, setApproval] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const switchId = useId();
  const approvalId = useId();
  const nextEnabled = enabled ?? protection.protected;
  const nextApproval = approval ?? protection.require_approval;
  const approvalDirty = nextApproval !== protection.require_approval;
  const nextRules = rules ?? protection.rules;
  const rulesDirty = rules !== null && JSON.stringify(rules) !== JSON.stringify(protection.rules);
  const dirty = nextEnabled !== protection.protected || rulesDirty || approvalDirty;

  function discard() {
    setEnabled(null);
    setRules(null);
    setApproval(null);
    setError(null);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    put.mutate(
      {
        protected: nextEnabled,
        ...(rulesDirty ? { rules: nextRules } : {}),
        ...(approvalDirty ? { require_approval: nextApproval } : {}),
      },
      {
        onSuccess: (saved) => {
          discard();
          toast({
            title: saved.protected
              ? `${environment.name} is protected`
              : `${environment.name} is no longer protected`,
            tone: "success",
          });
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label={`Protection of ${environment.name}`}>
      <SettingsStack>
        <SettingsSection
          title="Protection"
          description="Protection narrows who may change what runs here. Reading is never restricted, and project admins always pass, so they can't lock themselves out."
          actions={
            <Badge tone={protection.protected ? "success" : "neutral"}>
              {protection.protected ? (
                <LockIcon aria-hidden="true" className="size-3" />
              ) : (
                <LockOpenIcon aria-hidden="true" className="size-3" />
              )}
              {protection.protected ? "Protected" : "Not protected"}
            </Badge>
          }
        >
          <SettingsRow
            label={`Protect ${environment.name}`}
            description={
              nextEnabled
                ? "The rules below decide who besides project admins may deploy, change config and change variables."
                : "Anyone whose project role allows it may deploy, change config and change variables."
            }
            htmlFor={switchId}
            control="switch"
          >
            <Switch
              id={switchId}
              checked={nextEnabled}
              disabled={!canManage}
              aria-describedby={`${switchId}-description`}
              onCheckedChange={(checked) => setEnabled(checked)}
            />
          </SettingsRow>
          <SettingsRow
            label="Require approval for staged changes"
            description={
              nextEnabled
                ? "Change sets apply here only after someone with approval rights, who neither staged them nor applies them, approves the exact revision. Direct edits still follow the rules below."
                : "Takes effect while the environment is protected."
            }
            htmlFor={approvalId}
            control="switch"
          >
            <Switch
              id={approvalId}
              checked={nextApproval}
              disabled={!canManage}
              aria-describedby={`${approvalId}-description`}
              onCheckedChange={(checked) => setApproval(checked)}
            />
          </SettingsRow>
        </SettingsSection>
        <SettingsSection
          title="Rules"
          description={
            nextEnabled
              ? "Listed roles, people and teams pass a rule only if their project role already allows the operation: rules narrow access, they never grant it."
              : "Kept for when protection is on; they have no effect while it is off."
          }
          className={nextEnabled ? undefined : "opacity-70"}
        >
          {PROTECTED_OPERATIONS.map((operation) => (
            <RuleRow
              key={operation}
              operation={operation}
              rule={nextRules[operation]}
              directory={directory}
              environmentName={environment.name}
              editable={canManage}
              onChange={(rule) => setRules({ ...nextRules, [operation]: rule })}
            />
          ))}
          {error ? (
            <p role="alert" className="py-3 text-sm text-danger">
              {error}
            </p>
          ) : null}
        </SettingsSection>
      </SettingsStack>
      {canManage ? <SaveBar dirty={dirty} saving={put.isPending} onDiscard={discard} /> : null}
    </form>
  );
}

function ProductionNotice({
  workspaceId,
  projectId,
  environment,
}: {
  workspaceId: string;
  projectId: string;
  environment: Environment;
}) {
  const put = usePutProtection(workspaceId, projectId, environment.id);
  return (
    <div
      role="note"
      className="mb-8 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3"
    >
      <p className="flex items-start gap-2 text-sm text-foreground">
        <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <span>
          Production isn't protected. Anyone whose project role allows it can deploy and change its
          variables. Protecting it keeps deploys open to developers and deployers and limits
          variable changes to project admins.
        </span>
      </p>
      <Button
        variant="primary"
        size="sm"
        loading={put.isPending}
        onClick={() =>
          put.mutate(
            { protected: true },
            {
              onSuccess: () =>
                toast({ title: `${environment.name} is protected`, tone: "success" }),
              onError: (cause) =>
                toast({
                  title: "Could not protect production",
                  description: errorMessage(cause),
                  tone: "error",
                }),
            },
          )
        }
      >
        <LockIcon />
        Protect production
      </Button>
    </div>
  );
}

/**
 * Project → Environments: an environment's protection switch and its per-operation
 * rules (deploy, config, variables → roles, people, teams), each explained in a
 * sentence. Project admins edit them (with a fresh session); everyone else reads them.
 * Production that isn't protected gets a one-click fix.
 *
 * @param props - Workspace and project ids.
 * @returns The page.
 */
export function EnvironmentProtectionPage({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  const { project, environment } = useProjectEnvironment(projectId);
  const navigate = useNavigate();
  const permissions = useProjectPermissions(workspaceId, projectId);
  const workspace = usePermissions(workspaceId);
  const canManage = permissions.loaded && permissions.can("access:manage");
  const protection = useProtection(environment?.id);
  // NOTE: Project admins need not be able to list the workspace's members (a workspace
  // viewer granted project admin can't), so names come from the project directory.
  // Teams without a grant or rule on the project are only offered to those who can.
  const projectDirectory = useProjectDirectory(projectId);
  const allTeams = useTeams(workspaceId, canManage && workspace.can("members:read"));
  const pickerId = useId();
  const environments = project.data?.environments ?? [];
  const known = projectDirectory.data ?? { users: [], teams: [] };
  const teams = [...known.teams];
  for (const team of allTeams.data ?? []) {
    if (!teams.some((entry) => entry.id === team.id)) teams.push({ id: team.id, name: team.name });
  }
  const directory: Directory = {
    users: known.users,
    teams,
    options: { users: known.users.filter((user) => user.project_member), teams },
  };

  return (
    <ProjectSettingsFrame
      workspaceId={workspaceId}
      projectId={projectId}
      title="Environments"
      description="Create, compare, promote and delete environments, and protect them so only the right people can change what runs there."
      actions={
        environments.length > 1 ? (
          <div className="flex items-center gap-2">
            <label htmlFor={pickerId} className="text-sm text-muted-foreground">
              Environment
            </label>
            <Select
              id={pickerId}
              value={environment?.id ?? ""}
              onChange={(event) => {
                const next = environments.find((entry) => entry.id === event.target.value);
                void navigate({
                  to: "/w/$workspaceId/p/$projectId/settings/environments",
                  params: { workspaceId, projectId },
                  search: { env: next && next.kind !== "production" ? next.slug : undefined },
                });
              }}
              className="w-44"
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
      {project.data ? (
        <div className="mb-10">
          <EnvironmentLifecycle
            workspaceId={workspaceId}
            projectId={projectId}
            environments={project.data.environments}
          />
        </div>
      ) : null}
      {!environment || protection.isPending || projectDirectory.isPending ? (
        <Skeleton className="h-64" />
      ) : protection.isError || projectDirectory.isError ? (
        <ErrorState
          message={errorMessage(protection.error ?? projectDirectory.error)}
          onRetry={() => {
            if (protection.isError) void protection.refetch();
            if (projectDirectory.isError) void projectDirectory.refetch();
          }}
        />
      ) : (
        <>
          {canManage && environment.kind === "production" && !protection.data.protected ? (
            <ProductionNotice
              workspaceId={workspaceId}
              projectId={projectId}
              environment={environment}
            />
          ) : null}
          {!canManage && permissions.loaded ? (
            <p className="mb-6 text-sm text-muted-foreground">
              Only project admins can change protection. This is what applies to you and everyone
              else in <span className="font-mono text-foreground">{environment.name}</span>.
            </p>
          ) : null}
          <ProtectionForm
            key={`${environment.id}:${JSON.stringify(protection.data)}`}
            workspaceId={workspaceId}
            projectId={projectId}
            environment={environment}
            protection={protection.data}
            directory={directory}
            canManage={canManage}
          />
        </>
      )}
    </ProjectSettingsFrame>
  );
}
