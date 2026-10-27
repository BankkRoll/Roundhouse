/**
 * Access-control tables of the mock database (ADR 0014): workspace access settings,
 * teams and their members, project grants, and environment protection rules. An
 * environment's `protected` flag lives on its row in `db.deploy.environments`, like the
 * API's `environments.protected`.
 *
 * The seed has one team, Platform, with the admin and the member in it, and no grants,
 * so seeded users keep exactly the access their workspace roles imply.
 *
 * @module
 */
import type {
  MemberDefaultProjectRole,
  ProjectRole,
  ProtectionRules,
  ViewerDefaultProjectRole,
} from "@roundhouse/shared";

/** Default project roles of one workspace, in the API's wire shape. */
export interface DbAccessSettings {
  member_default_project_role: MemberDefaultProjectRole;
  viewer_default_project_role: ViewerDefaultProjectRole;
}

/** A team row. */
export interface DbTeam {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

/** A team membership row. */
export interface DbTeamMember {
  team_id: string;
  user_id: string;
  added_at: number;
}

/** A project grant row; exactly one of `user_id` and `team_id` is set. */
export interface DbGrant {
  id: string;
  project_id: string;
  principal_type: "user" | "team";
  user_id: string | null;
  team_id: string | null;
  role: ProjectRole;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/** Every access-control table. */
export interface AccessDb {
  /** By workspace id; a workspace without a row has the defaults. */
  settings: Record<string, DbAccessSettings>;
  teams: DbTeam[];
  teamMembers: DbTeamMember[];
  grants: DbGrant[];
  /** Stored rules by environment id; absent means `DEFAULT_PROTECTION_RULES`. */
  rules: Record<string, ProtectionRules>;
}

/** Ids of the seeded access rows, for tests. */
export const ACCESS_SEED = { platformTeam: "team_platform" } as const;

/**
 * Seeds the access tables.
 *
 * @param workspaceId - The seeded workspace.
 * @param members - User ids to put in the Platform team.
 * @param now - Clock, unix ms.
 * @returns The tables.
 */
export function seedAccess(workspaceId: string, members: string[], now: number): AccessDb {
  return {
    settings: {
      [workspaceId]: {
        member_default_project_role: "developer",
        viewer_default_project_role: "viewer",
      },
    },
    teams: [
      {
        id: ACCESS_SEED.platformTeam,
        workspace_id: workspaceId,
        name: "Platform",
        slug: "platform",
        description: "Keeps the shared infrastructure running.",
        created_at: now - 20 * 86_400_000,
        updated_at: now - 20 * 86_400_000,
      },
    ],
    teamMembers: members.map((userId) => ({
      team_id: ACCESS_SEED.platformTeam,
      user_id: userId,
      added_at: now - 20 * 86_400_000,
    })),
    grants: [],
    rules: {},
  };
}

/**
 * Empty access tables, for a fresh install.
 *
 * @returns The tables.
 */
export function emptyAccess(): AccessDb {
  return { settings: {}, teams: [], teamMembers: [], grants: [], rules: {} };
}
