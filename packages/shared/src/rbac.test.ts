import { describe, expect, it } from "vitest";
import {
  ACCESS_DENIALS,
  ACTIONS,
  type AccessContext,
  type AccessSubject,
  type Action,
  can,
  DEFAULT_PROTECTION_RULES,
  DEFAULT_WORKSPACE_ACCESS_SETTINGS,
  ENVIRONMENT_ACTIONS,
  type EnvironmentProtection,
  INSTANCE_ACTIONS,
  impliedProjectRole,
  isProjectRole,
  isRole,
  isTwoFactorRequired,
  MEMBER_DEFAULT_PROJECT_ROLES,
  maxProjectRole,
  PROJECT_ACTIONS,
  PROJECT_ROLES,
  type ProjectAction,
  type ProjectRole,
  projectRoleCan,
  ROLES,
  type Role,
  resolveAccess,
  WORKSPACE_ACTIONS,
  type WorkspaceAction,
  workspaceRoleCan,
} from "./rbac";

const P1 = "prj_1";
const P2 = "prj_2";
const PROD = "env_prod";
const STAGING = "env_staging";
const OTHER_PROD = "env_other";

const protections = (prodProtected = true): EnvironmentProtection[] => [
  { environmentId: PROD, projectId: P1, protected: prodProtected, rules: DEFAULT_PROTECTION_RULES },
  {
    environmentId: STAGING,
    projectId: P1,
    protected: false,
    rules: DEFAULT_PROTECTION_RULES,
  },
  {
    environmentId: OTHER_PROD,
    projectId: P2,
    protected: true,
    rules: DEFAULT_PROTECTION_RULES,
  },
];

const subject = (over: Partial<AccessSubject> = {}): AccessSubject => ({
  userId: "usr_me",
  workspaceRole: "member",
  instanceAdmin: false,
  teamIds: [],
  ...over,
});

const context = (over: Partial<AccessContext> = {}): AccessContext => ({
  settings: DEFAULT_WORKSPACE_ACCESS_SETTINGS,
  grants: [],
  protections: protections(),
  ...over,
});

describe("action lists", () => {
  it("partitions every action into exactly one level", () => {
    const all = [...WORKSPACE_ACTIONS, ...PROJECT_ACTIONS, ...INSTANCE_ACTIONS];
    expect(new Set(all).size).toBe(all.length);
    expect([...ACTIONS].sort()).toEqual([...all].sort());
  });

  it("no longer has a reveal action", () => {
    expect(ACTIONS as readonly string[]).not.toContain("variables:reveal");
  });

  it("keeps tokens:manage", () => {
    expect(ACTIONS).toContain("tokens:manage");
  });

  it("lists environment actions among project actions", () => {
    for (const a of ENVIRONMENT_ACTIONS) expect(PROJECT_ACTIONS).toContain(a);
  });

  it("names a reason for every denial path", () => {
    expect(ACCESS_DENIALS.length).toBe(new Set(ACCESS_DENIALS).size);
  });
});

describe("workspaceRoleCan", () => {
  it.each<[WorkspaceAction, Record<Role, boolean>]>([
    ["workspace:read", { owner: true, admin: true, member: true, viewer: true }],
    ["workspace:update", { owner: true, admin: true, member: false, viewer: false }],
    ["workspace:delete", { owner: true, admin: false, member: false, viewer: false }],
    ["members:read", { owner: true, admin: true, member: true, viewer: false }],
    ["members:manage", { owner: true, admin: true, member: false, viewer: false }],
    ["tokens:manage", { owner: true, admin: true, member: false, viewer: false }],
    ["nodes:read", { owner: true, admin: true, member: true, viewer: true }],
    ["nodes:manage", { owner: true, admin: true, member: false, viewer: false }],
    ["audit:read", { owner: true, admin: true, member: false, viewer: false }],
    ["projects:create", { owner: true, admin: true, member: false, viewer: false }],
    ["github:manage", { owner: true, admin: true, member: false, viewer: false }],
  ])("grants %s as expected", (action, expected) => {
    for (const role of ROLES) expect(workspaceRoleCan(role, action), role).toBe(expected[role]);
  });

  it("orders roles: each grants everything the next one down does", () => {
    for (let i = 0; i < ROLES.length - 1; i++) {
      for (const a of WORKSPACE_ACTIONS) {
        if (workspaceRoleCan(ROLES[i + 1]!, a))
          expect(workspaceRoleCan(ROLES[i]!, a), a).toBe(true);
      }
    }
  });
});

describe("projectRoleCan", () => {
  it.each<[ProjectAction, Record<ProjectRole, boolean>]>([
    ["projects:read", { project_admin: true, developer: true, deployer: true, viewer: true }],
    ["services:read", { project_admin: true, developer: true, deployer: true, viewer: true }],
    ["variables:read", { project_admin: true, developer: true, deployer: true, viewer: true }],
    [
      "variables:read_plain",
      { project_admin: true, developer: true, deployer: true, viewer: false },
    ],
    ["deployments:create", { project_admin: true, developer: true, deployer: true, viewer: false }],
    ["services:manage", { project_admin: true, developer: true, deployer: false, viewer: false }],
    ["variables:manage", { project_admin: true, developer: true, deployer: false, viewer: false }],
    ["projects:manage", { project_admin: true, developer: false, deployer: false, viewer: false }],
    ["access:manage", { project_admin: true, developer: false, deployer: false, viewer: false }],
  ])("grants %s as expected", (action, expected) => {
    for (const role of PROJECT_ROLES) {
      expect(projectRoleCan(role, action), role).toBe(expected[role]);
    }
  });

  it("orders project roles", () => {
    for (let i = 0; i < PROJECT_ROLES.length - 1; i++) {
      for (const a of PROJECT_ACTIONS) {
        if (projectRoleCan(PROJECT_ROLES[i + 1]!, a)) {
          expect(projectRoleCan(PROJECT_ROLES[i]!, a), a).toBe(true);
        }
      }
    }
  });
});

describe("can (coarse, default settings)", () => {
  it("matches the pre-0014 behaviour members relied on", () => {
    expect(can("member", "services:manage")).toBe(true);
    expect(can("member", "deployments:create")).toBe(true);
    expect(can("member", "variables:manage")).toBe(true);
    expect(can("member", "projects:manage")).toBe(false);
    expect(can("member", "nodes:manage")).toBe(false);
  });

  it("keeps viewers read-only and away from plain values", () => {
    expect(can("viewer", "nodes:read")).toBe(true);
    expect(can("viewer", "members:read")).toBe(false);
    expect(can("viewer", "variables:read")).toBe(true);
    expect(can("viewer", "variables:read_plain")).toBe(false);
  });

  it("never grants instance actions to a workspace role", () => {
    for (const role of ROLES) {
      for (const a of INSTANCE_ACTIONS) expect(can(role, a), `${role} ${a}`).toBe(false);
    }
  });

  it("grants owners every workspace and project action", () => {
    for (const a of [...WORKSPACE_ACTIONS, ...PROJECT_ACTIONS])
      expect(can("owner", a), a).toBe(true);
  });
});

describe("helpers", () => {
  it("validates role strings", () => {
    expect(isRole("admin")).toBe(true);
    expect(isRole("root")).toBe(false);
    expect(isRole(undefined)).toBe(false);
    expect(isProjectRole("deployer")).toBe(true);
    expect(isProjectRole("owner")).toBe(false);
  });

  it("picks the higher project role", () => {
    expect(maxProjectRole(null, null)).toBe(null);
    expect(maxProjectRole("viewer", null)).toBe("viewer");
    expect(maxProjectRole(null, "deployer")).toBe("deployer");
    expect(maxProjectRole("viewer", "developer")).toBe("developer");
    expect(maxProjectRole("project_admin", "deployer")).toBe("project_admin");
    for (const a of PROJECT_ROLES) {
      for (const b of PROJECT_ROLES) expect(maxProjectRole(a, b)).toBe(maxProjectRole(b, a));
    }
  });

  it("implies project roles from workspace roles and settings", () => {
    const s = DEFAULT_WORKSPACE_ACCESS_SETTINGS;
    expect(impliedProjectRole("owner", s)).toBe("project_admin");
    expect(impliedProjectRole("admin", s)).toBe("project_admin");
    expect(impliedProjectRole("member", s)).toBe("developer");
    expect(impliedProjectRole("viewer", s)).toBe("viewer");
    for (const m of MEMBER_DEFAULT_PROJECT_ROLES) {
      const role = impliedProjectRole("member", { ...s, memberDefaultProjectRole: m });
      expect(role).toBe(m === "none" ? null : m);
      // Admins are unaffected by the member default.
      expect(impliedProjectRole("admin", { ...s, memberDefaultProjectRole: m })).toBe(
        "project_admin",
      );
    }
    expect(impliedProjectRole("viewer", { ...s, viewerDefaultProjectRole: "none" })).toBe(null);
  });

  it("requires a second factor for privileged users only", () => {
    expect(isTwoFactorRequired(true, [])).toBe(true);
    expect(isTwoFactorRequired(false, ["member", "admin"])).toBe(true);
    expect(isTwoFactorRequired(false, ["owner"])).toBe(true);
    expect(isTwoFactorRequired(false, ["member", "viewer"])).toBe(false);
    expect(isTwoFactorRequired(false, [])).toBe(false);
  });
});

describe("resolveAccess: instance actions", () => {
  it("needs the instance-admin flag, whatever the workspace role", () => {
    for (const role of [...ROLES, null]) {
      const plain = resolveAccess(subject({ workspaceRole: role }), context());
      const admin = resolveAccess(subject({ workspaceRole: role, instanceAdmin: true }), context());
      for (const a of INSTANCE_ACTIONS) {
        expect(plain.check(a)).toMatchObject({ allowed: false, reason: "instance_admin_required" });
        expect(admin.can(a)).toBe(true);
      }
    }
  });

  it("gives instance admins nothing inside a workspace they don't belong to", () => {
    const access = resolveAccess(subject({ workspaceRole: null, instanceAdmin: true }), context());
    expect(access.check("workspace:read")).toMatchObject({ reason: "not_a_member" });
    expect(access.check("projects:read", { projectId: P1 })).toMatchObject({
      reason: "not_a_member",
    });
    expect(access.projectRole(P1)).toBe(null);
  });

  it("never lets an API token act on the instance", () => {
    const access = resolveAccess(
      subject({ instanceAdmin: true, tokenScopes: [...ACTIONS] }),
      context(),
    );
    expect(access.check("instance:manage")).toMatchObject({ reason: "token_scope" });
  });
});

describe("resolveAccess: workspace actions", () => {
  it("follows the workspace role and ignores project scope", () => {
    for (const role of ROLES) {
      const access = resolveAccess(subject({ workspaceRole: role }), context());
      for (const a of WORKSPACE_ACTIONS) {
        expect(access.can(a), `${role} ${a}`).toBe(workspaceRoleCan(role, a));
        expect(access.can(a, { projectId: P1 })).toBe(workspaceRoleCan(role, a));
      }
    }
  });

  it("denies non-members", () => {
    const access = resolveAccess(subject({ workspaceRole: null }), context());
    for (const a of WORKSPACE_ACTIONS) {
      expect(access.check(a)).toEqual({
        allowed: false,
        reason: "not_a_member",
        projectRole: null,
      });
    }
  });

  it("is not widened by project grants", () => {
    const access = resolveAccess(
      subject({ workspaceRole: "viewer" }),
      context({
        grants: [
          { projectId: P1, principal: { type: "user", id: "usr_me" }, role: "project_admin" },
        ],
      }),
    );
    expect(access.check("members:manage")).toMatchObject({ reason: "workspace_role" });
  });
});

describe("resolveAccess: project roles", () => {
  it("requires a project or environment in scope", () => {
    const access = resolveAccess(subject(), context());
    expect(access.check("projects:read")).toMatchObject({ reason: "scope_required" });
    expect(access.can("projects:read", { environmentId: STAGING })).toBe(true);
  });

  it("derives the project from the environment and rejects mismatches", () => {
    const access = resolveAccess(subject(), context());
    expect(access.check("services:read", { projectId: P2, environmentId: STAGING })).toMatchObject({
      reason: "environment_mismatch",
    });
    expect(access.check("services:read", { environmentId: "env_missing" })).toMatchObject({
      reason: "unknown_environment",
    });
  });

  it("uses the implied role when there are no grants", () => {
    const owner = resolveAccess(subject({ workspaceRole: "owner" }), context());
    const member = resolveAccess(subject(), context());
    const viewer = resolveAccess(subject({ workspaceRole: "viewer" }), context());
    expect(owner.projectRole(P1)).toBe("project_admin");
    expect(member.projectRole(P1)).toBe("developer");
    expect(viewer.projectRole(P1)).toBe("viewer");
    expect(viewer.check("deployments:create", { projectId: P1 })).toEqual({
      allowed: false,
      reason: "project_role",
      projectRole: "viewer",
    });
  });

  it("hides projects from members when the default is none", () => {
    const access = resolveAccess(
      subject(),
      context({
        settings: { ...DEFAULT_WORKSPACE_ACCESS_SETTINGS, memberDefaultProjectRole: "none" },
      }),
    );
    expect(access.projectRole(P1)).toBe(null);
    expect(access.check("projects:read", { projectId: P1 })).toMatchObject({
      reason: "no_project_access",
    });
  });

  it("takes the highest of implied, direct and team grants, per project", () => {
    const access = resolveAccess(
      subject({ teamIds: ["team_ops", "team_web"] }),
      context({
        settings: { memberDefaultProjectRole: "viewer", viewerDefaultProjectRole: "none" },
        grants: [
          { projectId: P1, principal: { type: "user", id: "usr_me" }, role: "deployer" },
          { projectId: P1, principal: { type: "team", id: "team_web" }, role: "developer" },
          { projectId: P1, principal: { type: "team", id: "team_other" }, role: "project_admin" },
          { projectId: P1, principal: { type: "user", id: "usr_other" }, role: "project_admin" },
          { projectId: P2, principal: { type: "team", id: "team_ops" }, role: "project_admin" },
        ],
      }),
    );
    expect(access.projectRole(P1)).toBe("developer");
    expect(access.projectRole(P2)).toBe("project_admin");
    expect(access.projectRole("prj_3")).toBe("viewer");
    expect(access.can("access:manage", { projectId: P1 })).toBe(false);
    expect(access.can("access:manage", { projectId: P2 })).toBe(true);
  });

  it("never lowers the implied role with a weaker grant", () => {
    const access = resolveAccess(
      subject({ workspaceRole: "admin" }),
      context({
        grants: [{ projectId: P1, principal: { type: "user", id: "usr_me" }, role: "viewer" }],
      }),
    );
    expect(access.projectRole(P1)).toBe("project_admin");
  });

  it("lets grants lift a workspace viewer on one project", () => {
    const access = resolveAccess(
      subject({ workspaceRole: "viewer" }),
      context({
        settings: { ...DEFAULT_WORKSPACE_ACCESS_SETTINGS, viewerDefaultProjectRole: "none" },
        grants: [{ projectId: P2, principal: { type: "user", id: "usr_me" }, role: "developer" }],
      }),
    );
    expect(access.can("services:manage", { projectId: P2 })).toBe(true);
    expect(access.can("projects:read", { projectId: P1 })).toBe(false);
  });

  it("agrees with projectRoleCan for every role and unprotected action", () => {
    for (const role of PROJECT_ROLES) {
      const access = resolveAccess(
        subject({ workspaceRole: "viewer" }),
        context({
          settings: { ...DEFAULT_WORKSPACE_ACCESS_SETTINGS, viewerDefaultProjectRole: "none" },
          grants: [{ projectId: P1, principal: { type: "user", id: "usr_me" }, role }],
        }),
      );
      for (const a of PROJECT_ACTIONS) {
        expect(access.can(a, { projectId: P1 }), `${role} ${a}`).toBe(projectRoleCan(role, a));
        expect(access.can(a, { environmentId: STAGING }), `${role} ${a} staging`).toBe(
          projectRoleCan(role, a),
        );
      }
    }
  });
});

describe("resolveAccess: environment protection", () => {
  const asRole = (
    role: ProjectRole,
    over: Partial<AccessSubject> = {},
    ctx: Partial<AccessContext> = {},
  ) =>
    resolveAccess(
      subject({ workspaceRole: "viewer", ...over }),
      context({
        settings: { ...DEFAULT_WORKSPACE_ACCESS_SETTINGS, viewerDefaultProjectRole: "none" },
        grants: [{ projectId: P1, principal: { type: "user", id: "usr_me" }, role }],
        ...ctx,
      }),
    );

  it.each<[ProjectRole, Record<(typeof ENVIRONMENT_ACTIONS)[number], boolean>]>([
    [
      "project_admin",
      { "deployments:create": true, "services:manage": true, "variables:manage": true },
    ],
    [
      "developer",
      { "deployments:create": true, "services:manage": true, "variables:manage": false },
    ],
    [
      "deployer",
      { "deployments:create": true, "services:manage": false, "variables:manage": false },
    ],
    [
      "viewer",
      { "deployments:create": false, "services:manage": false, "variables:manage": false },
    ],
  ])("applies the default rules to %s in a protected environment", (role, expected) => {
    const access = asRole(role);
    for (const a of ENVIRONMENT_ACTIONS) {
      expect(access.can(a, { environmentId: PROD }), a).toBe(expected[a]);
      // Unprotected environments only check the project role.
      expect(access.can(a, { environmentId: STAGING }), `${a} staging`).toBe(
        projectRoleCan(role, a),
      );
    }
  });

  it("reports environment_protected only when the role itself would allow it", () => {
    expect(asRole("developer").check("variables:manage", { environmentId: PROD })).toEqual({
      allowed: false,
      reason: "environment_protected",
      projectRole: "developer",
    });
    expect(asRole("deployer").check("variables:manage", { environmentId: PROD })).toMatchObject({
      reason: "project_role",
    });
  });

  it("ignores rules when the environment isn't protected", () => {
    const access = asRole("developer", {}, { protections: protections(false) });
    expect(access.can("variables:manage", { environmentId: PROD })).toBe(true);
  });

  it("doesn't restrict reads", () => {
    const access = asRole("deployer");
    expect(access.can("variables:read_plain", { environmentId: PROD })).toBe(true);
    expect(access.can("services:read", { environmentId: PROD })).toBe(true);
  });

  it("only narrows: listing a user doesn't grant what their role lacks", () => {
    const rules = {
      ...DEFAULT_PROTECTION_RULES,
      variables: { roles: [], userIds: ["usr_me"], teamIds: [] },
    };
    const ctx = {
      protections: [{ environmentId: PROD, projectId: P1, protected: true, rules }],
    };
    expect(asRole("developer", {}, ctx).can("variables:manage", { environmentId: PROD })).toBe(
      true,
    );
    expect(asRole("deployer", {}, ctx).can("variables:manage", { environmentId: PROD })).toBe(
      false,
    );
  });

  it("admits listed teams and users, and project admins always", () => {
    const rules = {
      deploy: { roles: [], userIds: ["usr_release"], teamIds: ["team_release"] },
      config: { roles: [], userIds: [], teamIds: [] },
      variables: { roles: [], userIds: [], teamIds: [] },
    };
    const ctx = { protections: [{ environmentId: PROD, projectId: P1, protected: true, rules }] };
    expect(asRole("developer", {}, ctx).can("deployments:create", { environmentId: PROD })).toBe(
      false,
    );
    expect(
      asRole("developer", { teamIds: ["team_release"] }, ctx).can("deployments:create", {
        environmentId: PROD,
      }),
    ).toBe(true);
    expect(
      asRole(
        "deployer",
        { userId: "usr_release" },
        {
          ...ctx,
          grants: [
            { projectId: P1, principal: { type: "user", id: "usr_release" }, role: "deployer" },
          ],
        },
      ).can("deployments:create", { environmentId: PROD }),
    ).toBe(true);
    expect(asRole("project_admin", {}, ctx).can("variables:manage", { environmentId: PROD })).toBe(
      true,
    );
  });

  it("checks project actions without an environment as unprotected", () => {
    expect(asRole("developer").can("variables:manage", { projectId: P1 })).toBe(true);
  });
});

describe("resolveAccess: API tokens", () => {
  it("allows only scoped actions the creator can do", () => {
    const scopes: Action[] = ["projects:read", "deployments:create", "members:manage"];
    const access = resolveAccess(subject({ tokenScopes: scopes }), context());
    expect(access.can("deployments:create", { projectId: P1 })).toBe(true);
    expect(access.check("services:manage", { projectId: P1 })).toMatchObject({
      reason: "token_scope",
    });
    // In scope, but the member creating it can't manage members.
    expect(access.check("members:manage")).toMatchObject({ reason: "workspace_role" });
  });

  it("is still bound by environment protection", () => {
    const access = resolveAccess(subject({ tokenScopes: ["variables:manage"] }), context());
    expect(access.check("variables:manage", { environmentId: PROD })).toMatchObject({
      reason: "environment_protected",
    });
  });

  it("treats an empty scope list as no access, and null as a session", () => {
    expect(resolveAccess(subject({ tokenScopes: [] }), context()).can("workspace:read")).toBe(
      false,
    );
    expect(resolveAccess(subject({ tokenScopes: null }), context()).can("workspace:read")).toBe(
      true,
    );
  });
});
