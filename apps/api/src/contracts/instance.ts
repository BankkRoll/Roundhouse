/**
 * Instance administration routes (ADR 0014, finding F3): instance admins and
 * the instance-level audit log. Owned by the api-authz-rbac-github stream.
 * Workspace creation stays at `POST /v1/workspaces` (phase 0 route), now
 * gated by `workspaces:create`.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import { body, CursorField, errors, json, LimitField, sessionAuth } from "../schemas";
import {
  AuditChainVerificationSchema,
  InstanceAdminSchema,
  InstanceAuditPageSchema,
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

/** Instance-level audit entries (`workspace_id IS NULL`), newest first. */
export const listInstanceAuditLogs = defineRoute(session("instance:manage"), {
  method: "get",
  path: "/v1/instance/audit-logs",
  tags: ["instance"],
  summary: "List instance audit logs",
  security: sessionAuth,
  request: { query: z.object({ cursor: CursorField, limit: LimitField }) },
  responses: { 200: json(InstanceAuditPageSchema), ...errors(400, 401, 403) },
});

/** Recomputes the whole audit chain and reports the first break. */
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
