/**
 * Realtime socket vocabulary shared by the API (`ProjectRoom`), the dashboard
 * and the CLI: the close codes a project socket can end with, and how often
 * the server re-checks the identity behind an open socket.
 *
 * @module
 */

/**
 * WebSocket close codes of `/v1/projects/{projectId}/realtime`. The 44xx
 * codes mirror HTTP statuses. Authentication and authorization failures are
 * reported this way, after the upgrade, because a browser can't read the
 * status of a refused upgrade.
 */
export const REALTIME_CLOSE_CODES = {
  /** A malformed or unsupported client frame. */
  policy: 1008,
  /** A client frame over the size limit. */
  tooBig: 1009,
  /** No valid session or token, or it expired or was revoked while connected. Sign in again. */
  unauthorized: 4401,
  /** The caller lost access (membership, role or token scope). Don't reconnect. */
  forbidden: 4403,
  /** The project doesn't exist or isn't visible to the caller. Don't reconnect. */
  notFound: 4404,
} as const;

/** A realtime close code; see {@link REALTIME_CLOSE_CODES}. */
export type RealtimeCloseCode = (typeof REALTIME_CLOSE_CODES)[keyof typeof REALTIME_CLOSE_CODES];

/** How often an open socket's session or token and membership are re-checked. */
export const REALTIME_RECHECK_INTERVAL_MS = 60_000;

/**
 * Whether a client should reconnect after its socket closed with `code`.
 *
 * @param code - Close code from the `close` event.
 * @returns `false` for the codes that mean "this will keep failing" (4401,
 *   4403, 4404, 1008, 1009); `true` for network drops and server restarts.
 */
export function shouldReconnect(code: number): boolean {
  return !(Object.values(REALTIME_CLOSE_CODES) as number[]).includes(code);
}
