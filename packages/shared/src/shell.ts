/**
 * Web shell vocabulary shared by the API (the relay in the node Durable
 * Object), the dashboard terminal and the CLI (ADR 0012 "Web shell", ADR
 * 0014 §15):
 * - {@link shellGate}: who may open a shell, beyond `shell:open`;
 * - {@link SHELL_CLOSE_CODES}: how a shell socket ends, and what the client
 *   should do about it;
 * - the browser ↔ relay frames ({@link ShellClientMessage},
 *   {@link ShellServerMessage}): binary frames carry terminal bytes both
 *   ways, JSON text frames carry control messages;
 * - recording: the instance settings ({@link SHELL_RECORDING_MODES}) and the
 *   asciicast v2 reader the dashboard player uses ({@link parseAsciicast}).
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
      /** The session is recorded (keystrokes and output); clients say so at start. */
      recorded: boolean;
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

// -----------------------------------------------------------------------------
// Recording
// -----------------------------------------------------------------------------

/**
 * What the instance setting `shell_recording` keeps of a session:
 * `metadata` only the `shell_sessions` row and audit entries, `full` also an
 * encrypted asciicast of its input and output.
 */
export const SHELL_RECORDING_MODES = ["metadata", "full"] as const;

/** A `shell_recording` value. */
export type ShellRecordingMode = (typeof SHELL_RECORDING_MODES)[number];

/** `shell_recording` until an instance admin changes it (ADR 0012). */
export const DEFAULT_SHELL_RECORDING: ShellRecordingMode = "full";

/** Days recordings are kept until an instance admin changes `shell_recording_retention_days`. */
export const DEFAULT_SHELL_RECORDING_RETENTION_DAYS = 30;

/** Longest recording retention an instance admin can choose, in days. */
export const MAX_SHELL_RECORDING_RETENTION_DAYS = 365;

/**
 * A session row's recording state: `none` (not recorded, or deleted by
 * retention), `recording` (open, or its last part not yet stored),
 * `stored` (playable) or `failed` (storing it failed; nothing to play).
 */
export const SHELL_RECORDING_STATES = ["none", "recording", "stored", "failed"] as const;

/** A `shell_sessions.recording` value. */
export type ShellRecordingState = (typeof SHELL_RECORDING_STATES)[number];

/** Media type of a recording as the playback route serves it. */
export const ASCIICAST_CONTENT_TYPE = "application/x-asciicast";

/** The header line of an asciicast v2 recording. */
export interface AsciicastHeader {
  version: 2;
  width: number;
  height: number;
  /** Unix seconds the session opened. */
  timestamp?: number;
  env?: Record<string, string>;
}

/**
 * One asciicast v2 event: seconds since the start, then `o` (output), `i`
 * (input) or `r` (resize, `"COLSxROWS"`), then its text.
 */
export type AsciicastEvent = [time: number, kind: "o" | "i" | "r", data: string];

/** A parsed asciicast v2 recording. */
export interface Asciicast {
  header: AsciicastHeader;
  events: AsciicastEvent[];
  /** Time of the last event, in seconds. */
  duration: number;
}

/**
 * Parses asciicast v2 text (newline-delimited JSON: a header, then events).
 * Lines that aren't events of a known kind are skipped, so a player keeps
 * working on a recording with event kinds it doesn't know (`m` markers).
 *
 * @param text - The recording.
 * @returns The header and the events in order.
 * @throws {Error} When the first line isn't a version 2 header.
 * @example
 * const cast = parseAsciicast('{"version":2,"width":80,"height":24}\n[0.5,"o","hi"]\n');
 * cast.events; // [[0.5, "o", "hi"]]
 */
export function parseAsciicast(text: string): Asciicast {
  const lines = text.split("\n");
  let header: unknown;
  try {
    header = JSON.parse(lines[0] ?? "");
  } catch {
    throw new Error("Not an asciicast recording");
  }
  const h = header as Partial<AsciicastHeader> | null;
  if (
    h?.version !== 2 ||
    !Number.isInteger(h.width) ||
    !Number.isInteger(h.height) ||
    (h.width as number) < 1 ||
    (h.height as number) < 1
  ) {
    throw new Error("Not an asciicast v2 recording");
  }
  const events: AsciicastEvent[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      Array.isArray(event) &&
      typeof event[0] === "number" &&
      Number.isFinite(event[0]) &&
      (event[1] === "o" || event[1] === "i" || event[1] === "r") &&
      typeof event[2] === "string"
    ) {
      events.push([event[0], event[1], event[2]]);
    }
  }
  return {
    header: h as AsciicastHeader,
    events,
    duration: events.reduce((max, [t]) => Math.max(max, t), 0),
  };
}

/**
 * Parses a resize event's `"COLSxROWS"`.
 *
 * @param data - The event's text.
 * @returns The size, or `null` when malformed.
 */
export function parseAsciicastSize(data: string): { cols: number; rows: number } | null {
  const match = /^(\d{1,4})x(\d{1,4})$/.exec(data);
  if (!match) return null;
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  return cols > 0 && rows > 0 ? { cols, rows } : null;
}
