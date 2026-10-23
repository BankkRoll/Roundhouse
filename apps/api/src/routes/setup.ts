/**
 * First-run setup: creates the admin account, first workspace, and the
 * control-plane signing key. Callable exactly once per install.
 *
 * @module
 */
import { createRoute, z } from "@hono/zod-openapi";
import { instanceSettings, users, workspaces } from "@roundhouse/db";
import { eq } from "drizzle-orm";
import { createRouter, requireMasterKey, signUp } from "../context";
import { recordAudit } from "../lib/audit";
import { forwardCookies } from "../lib/cookies";
import { constantTimeEqual, isValidMasterKey } from "../lib/crypto";
import { ApiError } from "../lib/errors";
import { claimSetupLock, isSetupComplete, releaseSetupLock, SettingKey } from "../lib/settings";
import { createSigningKey } from "../lib/signing-keys";
import { createWorkspace } from "../lib/workspaces";
import { body, errors, json } from "../schemas";

const SetupStatus = z.object({ needs_setup: z.boolean(), master_key_configured: z.boolean() });

const SetupBody = z.object({
  /** Proves the caller controls this install; see the SECURITY note in the handler. */
  master_key: z.string().min(1).max(512),
  name: z.string().trim().min(1).max(100),
  email: z.email().max(254),
  password: z.string().min(12).max(256),
  workspace_name: z.string().trim().min(1).max(100),
});

const getStatus = createRoute({
  method: "get",
  path: "/v1/setup",
  tags: ["setup"],
  summary: "Whether first-run setup is still required",
  responses: { 200: json(SetupStatus) },
});

const runSetup = createRoute({
  method: "post",
  path: "/v1/setup",
  tags: ["setup"],
  summary: "Create the first admin and workspace",
  request: body(SetupBody),
  responses: {
    201: json(z.object({ user_id: z.string(), workspace_id: z.string() }), "Created"),
    ...errors(400, 403, 409, 429, 503),
  },
});

/** Routes under `/v1/setup`. */
export const setupRoutes = createRouter()
  .openapi(getStatus, async (c) => {
    return c.json(
      {
        needs_setup: !(await isSetupComplete(c.get("db"))),
        master_key_configured: isValidMasterKey(c.env.MASTER_KEY),
      },
      200,
    );
  })
  .openapi(runSetup, async (c) => {
    const masterKey = requireMasterKey(c);
    const db = c.get("db");
    const input = c.req.valid("json");

    // SECURITY: Until setup runs, the first caller becomes owner of every node
    // that joins later. Requiring MASTER_KEY, which only the operator who
    // deployed the Worker knows, stops strangers racing them for it.
    if (!(await constantTimeEqual(input.master_key.trim(), masterKey))) {
      throw new ApiError(403, "forbidden", "Master key does not match this install");
    }

    // SECURITY: Setup is unauthenticated, so it must be single-shot even under
    // concurrent requests.
    const lock = await claimSetupLock(db);
    if (lock === undefined) {
      throw new ApiError(409, "already_setup", "This install is already set up");
    }

    let createdUserId: string | undefined;
    let createdWorkspaceId: string | undefined;
    try {
      const { userId, headers } = await signUp(c, {
        name: input.name,
        email: input.email,
        password: input.password,
      });
      createdUserId = userId;
      await db.update(users).set({ instanceAdmin: true }).where(eq(users.id, userId));
      const workspace = await createWorkspace(db, input.workspace_name, userId);
      createdWorkspaceId = workspace.id;
      await createSigningKey(db, c.env);
      await recordAudit(db, {
        // Instance-level (ADR 0014): only instance admins see it.
        workspaceId: null,
        actorType: "user",
        actorId: userId,
        action: "instance.setup_completed",
        targetType: "workspace",
        targetId: workspace.id,
      });
      // Written last: once present the install counts as set up, so nothing
      // after it may fail and trigger the rollback below.
      await db
        .insert(instanceSettings)
        .values({ key: SettingKey.setupCompletedAt, value: Date.now() });
      forwardCookies(c, headers);
      return c.json({ user_id: userId, workspace_id: workspace.id }, 201);
    } catch (err) {
      // Undo partial work and release the lock so the operator can simply retry.
      if (createdWorkspaceId) {
        await db.delete(workspaces).where(eq(workspaces.id, createdWorkspaceId));
      }
      if (createdUserId) await db.delete(users).where(eq(users.id, createdUserId));
      await releaseSetupLock(db, lock);
      throw err;
    }
  });
