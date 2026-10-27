/**
 * MSW handlers that mirror the control-plane API (`apps/api/src/routes/*.ts`) against the
 * in-memory {@link db}. `contract.test.ts` validates every response they produce against
 * the API's own zod schemas, so drift fails the build. They reproduce the API's:
 *
 * - check order: body/query validation (400) before auth (401), then membership (404),
 *   then role (403), then conflicts (409);
 * - error envelope `{ "error": { "code", "message" } }` and codes (`invalid_request`,
 *   `forbidden`, `last_owner`, `email_mismatch`, ...);
 * - Better Auth's flat `{ code, message }` errors on `/api/auth/*`;
 * - sort orders, filters and audit records.
 *
 * Paths are prefixed with `*` so they match whatever origin jsdom reports.
 *
 * @module
 */

import { isProviderId, PROVIDERS } from "@roundhouse/providers";
import {
  isRole,
  JOIN_TOKEN_TTL_MS,
  OFFLINE_AFTER_MS,
  type Role,
  slugify,
} from "@roundhouse/shared";
import { HttpResponse, http } from "msw";
import type { AuditLogPage, Invite, Me, Member, Node, Workspace } from "../lib/api/types";
import { accountSecurityHandlers } from "./account-security-handlers";
import { changeHandlers } from "./changes-handlers";
import {
  apiError,
  currentUser,
  invalid,
  notFound,
  recordAudit,
  requireWorkspace,
  unauthorized,
} from "./common";
import { dataHandlers } from "./data-handlers";
import { type DbAuditEntry, type DbInvite, type DbMembership, db, nextId } from "./db";
import { deployHandlers } from "./deploy-handlers";
import { domainHandlers } from "./domains-mock";
import { metricsHandlers } from "./metrics-handlers";
import { providerHandlers } from "./providers-handlers";
import { securityHandlers } from "./security-handlers";
import { signingKeyHandlers } from "./signing-keys-mock";
import { templateHandlers } from "./templates-handlers";
import { tlsHandlers } from "./tls-mock";

export { apiError } from "./common";

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

const masterKeyMissing = () =>
  apiError(
    503,
    "master_key_missing",
    "MASTER_KEY is not configured. Set it with `wrangler secret put MASTER_KEY`.",
  );
const lastOwner = () => apiError(409, "last_owner", "A workspace must keep at least one owner");

// -----------------------------------------------------------------------------
// Request validation (stands in for the API's zod schemas)
// -----------------------------------------------------------------------------

interface StringRule {
  min?: number;
  max: number;
  trim?: boolean;
  email?: boolean;
  optional?: boolean;
}

type Parsed<K extends string> =
  | { ok: true; values: Record<K, string | undefined> }
  | { ok: false; response: Response };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => ({}));
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

function parseFields<K extends string>(
  body: Record<string, unknown>,
  rules: Record<K, StringRule>,
): Parsed<K> {
  const values = {} as Record<K, string | undefined>;
  for (const key of Object.keys(rules) as K[]) {
    const rule = rules[key];
    const raw = body[key];
    if (raw === undefined && rule.optional) continue;
    if (typeof raw !== "string") {
      return { ok: false, response: invalid(`${key}: Invalid input: expected string`) };
    }
    const value = rule.trim ? raw.trim() : raw;
    if (rule.email && !EMAIL.test(value)) {
      return { ok: false, response: invalid(`${key}: Invalid email address`) };
    }
    if (value.length < (rule.min ?? 0)) {
      return { ok: false, response: invalid(`${key}: Too small: expected >=${rule.min} chars`) };
    }
    if (value.length > rule.max) {
      return { ok: false, response: invalid(`${key}: Too big: expected <=${rule.max} chars`) };
    }
    values[key] = value;
  }
  return { ok: true, values };
}

function parseRole(body: Record<string, unknown>): Role | Response {
  return isRole(body.role) ? body.role : invalid("role: Invalid option");
}

// -----------------------------------------------------------------------------
// Row helpers
// -----------------------------------------------------------------------------

function toWorkspace(workspaceId: string, role: Role): Workspace | undefined {
  const row = db.workspaces.find((workspace) => workspace.id === workspaceId);
  return row ? { ...row, role } : undefined;
}

function toMember(row: DbMembership): Member {
  const user = db.users.find((candidate) => candidate.id === row.user_id);
  return {
    id: row.id,
    user_id: row.user_id,
    name: user?.name ?? "",
    email: user?.email ?? "",
    image: user?.image ?? null,
    role: row.role,
    created_at: row.created_at,
  };
}

function toInvite({ id, email, role, expires_at, created_at }: DbInvite): Invite {
  return { id, email, role, expires_at, created_at };
}

/** Mirrors `effectiveStatus`: a live node that stopped heartbeating reads as offline. */
function toApiNode({ workspace_id: _ws, ...node }: Node & { workspace_id: string }): Node {
  const live = node.status === "online" || node.status === "degraded";
  const silentFor = Date.now() - (node.last_heartbeat_at ?? 0);
  return live && silentFor > OFFLINE_AFTER_MS ? { ...node, status: "offline" } : node;
}

function ownerCount(workspaceId: string): number {
  return db.memberships.filter((row) => row.workspace_id === workspaceId && row.role === "owner")
    .length;
}

function isPending(invite: DbInvite): boolean {
  return !invite.accepted_at && invite.expires_at > Date.now();
}

function findPendingInvite(token: unknown): DbInvite | undefined {
  return db.invites.find((row) => row.token === token && isPending(row));
}

function randomToken(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function uniqueSlug(name: string): string {
  const base = slugify(name);
  const taken = new Set(db.workspaces.map((workspace) => workspace.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }
}

function createWorkspaceFor(userId: string, name: string): Workspace {
  const workspace = { id: nextId("ws"), name, slug: uniqueSlug(name), created_at: Date.now() };
  db.workspaces.push(workspace);
  db.memberships.push({
    id: nextId("mem"),
    workspace_id: workspace.id,
    user_id: userId,
    role: "owner",
    created_at: Date.now(),
  });
  return { ...workspace, role: "owner" };
}

/** The API joins actor names at read time: users by id, and nodes for node actors. */
function actorName(entry: DbAuditEntry): string | null {
  if (entry.actor_type === "user") {
    return db.users.find((user) => user.id === entry.actor_id)?.name ?? entry.actor_name;
  }
  if (entry.actor_type === "node") {
    return db.nodes.find((node) => node.id === entry.actor_id)?.name ?? entry.actor_name;
  }
  return null;
}

const MIN_PASSWORD = 12;

/** Phase 0 routes the dashboard calls, in the order of the API's route files. */
const phase0Handlers = [
  // ---------------------------------------------------------------------------
  // Setup (routes/setup.ts)
  // ---------------------------------------------------------------------------
  http.get("*/v1/setup", () => HttpResponse.json(db.setup)),

  http.post("*/v1/setup", async ({ request }) => {
    const parsed = parseFields(await readJson(request), {
      master_key: { min: 1, max: 512 },
      name: { min: 1, max: 100, trim: true },
      email: { max: 254, email: true },
      password: { min: MIN_PASSWORD, max: 256 },
      workspace_name: { min: 1, max: 100, trim: true },
    });
    if (!parsed.ok) return parsed.response;
    if (!db.setup.master_key_configured) return masterKeyMissing();
    const { master_key, name, email, password, workspace_name } = parsed.values;
    // SECURITY: Setup is gated on possession of MASTER_KEY so whoever reaches a fresh
    // install first cannot claim it.
    if (master_key?.trim() !== db.masterKey.trim()) {
      return apiError(403, "forbidden", "Master key does not match this install");
    }
    if (!db.setup.needs_setup) {
      return apiError(409, "already_setup", "This install is already set up");
    }
    const userId = nextId("usr");
    db.users.push({
      id: userId,
      name: name ?? "",
      email: (email ?? "").toLowerCase(),
      image: null,
      instance_admin: true,
      password: password ?? "",
    });
    const workspace = createWorkspaceFor(userId, workspace_name ?? "");
    recordAudit({
      workspaceId: workspace.id,
      actorType: "user",
      actorId: userId,
      action: "instance.setup_completed",
      targetType: "workspace",
      targetId: workspace.id,
    });
    db.setup = { needs_setup: false, master_key_configured: true, public_origin_configured: true };
    db.sessionUserId = userId;
    return HttpResponse.json({ user_id: userId, workspace_id: workspace.id }, { status: 201 });
  }),

  // ---------------------------------------------------------------------------
  // Better Auth (only the endpoints the dashboard calls)
  // ---------------------------------------------------------------------------
  http.post("*/api/auth/sign-in/email", async ({ request }) => {
    if (!db.setup.master_key_configured) return masterKeyMissing();
    const body = await readJson(request);
    const email = typeof body.email === "string" ? body.email.toLowerCase() : "";
    const lockedUntil = db.security.locked[email] ?? 0;
    if (lockedUntil > Date.now()) {
      const seconds = Math.ceil((lockedUntil - Date.now()) / 1000);
      return HttpResponse.json(
        {
          code: "account_locked",
          message: `Too many failed attempts. Try again in ${seconds} seconds.`,
        },
        { status: 429, headers: { "retry-after": String(seconds) } },
      );
    }
    const user = db.users.find((candidate) => candidate.email.toLowerCase() === email);
    if (!user || user.password !== body.password) {
      return HttpResponse.json(
        { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
        { status: 401 },
      );
    }
    if (db.security.twoFactor[user.id]) {
      db.security.challengeUserId = user.id;
      return HttpResponse.json({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
    }
    db.sessionUserId = user.id;
    const { password: _password, ...publicUser } = user;
    return HttpResponse.json({ redirect: false, token: "session-token", user: publicUser });
  }),

  http.post("*/api/auth/sign-out", () => {
    if (!db.setup.master_key_configured) return masterKeyMissing();
    db.sessionUserId = null;
    return HttpResponse.json({ success: true });
  }),

  // ---------------------------------------------------------------------------
  // Current user, workspaces and members (routes/workspaces.ts)
  // ---------------------------------------------------------------------------
  http.get("*/v1/me", () => {
    const user = currentUser();
    if (!user) return unauthorized();
    const me: Me = {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        instance_admin: user.instance_admin ?? false,
      },
      workspaces: db.memberships
        .filter((row) => row.user_id === user.id)
        .flatMap((row) => {
          const workspace = db.workspaces.find((candidate) => candidate.id === row.workspace_id);
          return workspace
            ? [
                {
                  id: workspace.id,
                  name: workspace.name,
                  slug: workspace.slug,
                  role: row.role,
                  member_id: row.id,
                },
              ]
            : [];
        })
        // NOTE: SQLite's default collation is binary, so this is not localeCompare.
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    };
    return HttpResponse.json(me);
  }),

  http.post("*/v1/workspaces", async ({ request }) => {
    const parsed = parseFields(await readJson(request), {
      name: { min: 1, max: 100, trim: true },
    });
    if (!parsed.ok) return parsed.response;
    const user = currentUser();
    if (!user) return unauthorized();
    // SECURITY: Mirrors the API: `workspaces:create` is an instance action (ADR 0014).
    if (!user.instance_admin) {
      return apiError(403, "forbidden", "Only instance admins can perform workspaces:create");
    }
    const workspace = createWorkspaceFor(user.id, parsed.values.name ?? "");
    recordAudit({
      workspaceId: workspace.id,
      actorType: "user",
      actorId: user.id,
      action: "workspace.created",
      targetType: "workspace",
      targetId: workspace.id,
    });
    return HttpResponse.json(workspace, { status: 201 });
  }),

  http.get("*/v1/workspaces/:workspaceId", ({ params }) => {
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "workspace:read");
    if (!access.ok) return access.response;
    const workspace = toWorkspace(workspaceId, access.membership.role);
    return workspace ? HttpResponse.json(workspace) : notFound("Workspace");
  }),

  http.patch("*/v1/workspaces/:workspaceId", async ({ params, request }) => {
    const parsed = parseFields(await readJson(request), {
      name: { min: 1, max: 100, trim: true },
    });
    if (!parsed.ok) return parsed.response;
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "workspace:update");
    if (!access.ok) return access.response;
    const row = db.workspaces.find((workspace) => workspace.id === workspaceId);
    if (!row) return notFound("Workspace");
    const name = parsed.values.name ?? row.name;
    row.name = name;
    recordAudit({
      workspaceId,
      actorType: "user",
      actorId: access.user.id,
      action: "workspace.renamed",
      targetType: "workspace",
      targetId: workspaceId,
      metadata: { name },
    });
    return HttpResponse.json(toWorkspace(workspaceId, access.membership.role));
  }),

  http.get("*/v1/workspaces/:workspaceId/members", ({ params }) => {
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "members:read");
    if (!access.ok) return access.response;
    const members = db.memberships
      .filter((row) => row.workspace_id === workspaceId)
      .sort((a, b) => a.created_at - b.created_at)
      .map(toMember);
    return HttpResponse.json({ members });
  }),

  http.patch("*/v1/workspaces/:workspaceId/members/:memberId", async ({ params, request }) => {
    const role = parseRole(await readJson(request));
    if (role instanceof Response) return role;
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "members:manage");
    if (!access.ok) return access.response;
    const target = db.memberships.find(
      (row) => row.id === params.memberId && row.workspace_id === workspaceId,
    );
    if (!target) return notFound("Member");
    if ((role === "owner" || target.role === "owner") && access.membership.role !== "owner") {
      return apiError(403, "forbidden", "Only owners can grant or change the owner role");
    }
    if (role !== "owner" && target.role === "owner" && ownerCount(workspaceId) <= 1) {
      return lastOwner();
    }
    const from = target.role;
    target.role = role;
    recordAudit({
      workspaceId,
      actorType: "user",
      actorId: access.user.id,
      action: "member.role_changed",
      targetType: "member",
      targetId: target.id,
      metadata: { from, to: role, user_id: target.user_id },
    });
    return HttpResponse.json(toMember(target));
  }),

  http.delete("*/v1/workspaces/:workspaceId/members/:memberId", ({ params }) => {
    const workspaceId = String(params.workspaceId);
    const user = currentUser();
    if (!user) return unauthorized();
    const target = db.memberships.find(
      (row) => row.id === params.memberId && row.workspace_id === workspaceId,
    );
    const isSelf = target?.user_id === user.id;
    const access = requireWorkspace(workspaceId, isSelf ? "workspace:read" : "members:manage");
    if (!access.ok) return access.response;
    if (!target) return notFound("Member");
    if (target.role === "owner" && !isSelf && access.membership.role !== "owner") {
      return apiError(403, "forbidden", "Only owners can remove an owner");
    }
    if (target.role === "owner" && ownerCount(workspaceId) <= 1) return lastOwner();
    const removed = toMember(target);
    db.memberships = db.memberships.filter((row) => row !== target);
    recordAudit({
      workspaceId,
      actorType: "user",
      actorId: user.id,
      action: isSelf ? "member.left" : "member.removed",
      targetType: "member",
      targetId: removed.id,
      metadata: { user_id: removed.user_id, email: removed.email },
    });
    return new HttpResponse(null, { status: 204 });
  }),

  // ---------------------------------------------------------------------------
  // Invites (routes/invites.ts)
  // ---------------------------------------------------------------------------
  http.get("*/v1/workspaces/:workspaceId/invites", ({ params }) => {
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "members:manage");
    if (!access.ok) return access.response;
    const invites = db.invites
      .filter((row) => row.workspace_id === workspaceId && isPending(row))
      .sort((a, b) => b.created_at - a.created_at)
      .map(toInvite);
    return HttpResponse.json({ invites });
  }),

  http.post("*/v1/workspaces/:workspaceId/invites", async ({ params, request }) => {
    const body = await readJson(request);
    const parsed = parseFields(body, { email: { max: 254, email: true } });
    if (!parsed.ok) return parsed.response;
    const role = parseRole(body);
    if (role instanceof Response) return role;
    const email = (parsed.values.email ?? "").toLowerCase();
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "members:manage");
    if (!access.ok) return access.response;
    if (role === "owner" && access.membership.role !== "owner") {
      return apiError(403, "forbidden", "Only owners can invite owners");
    }
    const alreadyMember = db.memberships.some(
      (row) =>
        row.workspace_id === workspaceId &&
        db.users.find((user) => user.id === row.user_id)?.email.toLowerCase() === email,
    );
    if (alreadyMember) return apiError(409, "conflict", `${email} is already a member`);
    const now = Date.now();
    const invite: DbInvite = {
      id: nextId("inv"),
      token: randomToken("inv"),
      workspace_id: workspaceId,
      email,
      role,
      expires_at: now + 7 * 86_400_000,
      created_at: now,
      accepted_at: null,
    };
    db.invites.push(invite);
    recordAudit({
      workspaceId,
      actorType: "user",
      actorId: access.user.id,
      action: "invite.created",
      targetType: "invite",
      targetId: invite.id,
      metadata: { email, role },
    });
    return HttpResponse.json(
      {
        invite: toInvite(invite),
        url: `${new URL(request.url).origin}/invite#token=${encodeURIComponent(invite.token)}`,
      },
      { status: 201 },
    );
  }),

  http.delete("*/v1/workspaces/:workspaceId/invites/:inviteId", ({ params }) => {
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "members:manage");
    if (!access.ok) return access.response;
    const invite = db.invites.find(
      (row) => row.id === params.inviteId && row.workspace_id === workspaceId && !row.accepted_at,
    );
    if (!invite) return notFound("Invite");
    db.invites = db.invites.filter((row) => row !== invite);
    recordAudit({
      workspaceId,
      actorType: "user",
      actorId: access.user.id,
      action: "invite.revoked",
      targetType: "invite",
      targetId: invite.id,
      metadata: { email: invite.email },
    });
    return new HttpResponse(null, { status: 204 });
  }),

  // SECURITY: Like the API, the token only ever travels in request bodies.
  http.post("*/v1/invites/lookup", async ({ request }) => {
    const parsed = parseFields(await readJson(request), { token: { min: 1, max: 200 } });
    if (!parsed.ok) return parsed.response;
    const invite = findPendingInvite(parsed.values.token);
    if (!invite) return notFound("Invite");
    const workspace = db.workspaces.find((row) => row.id === invite.workspace_id);
    if (!workspace) return notFound("Invite");
    return HttpResponse.json({
      workspace_name: workspace.name,
      email: invite.email,
      role: invite.role,
      expires_at: invite.expires_at,
    });
  }),

  http.post("*/v1/invites/accept", async ({ request }) => {
    const body = await readJson(request);
    const parsed = parseFields(body, {
      token: { min: 1, max: 200 },
      name: { min: 1, max: 100, trim: true, optional: true },
      password: { min: MIN_PASSWORD, max: 256, optional: true },
    });
    if (!parsed.ok) return parsed.response;
    const invite = findPendingInvite(parsed.values.token);
    if (!invite) return notFound("Invite");

    const user = currentUser();
    if (user) {
      // SECURITY: The link is a bearer secret, but it only works for the invited address.
      if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
        return apiError(
          403,
          "email_mismatch",
          `This invite is for ${invite.email}; you're signed in as ${user.email}`,
        );
      }
    } else {
      const email = invite.email.toLowerCase();
      const exists = db.users.some((row) => row.email.toLowerCase() === email);
      if (exists) {
        return apiError(409, "account_exists", "An account with this email exists; sign in first");
      }
      if (!parsed.values.name || !parsed.values.password) {
        return invalid("name and a password of 12+ characters are required");
      }
    }

    invite.accepted_at = Date.now();
    let userId = user?.id;
    if (!userId) {
      userId = nextId("usr");
      db.users.push({
        id: userId,
        name: parsed.values.name ?? "",
        email: invite.email,
        image: null,
        password: parsed.values.password ?? "",
      });
      db.sessionUserId = userId;
    }
    const joined = db.memberships.some(
      (row) => row.workspace_id === invite.workspace_id && row.user_id === userId,
    );
    if (!joined) {
      db.memberships.push({
        id: nextId("mem"),
        workspace_id: invite.workspace_id,
        user_id: userId,
        role: invite.role,
        created_at: Date.now(),
      });
    }
    recordAudit({
      workspaceId: invite.workspace_id,
      actorType: "user",
      actorId: userId,
      action: "invite.accepted",
      targetType: "invite",
      targetId: invite.id,
      metadata: { role: invite.role },
    });
    return HttpResponse.json({ workspace_id: invite.workspace_id });
  }),

  // ---------------------------------------------------------------------------
  // Nodes (routes/nodes.ts)
  // ---------------------------------------------------------------------------
  http.get("*/v1/workspaces/:workspaceId/nodes", ({ params }) => {
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "nodes:read");
    if (!access.ok) return access.response;
    const nodes = db.nodes
      .filter((row) => row.workspace_id === workspaceId)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(toApiNode);
    return HttpResponse.json({ nodes });
  }),

  http.post("*/v1/workspaces/:workspaceId/nodes/join-tokens", ({ params, request }) => {
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "nodes:manage");
    if (!access.ok) return access.response;
    const id = nextId("njt");
    const token = randomToken("njt");
    const origin = new URL(request.url).origin;
    const joinToken = {
      token,
      expires_at: Date.now() + JOIN_TOKEN_TTL_MS,
      install_command: `curl -fsSL ${origin}/install.sh | sudo bash -s -- --token ${token}`,
    };
    db.joinTokens.push({ ...joinToken, workspace_id: workspaceId });
    recordAudit({
      workspaceId,
      actorType: "user",
      actorId: access.user.id,
      action: "node.join_token_created",
      targetType: "join_token",
      targetId: id,
    });
    return HttpResponse.json(joinToken, { status: 201 });
  }),

  http.get("*/v1/workspaces/:workspaceId/nodes/:nodeId", ({ params }) => {
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "nodes:read");
    if (!access.ok) return access.response;
    const row = db.nodes.find(
      (node) => node.id === params.nodeId && node.workspace_id === workspaceId,
    );
    return row ? HttpResponse.json(toApiNode(row)) : notFound("Server");
  }),

  http.delete("*/v1/workspaces/:workspaceId/nodes/:nodeId", ({ params, request }) => {
    const workspaceId = String(params.workspaceId);
    const keepServer = new URL(request.url).searchParams.get("keep_server") === "true";
    const access = requireWorkspace(workspaceId, "nodes:manage");
    if (!access.ok) return access.response;
    const row = db.nodes.find(
      (node) => node.id === params.nodeId && node.workspace_id === workspaceId,
    );
    if (!row) return notFound("Server");
    const deprovision = row.provider_server_id !== null && !keepServer;
    if (deprovision) {
      const connected = db.providers.integrations.some(
        (entry) => entry.workspace_id === workspaceId && entry.provider === row.provider,
      );
      if (!connected) {
        return apiError(
          409,
          "provider_not_connected",
          `Connect ${isProviderId(row.provider) ? PROVIDERS[row.provider].displayName : row.provider} to this workspace first`,
        );
      }
    }
    db.nodes = db.nodes.filter((node) => node !== row);
    if (deprovision) {
      recordAudit({
        workspaceId,
        actorType: "user",
        actorId: access.user.id,
        action: "node.deprovisioned",
        targetType: "node",
        targetId: row.id,
        metadata: { provider: row.provider, server_id: row.provider_server_id, deleted: true },
      });
    }
    recordAudit({
      workspaceId,
      actorType: "user",
      actorId: access.user.id,
      action: "node.removed",
      targetType: "node",
      targetId: row.id,
      metadata: { name: row.name },
    });
    return new HttpResponse(null, { status: 204 });
  }),

  // ---------------------------------------------------------------------------
  // Audit log (routes/audit.ts)
  // ---------------------------------------------------------------------------
  http.get("*/v1/workspaces/:workspaceId/audit-logs", ({ params, request }) => {
    const url = new URL(request.url);
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      return invalid("limit: Expected an integer between 1 and 200");
    }
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "audit:read");
    if (!access.ok) return access.response;
    const cursor = url.searchParams.get("cursor");
    const rows = db.audit
      .filter((row) => row.workspace_id === workspaceId && (!cursor || row.id < cursor))
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
      .slice(0, limit + 1);
    const items = rows.slice(0, limit).map((row) => {
      const { workspace_id: _ws, ...entry } = row;
      return { ...entry, actor_name: actorName(row) };
    });
    const page: AuditLogPage = {
      items,
      next_cursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
    };
    return HttpResponse.json(page);
  }),
];

/** Every route the dashboard calls: Phase 0 first, then the deploy pipeline, cloud providers, templates, change sets and signing keys. */
export const handlers = [
  ...phase0Handlers,
  ...deployHandlers,
  ...domainHandlers,
  ...providerHandlers,
  ...templateHandlers,
  ...changeHandlers,
  ...metricsHandlers,
  ...dataHandlers,
  ...signingKeyHandlers,
  ...tlsHandlers,
  ...securityHandlers,
  ...accountSecurityHandlers,
];
