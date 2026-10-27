/**
 * Copy for project roles, default project roles and protected operations (ADR 0014), so
 * every access screen names and explains them the same way.
 *
 * @module
 */
import type {
  MemberDefaultProjectRole,
  ProjectRole,
  ProtectedOperation,
  ProtectionRuleRole,
} from "@roundhouse/shared";

/** Label and one-line summary of each project role. */
export const PROJECT_ROLE_COPY: Record<ProjectRole, { label: string; summary: string }> = {
  project_admin: {
    label: "Project admin",
    summary: "Everything, including access, protection and deleting the project.",
  },
  developer: {
    label: "Developer",
    summary: "Changes config and variables, deploys, browses databases.",
  },
  deployer: {
    label: "Deployer",
    summary: "Deploys, rolls back and reads plain values; changes nothing.",
  },
  viewer: {
    label: "Viewer",
    summary: "Sees services, logs and variable names; never values.",
  },
};

/**
 * Human label of a project role.
 *
 * @param role - Project role.
 * @returns e.g. "Project admin".
 */
export function projectRoleLabel(role: ProjectRole): string {
  return PROJECT_ROLE_COPY[role].label;
}

/**
 * Human label of a default project role, where `none` means "grants only".
 *
 * @param role - A default project role choice.
 * @returns e.g. "No access (grants only)".
 */
export function defaultRoleLabel(role: MemberDefaultProjectRole): string {
  return role === "none" ? "No access (grants only)" : projectRoleLabel(role);
}

/** What each protected operation covers and who passes by default. */
export const OPERATION_COPY: Record<
  ProtectedOperation,
  {
    label: string;
    covers: string;
    action: "deployments:create" | "services:manage" | "variables:manage";
  }
> = {
  deploy: {
    label: "Deploy",
    covers: "Deploying, redeploying, rolling back and cancelling.",
    action: "deployments:create",
  },
  config: {
    label: "Config",
    covers: "Service settings: source, build, replicas, domains, volumes and deleting services.",
    action: "services:manage",
  },
  variables: {
    label: "Variables",
    covers: "Adding, changing and deleting service and shared variables.",
    action: "variables:manage",
  },
};

/**
 * Which rule roles already hold an operation's action without protection, so the rule
 * editor only offers roles that the rule can narrow (rules never widen access).
 */
export const RULE_ROLES_FOR: Record<ProtectedOperation, readonly ProtectionRuleRole[]> = {
  deploy: ["developer", "deployer"],
  config: ["developer"],
  variables: ["developer"],
};
