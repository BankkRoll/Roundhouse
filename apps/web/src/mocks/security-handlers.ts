/**
 * MSW handlers for the ADR 0014 routes the dashboard calls, against the in-memory
 * {@link db}:
 * - GitHub installation claims and releases (`apps/api/src/routes/github.ts`): a claim is
 *   a single-use install state the existing callback mock redeems;
 * - instance admins, the instance audit log (entries with no workspace) and chain
 *   verification (`routes/instance-admin.ts`);
 * - re-authentication (`routes/auth-security.ts`): the seeded password (and a code,
 *   once the user has two-factor on) clears `db.sessionStale`.
 *
 * `contract.test.ts` validates every response against the API's schemas.
 *
 * @module
 */
import { AUDIT_ACTIONS, type AuditAction, REAUTH_WINDOW_MS } from "@roundhouse/shared";
import { HttpResponse, http } from "msw";
import { spendCode } from "./account-security-handlers";
import {
  apiError,
  currentUser,
  invalid,
  notFound,
  recordAudit,
  requireFreshSession,
  requireWorkspace,
  unauthorized,
} from "./common";
import { db } from "./db";

const CLAIM_TTL_MS = 10 * 60_000;

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function requireInstanceAdmin(): Response | null {
  const user = currentUser();
  if (!user) return unauthorized();
  return user.instance_admin
    ? null
    : apiError(403, "forbidden", "Only instance admins can perform instance:manage");
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** All entries in `seq` order (the mock's ids sort like the API's ULIDs). */
function chained() {
  return [...db.audit].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Security route handlers. */
export const securityHandlers = [
  http.post("*/v1/github/claims", async ({ request }) => {
    const body = await jsonBody(request);
    if (typeof body?.workspace_id !== "string") return invalid("workspace_id: Required");
    const access = requireWorkspace(body.workspace_id, "github:manage");
    if (!access.ok) return access.response;
    const app = db.deploy.github.app;
    if (!app) return apiError(409, "conflict", "No GitHub App is configured for this instance");
    const state = `ghc_${randomHex(16)}`;
    db.deploy.github.states.push({
      state,
      workspace_id: body.workspace_id,
      expires_at: Date.now() + CLAIM_TTL_MS,
    });
    return HttpResponse.json({ install_url: `${app.html_url}/installations/new?state=${state}` });
  }),

  http.delete("*/v1/github/installations/:installationId", ({ params, request }) => {
    const workspaceId = new URL(request.url).searchParams.get("workspace_id");
    if (!workspaceId) return invalid("workspace_id: Required");
    const fresh = currentUser() ? requireFreshSession() : null;
    if (fresh) return fresh;
    const access = requireWorkspace(workspaceId, "github:manage");
    if (!access.ok) return access.response;
    const row = db.deploy.github.installations.find(
      (candidate) =>
        candidate.id === params.installationId && candidate.workspace_id === workspaceId,
    );
    if (!row) return notFound("Installation");
    row.workspace_id = null;
    row.verified = false;
    row.claimed_at = null;
    recordAudit({
      workspaceId,
      actorType: "user",
      actorId: access.user.id,
      action: "github.installation_released",
      targetType: "github_installation",
      targetId: row.id,
      metadata: { installation_id: row.installation_id, account: row.account_login },
    });
    return new HttpResponse(null, { status: 204 });
  }),

  http.get("*/v1/instance/admins", () => {
    const denied = requireInstanceAdmin();
    if (denied) return denied;
    return HttpResponse.json({
      admins: db.users
        .filter((user) => user.instance_admin)
        .map((user) => ({
          user_id: user.id,
          name: user.name,
          email: user.email,
          two_factor_enabled: false,
          created_at: 0,
        })),
    });
  }),

  http.put("*/v1/instance/admins/:userId", async ({ params, request }) => {
    const body = await jsonBody(request);
    if (typeof body?.instance_admin !== "boolean") return invalid("instance_admin: Required");
    const denied = requireInstanceAdmin() ?? requireFreshSession();
    if (denied) return denied;
    const target = db.users.find((user) => user.id === params.userId);
    if (!target) return notFound("User");
    if (!body.instance_admin && target.instance_admin) {
      if (db.users.filter((user) => user.instance_admin).length <= 1) {
        return apiError(409, "last_owner", "The instance must keep at least one instance admin");
      }
    }
    if (target.instance_admin !== body.instance_admin) {
      target.instance_admin = body.instance_admin;
      recordAudit({
        workspaceId: null,
        actorType: "user",
        actorId: currentUser()?.id ?? null,
        action: body.instance_admin ? "instance.admin_granted" : "instance.admin_revoked",
        targetType: "user",
        targetId: target.id,
        metadata: { email: target.email },
      });
    }
    return HttpResponse.json({
      user_id: target.id,
      name: target.name,
      email: target.email,
      two_factor_enabled: false,
      created_at: 0,
    });
  }),

  http.get("*/v1/instance/audit-logs", ({ request }) => {
    const url = new URL(request.url);
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return invalid("limit: Too big: expected number to be <=100");
    }
    const action = url.searchParams.get("action");
    if (action !== null && !(AUDIT_ACTIONS as readonly string[]).includes(action)) {
      return invalid("action: Invalid option");
    }
    const denied = requireInstanceAdmin();
    if (denied) return denied;
    const cursor = url.searchParams.get("cursor");
    const actor = url.searchParams.get("actor_id");
    const all = chained();
    const rows = all
      .map((row, index) => ({ row, seq: index + 1 }))
      .filter(
        ({ row }) =>
          row.workspace_id === null &&
          (!cursor || row.id < cursor) &&
          (!action || row.action === (action as AuditAction)) &&
          (!actor || row.actor_id === actor),
      )
      .reverse()
      .slice(0, limit + 1);
    const entries = rows.slice(0, limit).map(({ row, seq }) => ({
      ...row,
      seq,
      action: row.action as AuditAction,
      actor_type: row.actor_type as "user" | "token" | "node" | "system",
      prev_hash: null,
      hash: null,
    }));
    return HttpResponse.json({
      entries,
      next_cursor: rows.length > limit ? (entries.at(-1)?.id ?? null) : null,
    });
  }),

  http.get("*/v1/instance/audit-logs/verify", () => {
    const denied = requireInstanceAdmin();
    if (denied) return denied;
    // The mock doesn't hash; it reports every entry as checked and the chain intact.
    const all = chained();
    return HttpResponse.json({
      ok: true,
      checked: all.length,
      head_seq: all.length,
      head_hash: all.length ? "0".repeat(64) : null,
      broken_at_seq: null,
      unsealed: 0,
      checkpoints: all.length ? 1 : 0,
    });
  }),

  http.post("*/v1/auth/reauth", async ({ request }) => {
    const body = await jsonBody(request);
    if (typeof body?.password !== "string" || !body.password) {
      return invalid("password: Required");
    }
    const user = currentUser();
    if (!user) return unauthorized();
    if (body.password !== user.password) {
      return apiError(400, "invalid_request", "Incorrect password");
    }
    if (db.security.twoFactor[user.id]) {
      if (typeof body.code !== "string" || !body.code) {
        return apiError(400, "invalid_request", "Enter a code from your authenticator app", [
          { field: "code", code: "required", message: "A TOTP or backup code is required" },
        ]);
      }
      if (!spendCode(user.id, body.code)) {
        return apiError(400, "invalid_request", "Incorrect code", [
          { field: "code", code: "invalid", message: "The code is wrong or was already used" },
        ]);
      }
    }
    db.sessionStale = false;
    recordAudit({
      workspaceId: null,
      actorType: "user",
      actorId: user.id,
      action: "auth.reauthenticated",
      targetType: "session",
      targetId: "session",
    });
    return HttpResponse.json({ fresh_until: Date.now() + REAUTH_WINDOW_MS });
  }),
];
