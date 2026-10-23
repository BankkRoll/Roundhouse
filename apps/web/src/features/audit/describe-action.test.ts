import {
  ActivityIcon,
  Building2Icon,
  KeyRoundIcon,
  ServerIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import { describe, expect, it } from "vitest";
import { makeAuditEntry, USERS } from "../../mocks/db";
import { actorLabel, describeAction } from "./describe-action";

const byOwner = { actor_type: "user", actor_id: USERS.owner.id, actor_name: USERS.owner.name };

describe("describeAction", () => {
  it("drops the target when a node reports its own joining", () => {
    expect(describeAction(makeAuditEntry())).toEqual({
      verb: "connected",
      target: null,
      icon: ServerIcon,
    });
  });

  it("names the target from metadata", () => {
    const result = describeAction(
      makeAuditEntry({ ...byOwner, action: "node.removed", metadata: { name: "hel-1" } }),
    );
    expect(result).toEqual({ verb: "removed server", target: "hel-1", icon: ServerIcon });
  });

  it("uses the invitee email for invites", () => {
    const result = describeAction(
      makeAuditEntry({
        ...byOwner,
        action: "invite.created",
        target_type: "invite",
        target_id: "inv_1",
        metadata: { email: "erin@example.com", role: "member" },
      }),
    );
    expect(result).toMatchObject({
      verb: "invited",
      target: "erin@example.com",
      icon: UserPlusIcon,
    });
  });

  it("shows a role change as from → to instead of the membership id", () => {
    const result = describeAction(
      makeAuditEntry({
        ...byOwner,
        action: "member.role_changed",
        target_type: "member",
        target_id: "mem_cara",
        metadata: { from: "member", to: "admin", user_id: USERS.member.id },
      }),
    );
    expect(result).toEqual({
      verb: "changed a member's role",
      target: "member → admin",
      icon: UsersIcon,
    });
  });

  it.each([
    [
      "invite.accepted",
      { target_type: "invite", target_id: "inv_1", metadata: { role: "viewer" } },
      "joined via invite",
      "as viewer",
    ],
    [
      "node.went_offline",
      {
        actor_type: "system",
        actor_id: null,
        actor_name: null,
        target_type: "node",
        target_id: "node_hel1",
        metadata: { silent_for_ms: 31_000 },
      },
      "lost contact with a server",
      null,
    ],
    [
      "node.join_token_created",
      { target_type: "join_token", target_id: "njt_01J9", metadata: null },
      "created a join token",
      null,
    ],
    [
      "member.left",
      {
        target_type: "member",
        target_id: "mem_cara",
        metadata: { user_id: USERS.member.id, email: USERS.member.email },
      },
      "left the workspace",
      null,
    ],
  ] as const)("never shows raw ids for %s", (action, overrides, verb, target) => {
    const result = describeAction(makeAuditEntry({ ...byOwner, ...overrides, action }));
    expect(result.verb).toBe(verb);
    expect(result.target).toBe(target);
  });

  it("drops the target for self-describing workspace actions", () => {
    const result = describeAction(
      makeAuditEntry({
        ...byOwner,
        action: "workspace.created",
        target_type: "workspace",
        target_id: "ws_1",
        metadata: null,
      }),
    );
    expect(result).toEqual({ verb: "created the workspace", target: null, icon: Building2Icon });
  });

  it("shows the new name for renames", () => {
    const result = describeAction(
      makeAuditEntry({
        ...byOwner,
        action: "workspace.renamed",
        target_type: "workspace",
        target_id: "ws_1",
        metadata: { name: "Acme Robotics" },
      }),
    );
    expect(result).toMatchObject({ verb: "renamed the workspace to", target: "Acme Robotics" });
  });

  it("humanises unknown actions and uses a generic icon", () => {
    const result = describeAction(
      makeAuditEntry({
        ...byOwner,
        action: "deploy.rolled_back",
        target_type: "deployment",
        target_id: "dep_1",
        metadata: { name: "api@v42" },
      }),
    );
    expect(result).toEqual({ verb: "deploy rolled back", target: "api@v42", icon: ActivityIcon });
  });

  it("never falls back to the target id", () => {
    const result = describeAction(
      makeAuditEntry({ ...byOwner, action: "deploy.started", target_id: "dep_9", metadata: null }),
    );
    expect(result.target).toBeNull();
  });

  it("picks the icon from the target type, then the action prefix", () => {
    expect(
      describeAction(
        makeAuditEntry({ action: "node.join_token_created", target_type: "join_token" }),
      ).icon,
    ).toBe(KeyRoundIcon);
    expect(describeAction(makeAuditEntry({ action: "node.removed", target_type: null })).icon).toBe(
      ServerIcon,
    );
  });

  it("labels API token and environment resolution entries", () => {
    expect(
      describeAction(
        makeAuditEntry({
          ...byOwner,
          action: "token.created",
          target_type: "api_token",
          target_id: "tok_1",
          metadata: { name: "ci-deploy", scopes: ["projects:read"] },
        }),
      ),
    ).toEqual({ verb: "created API token", target: "ci-deploy", icon: KeyRoundIcon });
    expect(
      describeAction(
        makeAuditEntry({
          ...byOwner,
          action: "token.revoked",
          target_type: "api_token",
          metadata: { name: "ci-deploy" },
        }),
      ),
    ).toMatchObject({ verb: "revoked API token", target: "ci-deploy" });
    expect(
      describeAction(
        makeAuditEntry({ ...byOwner, action: "variables.resolved", metadata: { keys: ["A"] } }),
      ).verb,
    ).toBe("resolved the environment of");
    expect(
      describeAction(
        makeAuditEntry({
          ...byOwner,
          action: "github.installation_rejected",
          metadata: { reason: "installation_not_accessible" },
        }),
      ),
    ).toMatchObject({
      verb: "was refused a GitHub App installation",
      target: "(installation not accessible)",
    });
  });

  it("ignores non-string metadata values", () => {
    expect(
      describeAction(makeAuditEntry({ ...byOwner, action: "node.removed", metadata: { name: 42 } }))
        .target,
    ).toBeNull();
  });
});

describe("actorLabel", () => {
  it("prefers the actor name, then id, then type", () => {
    expect(actorLabel(makeAuditEntry({ actor_name: "Ada" }))).toBe("Ada");
    expect(actorLabel(makeAuditEntry({ actor_name: null, actor_id: "usr_1" }))).toBe("usr_1");
    expect(
      actorLabel(makeAuditEntry({ actor_name: null, actor_id: null, actor_type: "system" })),
    ).toBe("system");
  });

  it("marks API tokens so they aren't mistaken for people", () => {
    expect(actorLabel(makeAuditEntry({ actor_type: "token", actor_name: "ci-deploy" }))).toBe(
      "ci-deploy (API token)",
    );
    expect(actorLabel(makeAuditEntry({ actor_type: "token", actor_name: null }))).toBe("API token");
  });
});
