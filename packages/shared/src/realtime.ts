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

// -----------------------------------------------------------------------------
// Presence (ADR 0006 "Realtime and multiplayer")
// -----------------------------------------------------------------------------

/** Distinct presence colours; a user's colour is a stable index below this. */
export const PRESENCE_COLORS = 12;

/** Most service IDs one user's selection carries. */
export const MAX_PRESENCE_SELECTION = 32;

/** `presence.update` frames one socket may send per second; extras are dropped. */
export const PRESENCE_UPDATES_PER_SECOND = 10;

/** Shortest time between two presence broadcasts of one project. */
export const PRESENCE_BROADCAST_INTERVAL_MS = 100;

/** What part of a service someone is editing, as the canvas shows it. */
export const PRESENCE_EDIT_PARTS = [
  "service",
  "config",
  "variables",
  "volume",
  "domains",
  "connections",
] as const;

/** A part of a service being edited; see {@link PRESENCE_EDIT_PARTS}. */
export type PresenceEditPart = (typeof PRESENCE_EDIT_PARTS)[number];

/**
 * A user's presence colour: FNV-1a of the user ID, so every client picks the
 * same colour for the same person without asking the server.
 *
 * @param userId - The user's ID.
 * @returns An index in `0 … PRESENCE_COLORS - 1`.
 * @example
 * presenceColor("usr_01J9"); // the same number on every client
 */
export function presenceColor(userId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % PRESENCE_COLORS;
}
