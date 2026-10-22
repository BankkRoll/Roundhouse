/**
 * Response/request schemas shared across routes. They drive both runtime
 * validation and the generated OpenAPI document.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import { CapabilitiesSchema } from "@openrail/protocol";
import { AUDIT_ACTIONS, AUDIT_ACTOR_TYPES, NODE_STATUSES, ROLES } from "@openrail/shared";

/** Error envelope returned by every non-2xx response. */
export const ErrorSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .openapi("Error");

/** Unix-millisecond timestamp. */
export const Millis = z
  .number()
  .int()
  .openapi({ description: "Unix time in milliseconds", example: 1767225600000 });

/** Workspace role. */
export const RoleSchema = z.enum(ROLES).openapi("Role");

/** A workspace as seen by one of its members. */
export const WorkspaceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    role: RoleSchema,
    created_at: Millis,
  })
  .openapi("Workspace");

/** A workspace member joined with their user profile. */
export const MemberSchema = z
  .object({
    id: z.string(),
    user_id: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    role: RoleSchema,
    created_at: Millis,
  })
  .openapi("Member");

/** A pending invite. The token is never returned after creation. */
export const InviteSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    role: RoleSchema,
    expires_at: Millis,
    created_at: Millis,
  })
  .openapi("Invite");

/** A machine running the node agent. */
export const NodeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    hostname: z.string().nullable(),
    status: z.enum(NODE_STATUSES),
    provider: z.string(),
    region: z.string().nullable(),
    public_ip: z.string().nullable(),
    os: z.string().nullable(),
    arch: z.string().nullable(),
    kernel: z.string().nullable(),
    docker_version: z.string().nullable(),
    agent_version: z.string().nullable(),
    capabilities: CapabilitiesSchema.nullable(),
    cpu_total: z.number().nullable(),
    mem_total: z.number().nullable(),
    disk_total: z.number().nullable(),
    cpu_percent: z.number().nullable(),
    mem_used: z.number().nullable(),
    disk_used: z.number().nullable(),
    load1: z.number().nullable(),
    last_heartbeat_at: Millis.nullable(),
    created_at: Millis,
  })
  .openapi("Node");

/** One audit log entry. */
export const AuditLogSchema = z
  .object({
    id: z.string(),
    actor_type: z.enum(AUDIT_ACTOR_TYPES),
    actor_id: z.string().nullable(),
    actor_name: z.string().nullable(),
    action: z.enum(AUDIT_ACTIONS),
    target_type: z.string().nullable(),
    target_id: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    ip: z.string().nullable(),
    created_at: Millis,
  })
  .openapi("AuditLog");

/** Path params for workspace-scoped routes. */
export const WorkspaceParams = z.object({ workspaceId: z.string() });

/**
 * Standard error responses to spread into a route's `responses`.
 *
 * @param codes - HTTP statuses the route can fail with.
 * @returns OpenAPI response objects keyed by status.
 */
export function errors<const S extends number>(...codes: S[]) {
  return Object.fromEntries(
    codes.map((code) => [
      code,
      { description: "Error", content: { "application/json": { schema: ErrorSchema } } },
    ]),
  ) as Record<
    S,
    { description: string; content: { "application/json": { schema: typeof ErrorSchema } } }
  >;
}

/**
 * Wraps a schema as a JSON response object.
 *
 * @param schema - Body schema.
 * @param description - Human description for the docs.
 * @returns An OpenAPI response object.
 */
export function json<T extends z.ZodType>(schema: T, description = "OK") {
  return { description, content: { "application/json": { schema } } };
}

/**
 * Wraps a schema as a required JSON request body.
 *
 * @param schema - Body schema.
 * @returns A `request` fragment to spread into `createRoute`.
 */
export function body<T extends z.ZodType>(schema: T) {
  return { body: { required: true, content: { "application/json": { schema } } } } as const;
}

/** Name of the session-cookie security scheme registered in the OpenAPI document. */
export const SESSION_SCHEME = "session";

/** `security` requirement for routes that need a signed-in browser session. */
export const sessionAuth = [{ [SESSION_SCHEME]: [] }];
