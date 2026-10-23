import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashToken } from "../src/lib/crypto";
import {
  addMember,
  beforeStatement,
  type Client,
  call,
  client,
  failStatement,
  install,
  inviteToken,
  joinNode,
  lookupInvite,
  ORIGIN,
} from "./helpers";

type Member = { id: string; user_id: string; email: string; role: string };

describe("workspaces", () => {
  it("requires a session", async () => {
    expect((await call("/v1/me")).status).toBe(401);
    expect((await call("/v1/workspaces", { method: "POST", json: { name: "x" } })).status).toBe(
      401,
    );
  });

  it("creates additional workspaces with unique slugs", async () => {
    const { owner } = await install();
    const a = await owner.json<{ slug: string; role: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Nightjar Labs" },
    });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ slug: "nightjar-labs-2", role: "owner" });
  });

  it("renames a workspace and audits it", async () => {
    const { owner, workspaceId } = await install();
    const res = await owner.json<{ name: string }>(`/v1/workspaces/${workspaceId}`, {
      method: "PATCH",
      json: { name: "Renamed" },
    });
    expect(res.body.name).toBe("Renamed");
    const audit = await owner.json<{ items: { action: string }[] }>(
      `/v1/workspaces/${workspaceId}/audit-logs`,
    );
    expect(audit.body.items.map((i) => i.action)).toContain("workspace.renamed");
  });

  it("hides workspaces from non-members with a 404", async () => {
    const { owner, workspaceId } = await install();
    const other = await owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Private" },
    });
    const outsider = await addMember(owner, workspaceId, "outsider@example.com", "member");
    const res = await outsider.json(`/v1/workspaces/${other.body.id}`);
    expect(res.status).toBe(404);
    expect((await outsider.json(`/v1/workspaces/${other.body.id}/nodes`)).status).toBe(404);
  });
});

describe("invites", () => {
  it("lets an invitee create an account and join with the invited role", async () => {
    const { owner, workspaceId } = await install();
    const viewer = await addMember(owner, workspaceId, "priya@example.com", "viewer");
    const me = await viewer.json<{ workspaces: { id: string; role: string }[] }>("/v1/me");
    expect(me.body.workspaces).toEqual([
      expect.objectContaining({ id: workspaceId, role: "viewer" }),
    ]);
  });

  it("previews invites publicly and normalises email case", async () => {
    const { owner, workspaceId } = await install();
    const { body } = await owner.json<{ url: string }>(`/v1/workspaces/${workspaceId}/invites`, {
      method: "POST",
      json: { email: "Jonas@Example.com", role: "member" },
    });
    const token = inviteToken(body.url);
    const preview = await lookupInvite(token);
    expect(await preview.json()).toMatchObject({
      workspace_name: "Nightjar Labs",
      email: "jonas@example.com",
      role: "member",
    });
  });

  it("cannot be redeemed twice", async () => {
    const { owner, workspaceId } = await install();
    const { body } = await owner.json<{ url: string }>(`/v1/workspaces/${workspaceId}/invites`, {
      method: "POST",
      json: { email: "once@example.com", role: "member" },
    });
    const token = inviteToken(body.url);
    const accept = () =>
      call("/v1/invites/accept", {
        method: "POST",
        json: { token, name: "Once", password: "a perfectly fine password" },
      });
    const results = await Promise.all([accept(), accept()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, expect.any(Number)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it("refuses a signed-in user whose email doesn't match", async () => {
    const { owner, workspaceId } = await install();
    const { body } = await owner.json<{ url: string }>(`/v1/workspaces/${workspaceId}/invites`, {
      method: "POST",
      json: { email: "someone-else@example.com", role: "admin" },
    });
    const token = inviteToken(body.url);
    const res = await owner.json("/v1/invites/accept", { method: "POST", json: { token } });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "email_mismatch" } });
  });

  it("rejects unknown and revoked tokens", async () => {
    const { owner, workspaceId } = await install();
    expect((await lookupInvite("inv_bogus")).status).toBe(404);
    const created = await owner.json<{ invite: { id: string }; url: string }>(
      `/v1/workspaces/${workspaceId}/invites`,
      { method: "POST", json: { email: "revoked@example.com", role: "member" } } as RequestInit,
    );
    const del = await owner.request(
      `/v1/workspaces/${workspaceId}/invites/${created.body.invite.id}`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(204);
    const token = inviteToken(created.body.url);
    expect((await lookupInvite(token)).status).toBe(404);
  });

  it("puts the token in the link's fragment, never its path or query", async () => {
    const { owner, workspaceId } = await install();
    const { body } = await owner.json<{ url: string }>(`/v1/workspaces/${workspaceId}/invites`, {
      method: "POST",
      json: { email: "frag@example.com", role: "member" },
    });
    const url = new URL(body.url);
    expect(url.pathname).toBe("/invite");
    expect(url.search).toBe("");
    expect(url.hash).toMatch(/^#token=inv_[\w-]+$/);
    expect(url.origin).toBe(new URL(ORIGIN).origin);
    // The path-token routes are gone, so a token can't be sent in a URL by mistake.
    const token = inviteToken(body.url);
    expect((await call(`/v1/invites/${token}`)).status).toBe(404);
    expect((await call(`/v1/invites/${token}/accept`, { method: "POST", json: {} })).status).toBe(
      404,
    );
    expect((await lookupInvite(token)).status).toBe(200);
  });

  it("refuses a replayed token and audits the refusal without the token", async () => {
    const { owner, workspaceId } = await install();
    const { body } = await owner.json<{ url: string }>(`/v1/workspaces/${workspaceId}/invites`, {
      method: "POST",
      json: { email: "replay@example.com", role: "member" },
    });
    const token = inviteToken(body.url);
    const accept = () =>
      call("/v1/invites/accept", {
        method: "POST",
        json: { token, name: "Replay", password: "a perfectly fine password" },
      });
    expect((await accept()).status).toBe(200);
    const again = await accept();
    expect(again.status).toBe(404);
    expect((await lookupInvite(token)).status).toBe(404);

    const rows = await env.DB.prepare(
      "SELECT workspace_id, action, target_type, metadata FROM audit_logs WHERE action LIKE 'invite.%' ORDER BY seq",
    ).all<{ workspace_id: string | null; action: string; metadata: string }>();
    expect(rows.results.map((r) => r.action)).toEqual([
      "invite.created",
      "invite.accepted",
      "invite.rejected_token",
      "invite.rejected_token",
    ]);
    const rejected = rows.results.filter((r) => r.action === "invite.rejected_token");
    expect(rejected.map((r) => [r.workspace_id, JSON.parse(r.metadata)])).toEqual([
      [workspaceId, { reason: "used", stage: "accept", email: "replay@example.com" }],
      [workspaceId, { reason: "used", stage: "lookup", email: "replay@example.com" }],
    ]);
    const everything = await env.DB.prepare("SELECT * FROM audit_logs").all();
    const dump = JSON.stringify(everything.results);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(await hashToken(token));
  });

  it("refuses an expired token for lookup and accept", async () => {
    const { owner, workspaceId } = await install();
    const { body } = await owner.json<{ url: string; invite: { id: string } }>(
      `/v1/workspaces/${workspaceId}/invites`,
      { method: "POST", json: { email: "late@example.com", role: "member" } },
    );
    await env.DB.prepare("UPDATE invites SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, body.invite.id)
      .run();
    const token = inviteToken(body.url);
    expect((await lookupInvite(token)).status).toBe(404);
    const res = await call("/v1/invites/accept", {
      method: "POST",
      json: { token, name: "Late", password: "a perfectly fine password" },
    });
    expect(res.status).toBe(404);
    const users = await env.DB.prepare(
      "SELECT count(*) AS n FROM users WHERE email = 'late@example.com'",
    ).first<{ n: number }>();
    expect(users!.n).toBe(0);
    const reasons = await env.DB.prepare(
      "SELECT workspace_id, json_extract(metadata, '$.reason') AS reason FROM audit_logs WHERE action = 'invite.rejected_token'",
    ).all<{ workspace_id: string; reason: string }>();
    expect(reasons.results).toEqual([
      { workspace_id: workspaceId, reason: "expired" },
      { workspace_id: workspaceId, reason: "expired" },
    ]);
  });

  it("audits unknown tokens at instance level", async () => {
    await install();
    expect((await lookupInvite("inv_never_issued")).status).toBe(404);
    const row = await env.DB.prepare(
      "SELECT workspace_id, actor_id, target_id, metadata FROM audit_logs WHERE action = 'invite.rejected_token'",
    ).first<{ workspace_id: string | null; actor_id: string | null; metadata: string }>();
    expect(row).toMatchObject({ workspace_id: null, actor_id: null, target_id: null });
    expect(JSON.parse(row!.metadata)).toEqual({ reason: "unknown", stage: "lookup" });
    expect(row!.metadata).not.toContain("inv_never_issued");
  });

  it("rate-limits the token routes per IP", async () => {
    const { owner, workspaceId } = await install();
    const { body } = await owner.json<{ url: string }>(`/v1/workspaces/${workspaceId}/invites`, {
      method: "POST",
      json: { email: "limited@example.com", role: "member" },
    });
    const token = inviteToken(body.url);
    const buckets: string[] = [];
    (env as { AUTH_LIMITER?: RateLimit }).AUTH_LIMITER = {
      limit: async ({ key }) => {
        buckets.push(key);
        return { success: false };
      },
    };
    expect((await lookupInvite(token)).status).toBe(429);
    const accepted = await call("/v1/invites/accept", {
      method: "POST",
      json: { token, name: "Limited", password: "a perfectly fine password" },
    });
    expect(accepted.status).toBe(429);
    expect(buckets.every((k) => k.startsWith("invite:"))).toBe(true);
    expect(buckets).toHaveLength(2);
  });

  it("doesn't let admins mint owners", async () => {
    const { owner, workspaceId } = await install();
    const admin = await addMember(owner, workspaceId, "admin@example.com", "admin");
    const res = await admin.json(`/v1/workspaces/${workspaceId}/invites`, {
      method: "POST",
      json: { email: "new-owner@example.com", role: "owner" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects inviting an existing member", async () => {
    const { owner, workspaceId } = await install();
    const res = await owner.json(`/v1/workspaces/${workspaceId}/invites`, {
      method: "POST",
      json: { email: "MARA@example.com", role: "member" },
    });
    expect(res.status).toBe(409);
  });
});

describe("members", () => {
  it("lists members with profiles", async () => {
    const { owner, workspaceId } = await install();
    await addMember(owner, workspaceId, "jonas@example.com", "member");
    const res = await owner.json<{ members: Member[] }>(`/v1/workspaces/${workspaceId}/members`);
    expect(res.body.members.map((m) => [m.email, m.role])).toEqual([
      ["mara@example.com", "owner"],
      ["jonas@example.com", "member"],
    ]);
  });

  it("enforces role permissions", async () => {
    const { owner, workspaceId } = await install();
    const viewer = await addMember(owner, workspaceId, "viewer@example.com", "viewer");
    const member = await addMember(owner, workspaceId, "member@example.com", "member");

    expect((await viewer.json(`/v1/workspaces/${workspaceId}/members`)).status).toBe(403);
    expect((await member.json(`/v1/workspaces/${workspaceId}/members`)).status).toBe(200);
    expect(
      (
        await member.json(`/v1/workspaces/${workspaceId}/invites`, {
          method: "POST",
          json: { email: "x@example.com", role: "viewer" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await member.json(`/v1/workspaces/${workspaceId}`, {
          method: "PATCH",
          json: { name: "hijack" },
        })
      ).status,
    ).toBe(403);
  });

  it("never leaves a workspace without an owner", async () => {
    const { owner, workspaceId, userId } = await install();
    const { body } = await owner.json<{ members: Member[] }>(
      `/v1/workspaces/${workspaceId}/members`,
    );
    const self = body.members.find((m) => m.user_id === userId)!;

    const demote = await owner.json(`/v1/workspaces/${workspaceId}/members/${self.id}`, {
      method: "PATCH",
      json: { role: "admin" },
    });
    expect(demote.status).toBe(409);
    expect(demote.body).toMatchObject({ error: { code: "last_owner" } });

    const leave = await owner.request(`/v1/workspaces/${workspaceId}/members/${self.id}`, {
      method: "DELETE",
    });
    expect(leave.status).toBe(409);
  });

  it("stops admins from touching owners", async () => {
    const { owner, workspaceId, userId } = await install();
    const admin = await addMember(owner, workspaceId, "admin@example.com", "admin");
    const { body } = await owner.json<{ members: Member[] }>(
      `/v1/workspaces/${workspaceId}/members`,
    );
    const ownerRow = body.members.find((m) => m.user_id === userId)!;

    expect(
      (
        await admin.json(`/v1/workspaces/${workspaceId}/members/${ownerRow.id}`, {
          method: "PATCH",
          json: { role: "viewer" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await admin.request(`/v1/workspaces/${workspaceId}/members/${ownerRow.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(403);
  });

  it("lets members leave on their own", async () => {
    const { owner, workspaceId } = await install();
    const viewer = await addMember(owner, workspaceId, "leaver@example.com", "viewer");
    const { body } = await owner.json<{ members: Member[] }>(
      `/v1/workspaces/${workspaceId}/members`,
    );
    const row = body.members.find((m) => m.email === "leaver@example.com")!;
    expect(
      (
        await viewer.request(`/v1/workspaces/${workspaceId}/members/${row.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    const me = await viewer.json<{ workspaces: unknown[] }>("/v1/me");
    expect(me.body.workspaces).toEqual([]);
  });

  it("promotes and demotes with an audit trail", async () => {
    const { owner, workspaceId } = await install();
    await addMember(owner, workspaceId, "jonas@example.com", "member");
    const { body } = await owner.json<{ members: Member[] }>(
      `/v1/workspaces/${workspaceId}/members`,
    );
    const jonas = body.members.find((m) => m.email === "jonas@example.com")!;
    const res = await owner.json<Member>(`/v1/workspaces/${workspaceId}/members/${jonas.id}`, {
      method: "PATCH",
      json: { role: "admin" },
    });
    expect(res.body.role).toBe("admin");

    const audit = await owner.json<{ items: { action: string; metadata: unknown }[] }>(
      `/v1/workspaces/${workspaceId}/audit-logs`,
    );
    expect(audit.body.items[0]).toMatchObject({
      action: "member.role_changed",
      metadata: { from: "member", to: "admin" },
    });
  });
});

describe("audit log", () => {
  it("paginates newest-first with a cursor", async () => {
    const { owner, workspaceId } = await install();
    for (let i = 0; i < 5; i++) {
      await owner.json(`/v1/workspaces/${workspaceId}`, {
        method: "PATCH",
        json: { name: `Name ${i}` },
      });
    }
    type Page = { items: { id: string; actor_name: string | null }[]; next_cursor: string | null };
    const first = await owner.json<Page>(`/v1/workspaces/${workspaceId}/audit-logs?limit=4`);
    expect(first.body.items).toHaveLength(4);
    expect(first.body.items[0]!.actor_name).toBe("Mara Okafor");
    expect(first.body.next_cursor).toBe(first.body.items[3]!.id);

    const second = await owner.json<Page>(
      `/v1/workspaces/${workspaceId}/audit-logs?limit=4&cursor=${first.body.next_cursor}`,
    );
    // Five renames; setup is recorded at instance level, not in the workspace.
    expect(second.body.items).toHaveLength(1);
    expect(second.body.next_cursor).toBeNull();
    const all = [...first.body.items, ...second.body.items].map((i) => i.id);
    expect([...all].sort().reverse()).toEqual(all);
  });

  it("is hidden from members without audit:read", async () => {
    const { owner, workspaceId } = await install();
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    expect((await member.json(`/v1/workspaces/${workspaceId}/audit-logs`)).status).toBe(403);
  });

  it("rejects a bogus session cookie", async () => {
    await install();
    const forged = client("better-auth.session_token=forged.value");
    expect((await forged.json("/v1/me")).status).toBe(401);
  });
});

describe("concurrent workspace creation", () => {
  it("gives every same-named workspace its own slug instead of failing", async () => {
    const { owner } = await install();
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        owner.json<{ slug: string }>("/v1/workspaces", { method: "POST", json: { name: "Race" } }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    const slugs = results.map((r) => r.body.slug);
    expect(new Set(slugs).size).toBe(5);
    for (const slug of slugs) expect(slug).toMatch(/^race(-[a-z0-9]+)?$/);
  });
});

describe("cross-workspace IDs", () => {
  async function twoWorkspaces() {
    const installed = await install();
    const { owner, workspaceId: a } = installed;
    const { body: b } = await owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Other" },
    });
    return { ...installed, a, b: b.id };
  }

  it("404s a member of workspace B addressed through workspace A", async () => {
    const { owner, a, b } = await twoWorkspaces();
    await addMember(owner, b, "bee@example.com", "member");
    const { body } = await owner.json<{ members: Member[] }>(`/v1/workspaces/${b}/members`);
    const bee = body.members.find((m) => m.email === "bee@example.com")!;

    const patch = await owner.json(`/v1/workspaces/${a}/members/${bee.id}`, {
      method: "PATCH",
      json: { role: "viewer" },
    });
    expect(patch.status).toBe(404);
    const del = await owner.request(`/v1/workspaces/${a}/members/${bee.id}`, { method: "DELETE" });
    expect(del.status).toBe(404);
    const after = await owner.json<{ members: Member[] }>(`/v1/workspaces/${b}/members`);
    expect(after.body.members.find((m) => m.id === bee.id)?.role).toBe("member");
  });

  it("404s an invite of workspace B revoked through workspace A", async () => {
    const { owner, a, b } = await twoWorkspaces();
    const { body } = await owner.json<{ invite: { id: string } }>(`/v1/workspaces/${b}/invites`, {
      method: "POST",
      json: { email: "pending@example.com", role: "member" },
    });
    const res = await owner.request(`/v1/workspaces/${a}/invites/${body.invite.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    const list = await owner.json<{ invites: unknown[] }>(`/v1/workspaces/${b}/invites`);
    expect(list.body.invites).toHaveLength(1);
  });

  it("404s a node of workspace B read or removed through workspace A", async () => {
    const { owner, a, b } = await twoWorkspaces();
    const joined = await joinNode(owner, b);
    expect((await owner.json(`/v1/workspaces/${a}/nodes/${joined.node_id}`)).status).toBe(404);
    const del = await owner.request(`/v1/workspaces/${a}/nodes/${joined.node_id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(404);
    expect((await owner.json(`/v1/workspaces/${b}/nodes/${joined.node_id}`)).status).toBe(200);
  });
});

describe("admin vs owner race", () => {
  async function adminAndTarget() {
    const { owner, workspaceId } = await install();
    const admin = await addMember(owner, workspaceId, "admin@example.com", "admin");
    await addMember(owner, workspaceId, "target@example.com", "member");
    const { body } = await owner.json<{ members: Member[] }>(
      `/v1/workspaces/${workspaceId}/members`,
    );
    const target = body.members.find((m) => m.email === "target@example.com")!;
    const promote = (db: D1Database) =>
      db.prepare("UPDATE workspace_members SET role = 'owner' WHERE id = ?").bind(target.id).run();
    const roleOf = async () =>
      (
        await env.DB.prepare("SELECT role FROM workspace_members WHERE id = ?")
          .bind(target.id)
          .first<{ role: string }>()
      )?.role;
    return { admin, workspaceId, target, promote, roleOf };
  }

  it("won't let an admin demote someone promoted to owner mid-request", async () => {
    const { admin, workspaceId, target, promote, roleOf } = await adminAndTarget();
    const restore = beforeStatement(/^update "workspace_members"/, promote);
    try {
      const res = await admin.json(`/v1/workspaces/${workspaceId}/members/${target.id}`, {
        method: "PATCH",
        json: { role: "viewer" },
      });
      expect(res.status).toBe(403);
    } finally {
      restore();
    }
    expect(await roleOf()).toBe("owner");
  });

  it("won't let an admin remove someone promoted to owner mid-request", async () => {
    const { admin, workspaceId, target, promote, roleOf } = await adminAndTarget();
    const restore = beforeStatement(/^delete from "workspace_members"/, promote);
    try {
      const res = await admin.request(`/v1/workspaces/${workspaceId}/members/${target.id}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(403);
    } finally {
      restore();
    }
    expect(await roleOf()).toBe("owner");
  });
});

describe("invite edge cases", () => {
  async function invite(owner: Client, workspaceId: string, email: string, role = "member") {
    const res = await owner.json<{ url: string; invite: { id: string } }>(
      `/v1/workspaces/${workspaceId}/invites`,
      { method: "POST", json: { email, role } },
    );
    return { ...res, token: res.body.url ? inviteToken(res.body.url) : undefined };
  }

  it("rejects a second pending invite for the same address", async () => {
    const { owner, workspaceId } = await install();
    expect((await invite(owner, workspaceId, "dup@example.com")).status).toBe(201);
    const again = await invite(owner, workspaceId, "DUP@example.com", "admin");
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { code: "conflict" } });
  });

  it("allows a fresh invite once the previous one expired", async () => {
    const { owner, workspaceId } = await install();
    await invite(owner, workspaceId, "late@example.com");
    await env.DB.prepare("UPDATE invites SET expires_at = ?")
      .bind(Date.now() - 1)
      .run();
    expect((await invite(owner, workspaceId, "late@example.com")).status).toBe(201);
  });

  it("tells a signed-out invitee with an existing account to sign in", async () => {
    const { owner, workspaceId } = await install();
    const { body: other } = await owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Other" },
    });
    await addMember(owner, workspaceId, "known@example.com", "member");
    const { token } = await invite(owner, other.id, "known@example.com");
    const res = await call("/v1/invites/accept", {
      method: "POST",
      json: { token, name: "Known", password: "a perfectly fine password" },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "account_exists" } });
    expect((await lookupInvite(token!)).status).toBe(200);
  });

  it("validates the accept body against its schema", async () => {
    const { owner, workspaceId } = await install();
    const { token } = await invite(owner, workspaceId, "short@example.com");
    const res = await call("/v1/invites/accept", {
      method: "POST",
      json: { token, name: "Short", password: "tooshort" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "invalid_request", message: expect.stringContaining("password") },
    });
    const longName = await call("/v1/invites/accept", {
      method: "POST",
      json: { token, name: "x".repeat(101), password: "a perfectly fine password" },
    });
    expect(longName.status).toBe(400);
  });

  it("undoes the claim and the new account when the membership write fails", async () => {
    const { owner, workspaceId } = await install();
    const { token } = await invite(owner, workspaceId, "fragile@example.com");
    const accept = () =>
      call("/v1/invites/accept", {
        method: "POST",
        json: { token, name: "Fragile", password: "a perfectly fine password" },
      });

    const restore = failStatement(/^insert into "audit_logs"/);
    try {
      expect((await accept()).status).toBe(500);
    } finally {
      restore();
    }
    const state = await env.DB.prepare(
      `SELECT (SELECT count(*) FROM users WHERE email = 'fragile@example.com') AS users,
              (SELECT count(*) FROM workspace_members WHERE workspace_id = ?) AS members,
              (SELECT accepted_at FROM invites WHERE email = 'fragile@example.com') AS accepted_at`,
    )
      .bind(workspaceId)
      .first();
    expect(state).toEqual({ users: 0, members: 1, accepted_at: null });

    expect((await accept()).status).toBe(200);
  });

  it("doesn't audit the invited role when the user was already a member", async () => {
    const { owner, workspaceId } = await install();
    const viewer = await addMember(owner, workspaceId, "already@example.com", "viewer");
    // A stale invite from before they joined, inserted directly because the
    // API refuses to invite an existing member.
    const token = "inv_stale_invite_token";
    await env.DB.prepare(
      `INSERT INTO invites (id, workspace_id, email, role, token_hash, expires_at, created_at, updated_at)
       VALUES ('inv_stale', ?, 'already@example.com', 'admin', ?, ?, ?, ?)`,
    )
      .bind(workspaceId, await hashToken(token), Date.now() + 60_000, Date.now(), Date.now())
      .run();

    const res = await viewer.json("/v1/invites/accept", { method: "POST", json: { token } });
    expect(res.status).toBe(200);
    const me = await viewer.json<{ workspaces: { role: string }[] }>("/v1/me");
    expect(me.body.workspaces[0]!.role).toBe("viewer");
    const audit = await owner.json<{ items: { action: string; metadata: unknown }[] }>(
      `/v1/workspaces/${workspaceId}/audit-logs`,
    );
    expect(audit.body.items[0]).toEqual(
      expect.objectContaining({
        action: "invite.accepted",
        metadata: { role: "viewer", invited_role: "admin", already_member: true },
      }),
    );
  });
});

describe("profile bounds on Better Auth's update-user", () => {
  const updateUser = (c: Client, json: unknown) =>
    c.request("/api/auth/update-user", { method: "POST", json });
  const stored = () =>
    env.DB.prepare("SELECT name, image FROM users WHERE email = 'mara@example.com'").first<{
      name: string;
      image: string | null;
    }>();

  it("trims and caps the name at 100 characters", async () => {
    const { owner } = await install();
    expect((await updateUser(owner, { name: `  ${"n".repeat(200_000)}  ` })).status).toBe(200);
    expect((await stored())?.name).toBe("n".repeat(100));
    expect((await updateUser(owner, { name: "  Mara  " })).status).toBe(200);
    expect((await stored())?.name).toBe("Mara");
  });

  it("rejects a blank name", async () => {
    const { owner } = await install();
    expect((await updateUser(owner, { name: "   " })).status).toBe(400);
    expect((await stored())?.name).toBe("Mara Okafor");
  });

  it.each([
    "javascript:alert(document.cookie)",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "http://example.com/a.png",
    "not a url",
  ])("rejects image %j", async (image) => {
    const { owner } = await install();
    expect((await updateUser(owner, { image })).status).toBe(400);
    expect((await stored())?.image).toBeNull();
  });

  it("accepts an https image and clearing it", async () => {
    const { owner } = await install();
    expect((await updateUser(owner, { image: "https://cdn.example.com/a.png" })).status).toBe(200);
    expect((await stored())?.image).toBe("https://cdn.example.com/a.png");
    expect((await updateUser(owner, { image: null })).status).toBe(200);
    expect((await stored())?.image).toBeNull();
  });
});
