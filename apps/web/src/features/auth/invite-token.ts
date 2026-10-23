/**
 * The invite token's trip from the link to the API.
 *
 * SECURITY: Invite links carry the token in the URL fragment (`/invite#token=…`), which
 * browsers never send to a server or put in a `Referer`. {@link takeInviteToken} strips
 * it from the address bar (a history `replaceState`) before anything is fetched, so it
 * doesn't linger in history or get copied along with the URL, and the API receives it
 * only in request bodies. It is kept in `sessionStorage` (this tab only) so a reload or
 * the "sign in first" detour can still finish, and dropped once the invite is accepted
 * or turns out to be unusable.
 *
 * @module
 */

const STORAGE_KEY = "roundhouse.invite-token";

type TokenStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Where the token is read from and remembered, injectable for tests. */
export interface InviteTokenEnv {
  /** The URL fragment, with or without its leading `#`. */
  hash: string;
  /** Replaces the current history entry with the same URL minus its fragment. */
  dropHash: () => void;
  /** Per-tab storage, or `null` when the browser blocks it. */
  storage: TokenStorage | null;
}

/**
 * This tab's `sessionStorage`, or `null` when site data is blocked.
 *
 * @returns The storage.
 */
export function tabStorage(): TokenStorage | null {
  try {
    return window.sessionStorage;
  } catch {
    // NOTE: Storage access throws with site data blocked; the link still works once.
    return null;
  }
}

function browserEnv(): InviteTokenEnv {
  return {
    hash: window.location.hash,
    dropHash: () =>
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + window.location.search,
      ),
    storage: tabStorage(),
  };
}

/**
 * Reads the invite token from the URL fragment and removes it from the address bar at
 * once, falling back to the one remembered for this tab.
 *
 * @param env - Fragment, history and storage (defaults to `window`'s).
 * @returns The token, or `null` when there is none.
 * @example
 * // On /invite#token=inv_abc: returns "inv_abc" and the address bar shows /invite.
 * const token = takeInviteToken();
 */
export function takeInviteToken(env: InviteTokenEnv = browserEnv()): string | null {
  const fromHash = new URLSearchParams(env.hash.replace(/^#/, "")).get("token");
  if (fromHash) {
    env.dropHash();
    try {
      env.storage?.setItem(STORAGE_KEY, fromHash);
    } catch {
      // Quota or privacy mode: the token still works for this page view.
    }
    return fromHash;
  }
  try {
    return env.storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

/**
 * Forgets the remembered token, after it was accepted or refused.
 *
 * @param storage - Per-tab storage (defaults to this tab's).
 */
export function forgetInviteToken(storage: TokenStorage | null = tabStorage()): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to forget when storage is unavailable.
  }
}
