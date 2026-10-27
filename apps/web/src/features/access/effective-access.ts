/**
 * "Who can do what here, and why" for one project and environment, computed in the
 * browser with the same `resolveAccess` the API enforces, from data the access screens
 * already load: members, teams with their members, the project's grants and implied
 * roles, and the environment's protection.
 *
 * @module
 */
import {
  type AccessDenial,
  impliedProjectRole,
  PROJECT_ROLES,
  PROTECTED_OPERATION_ACTION,
  PROTECTED_OPERATIONS,
  type ProjectRole,
  type ProtectedOperation,
  type ProtectionRules,
  type Role,
  resolveAccess,
  type WorkspaceAccessSettings,
} from "@roundhouse/shared";
import type { EnvironmentProtection, ProjectAccess, TeamDetail } from "../../lib/api/access-types";
import type { Member } from "../../lib/api/types";

/** Where part of someone's project role comes from. */
export interface AccessSource {
  kind: "workspace" | "default" | "grant" | "team";
  /** e.g. "Workspace admin", "Team Platform". */
  label: string;
  role: ProjectRole;
}

/** One person's access to the project, explained. */
export interface MemberAccess {
  userId: string;
  name: string;
  email: string;
  workspaceRole: Role;
  /** Effective project role; `null` when they can't open the project. */
  role: ProjectRole | null;
  /** Every source of a role, most privileged first. */
  sources: AccessSource[];
  /** Whether they may perform each protected operation in the environment, and why not. */
  operations: Record<ProtectedOperation, { allowed: boolean; reason: AccessDenial | null }>;
}

/** Inputs of {@link explainProjectAccess}. */
export interface ExplainInput {
  projectId: string;
  members: readonly Member[];
  teams: readonly TeamDetail[];
  access: ProjectAccess;
  /** The environment in view; omit to judge operations without protection. */
  protection?: EnvironmentProtection;
}

const WORKSPACE_ROLE_WORDS: Record<Role, string> = {
  owner: "Workspace owner",
  admin: "Workspace admin",
  member: "Default for members",
  viewer: "Default for viewers",
};

const rank = (role: ProjectRole) => PROJECT_ROLES.indexOf(role);

/**
 * Explains every workspace member's access to a project.
 *
 * @param input - Members, teams, grants, implied roles and the environment's protection.
 * @returns One row per member, highest project role first, then by name.
 * @example
 * explainProjectAccess({ projectId, members, teams, access, protection })[0];
 * // { name: "Ada", role: "project_admin", sources: [{ kind: "workspace", … }], … }
 */
export function explainProjectAccess(input: ExplainInput): MemberAccess[] {
  const { projectId, members, teams, access, protection } = input;
  const settings: WorkspaceAccessSettings = {
    memberDefaultProjectRole: access.implied.member,
    viewerDefaultProjectRole: access.implied.viewer,
  };
  const grants = access.grants.map((grant) => ({
    projectId,
    principal: grant.principal,
    role: grant.role,
  }));
  const environmentId = protection?.environment_id;
  const protections = protection
    ? [
        {
          environmentId: protection.environment_id,
          projectId,
          protected: protection.protected,
          rules: Object.fromEntries(
            PROTECTED_OPERATIONS.map((op) => [
              op,
              {
                roles: protection.rules[op].roles,
                userIds: protection.rules[op].user_ids,
                teamIds: protection.rules[op].team_ids,
              },
            ]),
          ) as ProtectionRules,
        },
      ]
    : [];

  const rows = members.map((member): MemberAccess => {
    const teamIds = teams
      .filter((team) => team.members.some((entry) => entry.user_id === member.user_id))
      .map((team) => team.id);
    const resolver = resolveAccess(
      { userId: member.user_id, workspaceRole: member.role, instanceAdmin: false, teamIds },
      { settings, grants, protections },
    );
    const sources: AccessSource[] = [];
    const implied = impliedProjectRole(member.role, settings);
    if (implied) {
      sources.push({
        kind: member.role === "owner" || member.role === "admin" ? "workspace" : "default",
        label: WORKSPACE_ROLE_WORDS[member.role],
        role: implied,
      });
    }
    for (const grant of access.grants) {
      if (grant.principal.type === "user" && grant.principal.id === member.user_id) {
        sources.push({ kind: "grant", label: "Direct grant", role: grant.role });
      } else if (grant.principal.type === "team" && teamIds.includes(grant.principal.id)) {
        sources.push({ kind: "team", label: `Team ${grant.principal_name}`, role: grant.role });
      }
    }
    sources.sort((a, b) => rank(a.role) - rank(b.role));
    const operations = Object.fromEntries(
      PROTECTED_OPERATIONS.map((op) => {
        const decision = resolver.check(
          PROTECTED_OPERATION_ACTION[op],
          environmentId ? { environmentId } : { projectId },
        );
        return [op, { allowed: decision.allowed, reason: decision.reason }];
      }),
    ) as MemberAccess["operations"];
    return {
      userId: member.user_id,
      name: member.name || member.email,
      email: member.email,
      workspaceRole: member.role,
      role: resolver.projectRole(projectId),
      sources,
      operations,
    };
  });

  return rows.sort((a, b) => {
    const byRole = (a.role ? rank(a.role) : 99) - (b.role ? rank(b.role) : 99);
    return byRole || a.name.localeCompare(b.name);
  });
}
