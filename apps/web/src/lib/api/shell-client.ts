/**
 * Typed endpoint functions and wire types for the web shell (ADR 0012 "Web shell",
 * ADR 0014 §15): the replicas a service can open a shell in, whether the caller may,
 * the socket URL, and the audit list of sessions.
 *
 * Types come from the API's route contracts (`apps/api/src/contracts/shell.ts`), so a
 * contract change that breaks the dashboard fails typecheck.
 *
 * @module
 */
import { shellPath } from "@roundhouse/shared";
import type {
  ResponseOf,
  ShellSession,
  ShellTargets,
  terminateShellSession,
} from "../../../../api/src/contracts";
import { request } from "./client";

export type { ShellSession, ShellTargets };

/** One replica a shell can open in. */
export type ShellTarget = ShellTargets["targets"][number];

/** Whether the caller may open a shell, and the first rule refusing it otherwise. */
export type ShellGate = ShellTargets["gate"];

/** A page of shell sessions, newest first. */
export interface ShellSessionPage {
  sessions: ShellSession[];
  next_cursor: string | null;
}

/** `POST /v1/shell-sessions/{id}/terminate` response: the ended session. */
export type TerminatedShellSession = ResponseOf<typeof terminateShellSession, 200>;

/** Terminal type the dashboard asks the agent to set. */
export const SHELL_TERM = "xterm-256color";

/**
 * Absolute `ws:`/`wss:` URL of a replica's shell socket. Authenticated by the session
 * cookie, so it must be the page's own origin.
 *
 * @param workloadId - The replica's workload id.
 * @param size - The terminal's columns and rows when it opens.
 * @param origin - Page origin; defaults to `window.location.origin`.
 * @returns The URL.
 * @example
 * shellSocketUrl("wl_1", { cols: 80, rows: 24 }, "https://cp.example.com");
 * // "wss://cp.example.com/v1/workloads/wl_1/shell?cols=80&rows=24&term=xterm-256color"
 */
export function shellSocketUrl(
  workloadId: string,
  size: { cols: number; rows: number },
  origin = window.location.origin,
): string {
  const url = new URL(shellPath(workloadId), origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("cols", String(size.cols));
  url.searchParams.set("rows", String(size.rows));
  url.searchParams.set("term", SHELL_TERM);
  return url.toString();
}

const seg = encodeURIComponent;

/** Web shell endpoints. */
export const shellApi = {
  /**
   * Lists the replicas of a service in an environment a shell can open in, and whether
   * the caller may open one there.
   *
   * @param serviceId - Service id.
   * @param environmentId - Environment id.
   * @param signal - Abort signal.
   * @returns Targets and the gate.
   */
  listTargets: (serviceId: string, environmentId: string, signal?: AbortSignal) =>
    request<ShellTargets>("GET", `/v1/services/${seg(serviceId)}/shell-targets`, {
      query: { environment_id: environmentId },
      signal,
    }),
  /**
   * Lists a workspace's shell sessions, newest first. Needs `audit:read`.
   *
   * @param workspaceId - Workspace id.
   * @param params - Project filter and cursor.
   * @param signal - Abort signal.
   * @returns One page.
   */
  listSessions: (
    workspaceId: string,
    params: { projectId?: string; cursor?: string | null } = {},
    signal?: AbortSignal,
  ) =>
    request<ShellSessionPage>("GET", `/v1/workspaces/${seg(workspaceId)}/shell-sessions`, {
      query: { project_id: params.projectId, cursor: params.cursor },
      signal,
    }),
  /**
   * Ends an open shell session.
   *
   * @param sessionId - Session id.
   * @returns The session as ended; 409 when it already had.
   */
  terminateSession: (sessionId: string) =>
    request<TerminatedShellSession>("POST", `/v1/shell-sessions/${seg(sessionId)}/terminate`),
};
