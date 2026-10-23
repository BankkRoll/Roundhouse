/**
 * Wire types for the control-plane HTTP API (`/v1/*`). Field names mirror the JSON exactly
 * (snake_case). Timestamps are unix milliseconds.
 *
 * @module
 */
import type { NodeStatus, Role } from "@roundhouse/shared";

/** Unix epoch milliseconds. */
export type Millis = number;

/** Error envelope returned with every non-2xx response. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: ApiErrorDetail[] };
}

/** A per-field problem attached to an error, e.g. a malformed `${{…}}` reference. */
export interface ApiErrorDetail {
  /** The field it concerns; for variables, the variable key. */
  field: string;
  code: string;
  message: string;
  /** Span of the problem within the field's value, in UTF-16 code units. */
  start?: number;
  end?: number;
}

/** `GET /v1/setup` */
export interface SetupStatus {
  needs_setup: boolean;
  master_key_configured: boolean;
}

/**
 * `POST /v1/setup` request body. `master_key` must equal the Worker's `MASTER_KEY`
 * secret, which proves the caller controls the deployment.
 */
export interface SetupRequest {
  master_key: string;
  name: string;
  email: string;
  password: string;
  workspace_name: string;
}

/** `POST /v1/setup` response. */
export interface SetupResponse {
  user_id: string;
  workspace_id: string;
}

/** The signed-in user. */
export interface User {
  id: string;
  name: string;
  email: string;
  image: string | null;
  /** Holds install-wide actions; only `/v1/me` reports it. */
  instance_admin?: boolean;
}

/** `POST /api/auth/sign-in/email` request body (Better Auth). */
export interface SignInRequest {
  email: string;
  password: string;
}

/** `POST /api/auth/sign-in/email` response (Better Auth). Only the fields the dashboard reads. */
export interface SignInResponse {
  user: User;
}

/** A workspace as listed in `/v1/me`, with the caller's role in it. */
export interface WorkspaceMembership {
  id: string;
  name: string;
  slug: string;
  role: Role;
  /** The caller's own membership ID, used to leave the workspace. */
  member_id: string;
}

/** `GET /v1/me` */
export interface Me {
  user: User;
  workspaces: WorkspaceMembership[];
}

/** A workspace with the caller's role. */
export interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: Role;
  created_at: Millis;
}

/** A workspace member. `id` is the membership id; `user_id` identifies the person. */
export interface Member {
  id: string;
  user_id: string;
  name: string;
  email: string;
  image: string | null;
  role: Role;
  created_at: Millis;
}

/** A pending invitation. */
export interface Invite {
  id: string;
  email: string;
  role: Role;
  expires_at: Millis;
  created_at: Millis;
}

/** `POST /v1/workspaces/:id/invites` response. */
export interface CreateInviteResponse {
  invite: Invite;
  /** Absolute URL to share with the invitee. */
  url: string;
}

/** `GET /v1/invites/:token` (public). */
export interface InvitePreview {
  workspace_name: string;
  email: string;
  role: Role;
  expires_at: Millis;
}

/** `POST /v1/invites/:token/accept` request body. Name and password only when signed out. */
export interface AcceptInviteRequest {
  name?: string;
  password?: string;
}

/** `POST /v1/invites/:token/accept` response. */
export interface AcceptInviteResponse {
  workspace_id: string;
}

/** Runtimes detected on a node. */
export interface NodeCapabilities {
  docker: boolean;
  gvisor: boolean;
  builder: boolean;
}

/**
 * A server running the agent. Hardware facts arrive with registration; usage fields stay
 * `null` until the first heartbeat.
 */
export interface Node {
  id: string;
  name: string;
  hostname: string | null;
  status: NodeStatus;
  /** Hosting provider label; `"server"` when the agent could not tell. */
  provider: string;
  region: string | null;
  public_ip: string | null;
  os: string | null;
  arch: string | null;
  kernel: string | null;
  docker_version: string | null;
  agent_version: string | null;
  capabilities: NodeCapabilities | null;
  /** Logical CPU count. */
  cpu_total: number | null;
  /** Bytes. */
  mem_total: number | null;
  /** Bytes. */
  disk_total: number | null;
  /** 0-100 across all cores. */
  cpu_percent: number | null;
  /** Bytes. */
  mem_used: number | null;
  /** Bytes. */
  disk_used: number | null;
  load1: number | null;
  last_heartbeat_at: Millis | null;
  created_at: Millis;
}

/** `POST /v1/workspaces/:id/nodes/join-tokens` response. */
export interface JoinToken {
  token: string;
  expires_at: Millis;
  /** Shell one-liner that installs and enrolls the agent. */
  install_command: string;
}

/** One audit log entry. */
export interface AuditLogEntry {
  id: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  created_at: Millis;
}

/** A page of audit log entries. */
export interface AuditLogPage {
  items: AuditLogEntry[];
  next_cursor: string | null;
}
