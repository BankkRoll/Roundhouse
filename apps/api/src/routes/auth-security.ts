/**
 * ADR 0014 account security routes: `AUTH_ROUTES` in `../contracts/auth`.
 *
 * - `POST /v1/auth/reauth` re-checks the password (and, once two-factor
 *   lands, a TOTP or backup code) and stamps `sessions.reauthenticated_at`,
 *   which makes the session fresh for `REAUTH_WINDOW_MS` (see
 *   `lib/fresh-session.ts`).
 *
 * Owned by the api-auth stream; mounted in `index.ts` already.
 *
 * @module
 */
import { sessions, users } from "@roundhouse/db";
import { REAUTH_WINDOW_MS } from "@roundhouse/shared";
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { type AppContext, authFor, clientIp, createRouter, requirePrincipal } from "../context";
import { reauthenticate } from "../contracts";
import { auditInsert, recordAudit } from "../lib/audit";
import { ApiError } from "../lib/errors";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Checks the second factor of a re-authentication.
 *
 * TODO(api-auth): verify `code` as a TOTP or backup code with Better Auth's
 * two-factor plugin once it is configured, and count failures toward the
 * lockout (`auth.two_factor_failed`). Until then no account can enable 2FA,
 * so this is only reached by a row edited by hand, and it fails closed.
 */
async function secondFactorValid(_c: AppContext, _userId: string, _code: string): Promise<boolean> {
  return false;
}

/** Account security route handlers. */
export const authSecurityRoutes = createRouter().openapi(reauthenticate, async (c) => {
  const principal = await requirePrincipal(c);
  if (principal.token || !principal.session) {
    throw new ApiError(403, "forbidden", "API tokens can't re-authenticate; sign in instead");
  }
  const { password, code } = c.req.valid("json");
  const db = c.get("db");
  const { user, session } = principal;
  const failed = async (reason: string) => {
    // TODO(api-auth): count toward the per-account lockout (ADR 0014 "Lockout").
    await recordAudit(db, {
      workspaceId: null,
      actorType: "user",
      actorId: user.id,
      action: "auth.sign_in_failed",
      targetType: "user",
      targetId: user.id,
      metadata: { email_hash: await sha256Hex(user.email.trim().toLowerCase()), reason },
      ip: clientIp(c),
    });
  };

  const auth = await authFor(c);
  try {
    await auth.api.verifyPassword({ body: { password }, headers: c.req.raw.headers });
  } catch (err) {
    if (!(err instanceof APIError)) throw err;
    await failed("reauth_password");
    throw new ApiError(400, "invalid_request", "Incorrect password");
  }

  const [row] = await db
    .select({ twoFactorEnabled: users.twoFactorEnabled })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  if (row?.twoFactorEnabled) {
    if (!code) {
      throw new ApiError(400, "invalid_request", "Enter a code from your authenticator app", [
        { field: "code", code: "required", message: "A TOTP or backup code is required" },
      ]);
    }
    if (!(await secondFactorValid(c, user.id, code))) {
      await failed("reauth_two_factor");
      throw new ApiError(400, "invalid_request", "Incorrect code");
    }
  }

  const now = new Date();
  await db.batch([
    db.update(sessions).set({ reauthenticatedAt: now }).where(eq(sessions.id, session.id)),
    auditInsert(db, {
      workspaceId: null,
      actorType: "user",
      actorId: user.id,
      action: "auth.reauthenticated",
      targetType: "session",
      targetId: session.id,
      ip: clientIp(c),
    }),
  ]);
  return c.json({ fresh_until: +now + REAUTH_WINDOW_MS }, 200);
});
