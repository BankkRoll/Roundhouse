/**
 * Web shell vocabulary shared by the API (the relay in the node Durable
 * Object), the dashboard terminal and the CLI (ADR 0012 "Web shell", ADR
 * 0014 §15):
 * - {@link shellGate}: who may open a shell, beyond `shell:open`;
 * - {@link SHELL_CLOSE_CODES}: how a shell socket ends, and what the client
 *   should do about it;
 * - the browser ↔ relay frames ({@link ShellClientMessage},
 *   {@link ShellServerMessage}): binary frames carry terminal bytes both
 *   ways, JSON text frames carry control messages.
 *
 * @module
 */
import { z } from "zod";

// -----------------------------------------------------------------------------
// Gate
// -----------------------------------------------------------------------------

/** How the caller authenticated. OAuth (MCP) tokens never open a shell. */
export type ShellCredential = "session" | "api_token" | "oauth";

/** What {@link shellGate} decides on. */
export interface ShellGateInput {
  credential: ShellCredential;
  /** `resolveAccess(...).check("shell:open", { environmentId })` allowed it. */
  accessAllowed: boolean;
  /** The person (a token's creator for API tokens) has two-factor authentication on. */
  twoFactorEnabled: boolean;
  /** The session signed in or re-authenticated within `REAUTH_WINDOW_MS`; `false` for tokens. */
  freshSession: boolean;
  /** The target environment is protected (ADR 0014 "Environment protection"). */
  environmentProtected: boolean;
}

/** Why {@link shellGate} refused. */
export const SHELL_DENIALS = [
  "oauth_token",
  "forbidden",
  "two_factor_required",
  "reauth_required",
  "protected_environment",
] as const;

/** Why a shell was refused; see {@link SHELL_DENIALS}. */
export type ShellDenial = (typeof SHELL_DENIALS)[number];

/**
 * Decides whether a caller who passed authentication may open a shell, as
 * strictly as ADR 0014 §15 allows:
 * 1. OAuth (MCP) tokens never do.
 * 2. `shell:open` on the workload's environment, which only `project_admin`
 *    holds.
 * 3. Two-factor authentication enrolled, whatever the workspace policy.
 * 4. A browser or CLI session must be fresh (re-authenticated within 10
 *    minutes).
 * 5. API tokens can't be fresh, so they work only outside protected
 *    environments; a protected environment needs a fresh session.
 *
 * @param input - Facts about the caller and target.
 * @returns `{ allowed: true }`, or the first rule that failed.
 * @example
 * shellGate({ credential: "api_token", accessAllowed: true, twoFactorEnabled: true,
 *   freshSession: false, environmentProtected: true });
 * // { allowed: false, reason: "protected_environment" }
 */
export function shellGate(
  input: ShellGateInput,
): { allowed: true } | { allowed: false; reason: ShellDenial } {
  if (input.credential === "oauth") return { allowed: false, reason: "oauth_token" };
  if (!input.accessAllowed) return { allowed: false, reason: "forbidden" };
  if (!input.twoFactorEnabled) return { allowed: false, reason: "two_factor_required" };
  if (input.credential === "session" && !input.freshSession) {
    return { allowed: false, reason: "reauth_required" };
  }
  if (input.credential === "api_token" && input.environmentProtected) {
    return { allowed: false, reason: "protected_environment" };
  }
  return { allowed: true };
}

// -----------------------------------------------------------------------------
// Socket
// -----------------------------------------------------------------------------

/**
 * Close codes of `GET /v1/workloads/{workloadId}/shell`. Refusals happen
 * after the upgrade, as for the realtime socket, because a browser can't
 * read the status of a refused upgrade. 44xx mirror HTTP statuses.
 */
export const SHELL_CLOSE_CODES = {
  /** The session ended normally; an `exit` message came first. */
  normal: 1000,
  /** A malformed or unsupported client frame. */
  policy: 1008,
  /** A client frame over the size limit. */
  tooBig: 1009,
  /** No valid session or token. Sign in again. */
  unauthorized: 4401,
  /** No `shell:open` here, or access was revoked while open. Don't retry. */
  forbidden: 4403,
  /** The workload doesn't exist, isn't running, or isn't visible. */
  notFound: 4404,
  /** The node runs its maximum number of sessions. Retry later. */
  busy: 4409,
  /** The node's agent predates the shell protocol. Upgrade the agent. */
  agentOutdated: 4426,
  /** Re-authenticate (password, and code with 2FA), then retry. */
  reauthRequired: 4428,
  /** Turn on two-factor authentication first. */
  twoFactorRequired: 4430,
  /** An API token can't open a shell in a protected environment. */
  protectedEnvironment: 4431,
  /** The node's agent isn't connected. Retry later. */
  nodeUnavailable: 4503,
} as const;

/** A shell close code; see {@link SHELL_CLOSE_CODES}. */
export type ShellCloseCode = (typeof SHELL_CLOSE_CODES)[keyof typeof SHELL_CLOSE_CODES];

/** The close code for each {@link ShellDenial}. */
export const SHELL_DENIAL_CLOSE_CODES: Record<ShellDenial, ShellCloseCode> = {
  oauth_token: SHELL_CLOSE_CODES.unauthorized,
  forbidden: SHELL_CLOSE_CODES.forbidden,
  two_factor_required: SHELL_CLOSE_CODES.twoFactorRequired,
  reauth_required: SHELL_CLOSE_CODES.reauthRequired,
  protected_environment: SHELL_CLOSE_CODES.protectedEnvironment,
};

/** How long a session outlives its browser socket before it is closed (no resume in v1). */
export const SHELL_DISCONNECT_GRACE_MS = 30_000;

/** How long before the idle timeout the terminal starts its countdown. */
export const SHELL_IDLE_WARNING_S = 60;

/** Most output the relay buffers for one slow client before dropping it. */
export const SHELL_MAX_BUFFERED_OUTPUT_BYTES = 1024 * 1024;

/** Written to the terminal in place of output the relay dropped. */
export const SHELL_TRUNCATED_NOTICE = "\r\n[output truncated]\r\n";

/** Largest client frame the relay accepts (input batches are coalesced into ≤ 16 KiB). */
export const SHELL_MAX_CLIENT_FRAME_BYTES = 64 * 1024;

/**
 * Path of the shell socket.
 *
 * @param workloadId - The replica's workload ID (`wl_…`).
 * @returns E.g. `/v1/workloads/wl_1/shell`.
 */
export function shellPath(workloadId: string): string {
  return `/v1/workloads/${encodeURIComponent(workloadId)}/shell`;
}

/** Client → relay control messages (JSON text frames). */
export const ShellClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("resize"),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(500),
  }),
  z.object({ type: z.literal("close") }),
]);

/** A client → relay control message. */
export type ShellClientMessage = z.infer<typeof ShellClientMessageSchema>;

/** Relay → client control messages (JSON text frames). */
export type ShellServerMessage =
  | {
      /** The process started. */
      type: "opened";
      session_id: string;
      node_id: string;
      node_name: string;
      /** The container's user the process runs as. */
      user: string;
      replica: number;
      idle_timeout_s: number;
      max_duration_s: number;
    }
  | {
      /** The session ended; the socket closes with 1000 next. */
      type: "exit";
      code: number | null;
      reason: ShellExitReason;
      message?: string;
    };

/**
 * Why a session ended, as the client sees it: the agent's reasons
 * (`exited`, `closed`, `idle_timeout`, `max_duration`, `error`) plus
 * `revoked` (access changed), `node_disconnected` (the agent's connection
 * dropped) and `timeout` (the agent never answered the open).
 */
export type ShellExitReason =
  | "exited"
  | "closed"
  | "idle_timeout"
  | "max_duration"
  | "error"
  | "revoked"
  | "node_disconnected"
  | "timeout";
