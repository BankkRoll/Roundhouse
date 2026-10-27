/**
 * How API token scopes read in the dashboard: a label per scope, the named presets the
 * create dialog offers, and a one-line summary of a token's scopes.
 *
 * @module
 */
import {
  API_TOKEN_PRESETS,
  API_TOKEN_SCOPES,
  type ApiTokenPreset,
  type ApiTokenScope,
} from "@roundhouse/shared";

/** What each scope lets a token do, in the words of the create dialog. */
export const SCOPE_LABELS: Record<ApiTokenScope, string> = {
  "workspace:read": "Read the workspace",
  "workspace:update": "Rename the workspace",
  "workspace:delete": "Delete the workspace",
  "members:read": "See members",
  "members:manage": "Invite, change and remove members",
  "tokens:manage": "Create and revoke API tokens",
  "nodes:read": "See servers",
  "nodes:manage": "Add and remove servers",
  "audit:read": "Read the audit log",
  "projects:create": "Create projects",
  "github:manage": "Claim and release GitHub installations",
  "projects:read": "See projects",
  "projects:manage": "Change and delete projects",
  "access:manage": "Grant project access and protect environments",
  "services:read": "See services, deployments and logs",
  "services:manage": "Create and change services",
  "deployments:create": "Deploy, roll back and cancel",
  "variables:read": "See variable names and fingerprints, no values",
  "variables:read_plain": "Read plain values (secrets are never readable)",
  "variables:manage": "Set and delete variables",
  "data:read": "Browse databases and run read-only queries",
  "data:write": "Run writing queries on databases",
  "backups:manage": "Change backup policies, back up and delete backups",
  "backups:restore": "Restore and download backups",
  "changes:approve": "Approve or reject staged changes",
  "changes:auto_apply": "Apply staged changes without a person's approval",
  "shell:open": "Open shells in running replicas (unprotected environments only)",
};

/** A choice in the create dialog: a preset, or picking scopes one by one. */
export type ScopeChoice = ApiTokenPreset | "custom";

/** Label and description of each {@link ScopeChoice}. */
export const SCOPE_CHOICES: Record<ScopeChoice, { label: string; description: string }> = {
  read: {
    label: "Read only",
    description: "See projects, services, deployments, logs and servers. Secrets stay masked.",
  },
  deploy: {
    label: "Deploy",
    description: "Everything in Read only, plus deploy and change services and variables. For CI.",
  },
  custom: { label: "Custom", description: "Pick exactly which actions the token may perform." },
};

/** Scopes in a stable display order. */
export const ORDERED_SCOPES: readonly ApiTokenScope[] = API_TOKEN_SCOPES;

function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && b.every((scope) => a.includes(scope));
}

/**
 * Names the preset a set of scopes matches exactly.
 *
 * @param scopes - A token's scopes.
 * @returns The preset, or `"custom"` when none matches.
 */
export function presetOf(scopes: readonly ApiTokenScope[]): ScopeChoice {
  for (const preset of Object.keys(API_TOKEN_PRESETS) as ApiTokenPreset[]) {
    if (sameScopes(scopes, API_TOKEN_PRESETS[preset])) return preset;
  }
  return "custom";
}

/**
 * One-line summary of a token's scopes for the tokens table.
 *
 * @param scopes - A token's scopes.
 * @returns E.g. `"Deploy · 8 scopes"` or `"Custom · 1 scope"`.
 */
export function summarizeScopes(scopes: readonly ApiTokenScope[]): string {
  const count = `${scopes.length} ${scopes.length === 1 ? "scope" : "scopes"}`;
  return `${SCOPE_CHOICES[presetOf(scopes)].label} · ${count}`;
}
