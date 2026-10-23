/**
 * Instance administration routes (ADR 0014, finding F3): instance admins and
 * the instance-level audit log. Owned by the api-authz-rbac-github stream.
 * Workspace creation stays at `POST /v1/workspaces` (phase 0 route), now
 * gated by `workspaces:create`.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import { body, errors, json, sessionAuth } from "../schemas";
import {
  AuditChainVerificationSchema,
  InstanceAdminSchema,
  InstanceAuditPageSchema,
  InstanceAuditQuery,
  PutInstanceAdminBody,
} from "../schemas/instance";
import { defineRoute, session } from "./policy";

/** Users holding the instance-admin flag. */
export const listInstanceAdmins = defineRoute(session("instance:manage"), {
  method: "get",
  path: "/v1/instance/admins",
  tags: ["instance"],
  summary: "List instance admins",
  security: sessionAuth,
  responses: {
    200: json(z.object({ admins: z.array(InstanceAdminSchema) })),
    ...errors(401, 403),
  },
});

/**
 * Grants or revokes the flag. 409 `last_owner` when revoking the last
 * instance admin. The user must already have an account.
 */
export const putInstanceAdmin = defineRoute(
  session("instance:manage", ["instance.admin_granted", "instance.admin_revoked"], {
    reauth: true,
  }),
  {
    method: "put",
    path: "/v1/instance/admins/{userId}",
    tags: ["instance"],
    summary: "Grant or revoke instance admin",
    security: sessionAuth,
    request: { params: z.object({ userId: z.string() }), ...body(PutInstanceAdminBody) },
    responses: { 200: json(InstanceAdminSchema), ...errors(400, 401, 403, 404, 409) },
  },
);

/**
 * Instance-level audit entries (`workspace_id IS NULL`: setup, instance
 * settings, admins, keys, the GitHub App, sign-ins and re-authentication),
 * newest first, optionally filtered by action, actor and time.
 */
export const listInstanceAuditLogs = defineRoute(session("instance:manage"), {
  method: "get",
  path: "/v1/instance/audit-logs",
  tags: ["instance"],
  summary: "List instance audit logs",
  security: sessionAuth,
  request: { query: InstanceAuditQuery },
  responses: { 200: json(InstanceAuditPageSchema), ...errors(400, 401, 403) },
});

/**
 * Seals pending entries, then recomputes the whole audit chain and compares
 * it with the checkpoints kept outside the database; reports the first break.
 */
export const verifyAuditChain = defineRoute(session("instance:manage"), {
  method: "get",
  path: "/v1/instance/audit-logs/verify",
  tags: ["instance"],
  summary: "Verify the audit chain",
  security: sessionAuth,
  responses: { 200: json(AuditChainVerificationSchema), ...errors(401, 403) },
});

/** Every instance administration route, by name. */
export const INSTANCE_ROUTES = {
  listInstanceAdmins,
  putInstanceAdmin,
  listInstanceAuditLogs,
  verifyAuditChain,
} as const;
