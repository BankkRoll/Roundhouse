/**
 * The single HTTP client for the control-plane API, including the two Better Auth
 * endpoints the dashboard uses. Every request goes through {@link request}, which sends
 * the session cookie, encodes JSON, and turns non-2xx (or unparseable) responses into
 * {@link ApiError}s.
 *
 * @module
 */
import type { Role } from "@openrail/shared";
import type {
  AcceptInviteRequest,
  AcceptInviteResponse,
  ApiErrorBody,
  AuditLogPage,
  CreateInviteResponse,
  Invite,
  InvitePreview,
  JoinToken,
  Me,
  Member,
  Node,
  SetupRequest,
  SetupResponse,
  SetupStatus,
  SignInRequest,
  SignInResponse,
  Workspace,
} from "./types";

/**
 * Error thrown for any failed API call. Network failures use status `0` and code
 * `network_error`; a 2xx body that is not JSON gets `invalid_response`; error responses
 * without a recognisable body get code `http_<status>`.
 */
export class ApiError extends Error {
  override readonly name = "ApiError";

  /**
   * @param status - HTTP status, or 0 when the request never got a response.
   * @param code - Machine-readable error code from the API.
   * @param message - Human-readable message, safe to show to the user.
   */
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Narrows an unknown error to {@link ApiError}, optionally matching a status or code.
 *
 * @param error - Anything caught from a request.
 * @param match - Optional HTTP status (number) or error code (string) to require.
 * @returns `true` when `error` is an ApiError that satisfies `match`.
 * @example
 * if (isApiError(err, 401)) redirectToLogin();
 * if (isApiError(err, "already_setup")) showNotice();
 */
export function isApiError(error: unknown, match?: number | string): error is ApiError {
  if (!(error instanceof ApiError)) return false;
  if (match === undefined) return true;
  return typeof match === "number" ? error.status === match : error.code === match;
}

/**
 * Picks a message to show for any error thrown by a query or mutation.
 *
 * @param error - The caught error.
 * @param fallback - Message used when the error carries nothing useful.
 * @returns A user-facing message.
 */
export function errorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/** Options for {@link request}. */
export interface RequestOptions {
  /** JSON-serialisable body. */
  body?: unknown;
  /** Query parameters; `undefined` and `null` values are skipped. */
  query?: Record<string, string | number | null | undefined>;
  /** Abort signal, usually from TanStack Query. */
  signal?: AbortSignal;
}

function isEnvelope(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const inner = (value as { error: unknown }).error;
  return (
    typeof inner === "object" &&
    inner !== null &&
    typeof (inner as { code?: unknown }).code === "string" &&
    typeof (inner as { message?: unknown }).message === "string"
  );
}

/** Better Auth reports its own errors flat, as `{ code?, message }`. */
function isBetterAuthError(value: unknown): value is { code?: string; message: string } {
  if (typeof value !== "object" || value === null) return false;
  const { code, message } = value as { code?: unknown; message?: unknown };
  return (
    typeof message === "string" &&
    message !== "" &&
    (code === undefined || typeof code === "string")
  );
}

function buildUrl(path: string, query: RequestOptions["query"]): string {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function readError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (isEnvelope(body)) {
    return new ApiError(response.status, body.error.code, body.error.message);
  }
  if (isBetterAuthError(body)) {
    return new ApiError(
      response.status,
      body.code?.toLowerCase() ?? `http_${response.status}`,
      body.message,
    );
  }
  return new ApiError(
    response.status,
    `http_${response.status}`,
    response.statusText || `Request failed with status ${response.status}.`,
  );
}

/**
 * Performs an API request.
 *
 * @param method - HTTP method.
 * @param path - Same-origin path such as `/v1/me`. Interpolated segments must already be
 *   encoded.
 * @param options - Body, query and abort signal.
 * @returns The parsed JSON body, or `undefined` for 204 and empty responses.
 * @throws {ApiError} For non-2xx responses, non-JSON bodies and network failures.
 */
export async function request<T>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      credentials: "include",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (cause) {
    // NOTE: Checked via the signal rather than `instanceof DOMException`, because the abort
    // error can come from another realm (undici vs. the page) and fail that check.
    if (options.signal?.aborted) throw cause;
    throw new ApiError(0, "network_error", "Could not reach the server. Check your connection.");
  }

  if (!response.ok) throw await readError(response);
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // NOTE: Usually an HTML page from a proxy, or the SPA fallback answering a path the
    // Worker does not route; without this it would surface as a raw SyntaxError.
    throw new ApiError(
      response.status,
      "invalid_response",
      "The server sent an unexpected response. Try again in a moment.",
    );
  }
}

const seg = encodeURIComponent;

/**
 * Typed endpoint functions, one per API route.
 *
 * @example
 * const { nodes } = await api.listNodes("ws_123");
 */
export const api = {
  /**
   * Reads first-run setup state.
   *
   * @param signal - Abort signal.
   * @returns Whether setup is still needed and whether MASTER_KEY is configured.
   */
  getSetup: (signal?: AbortSignal) => request<SetupStatus>("GET", "/v1/setup", { signal }),
  /**
   * Creates the first admin and workspace, and signs the admin in.
   *
   * @param body - Master key, account details and workspace name.
   * @returns The new user and workspace ids.
   */
  completeSetup: (body: SetupRequest) => request<SetupResponse>("POST", "/v1/setup", { body }),

  /**
   * Signs in with email and password through Better Auth, which sets the session cookie.
   *
   * @param body - Credentials.
   * @returns The signed-in user.
   */
  signIn: (body: SignInRequest) =>
    request<SignInResponse>("POST", "/api/auth/sign-in/email", { body }),
  /**
   * Ends the session through Better Auth, which clears the cookie.
   *
   * @returns Resolves once the server has dropped the session.
   */
  signOut: () => request<{ success: boolean }>("POST", "/api/auth/sign-out", { body: {} }),

  /**
   * Reads the signed-in user and their workspaces. 401 means signed out.
   *
   * @param signal - Abort signal.
   * @returns The user and their memberships, sorted by workspace name.
   */
  getMe: (signal?: AbortSignal) => request<Me>("GET", "/v1/me", { signal }),

  /**
   * Creates a workspace owned by the caller. Only owners and admins of some workspace may
   * do this; everyone else gets 403.
   *
   * @param name - Display name.
   * @returns The new workspace.
   */
  createWorkspace: (name: string) =>
    request<Workspace>("POST", "/v1/workspaces", { body: { name } }),
  /**
   * Reads one workspace with the caller's role.
   *
   * @param workspaceId - Workspace id.
   * @param signal - Abort signal.
   * @returns The workspace.
   */
  getWorkspace: (workspaceId: string, signal?: AbortSignal) =>
    request<Workspace>("GET", `/v1/workspaces/${seg(workspaceId)}`, { signal }),
  /**
   * Renames a workspace. The slug does not change.
   *
   * @param workspaceId - Workspace id.
   * @param body - New name.
   * @returns The updated workspace.
   */
  updateWorkspace: (workspaceId: string, body: { name: string }) =>
    request<Workspace>("PATCH", `/v1/workspaces/${seg(workspaceId)}`, { body }),

  /**
   * Lists a workspace's members, oldest first.
   *
   * @param workspaceId - Workspace id.
   * @param signal - Abort signal.
   * @returns The members envelope.
   */
  listMembers: (workspaceId: string, signal?: AbortSignal) =>
    request<{ members: Member[] }>("GET", `/v1/workspaces/${seg(workspaceId)}/members`, {
      signal,
    }),
  /**
   * Changes a member's role. Fails with 409 `last_owner` when no owner would remain.
   *
   * @param workspaceId - Workspace id.
   * @param memberId - Membership id.
   * @param role - New role.
   * @returns The updated member.
   */
  updateMember: (workspaceId: string, memberId: string, role: Role) =>
    request<Member>("PATCH", `/v1/workspaces/${seg(workspaceId)}/members/${seg(memberId)}`, {
      body: { role },
    }),
  /**
   * Removes a member. Passing the caller's own membership id leaves the workspace.
   *
   * @param workspaceId - Workspace id.
   * @param memberId - Membership id.
   * @returns Resolves on 204.
   */
  removeMember: (workspaceId: string, memberId: string) =>
    request<void>("DELETE", `/v1/workspaces/${seg(workspaceId)}/members/${seg(memberId)}`),

  /**
   * Lists invites that are neither accepted nor expired, newest first.
   *
   * @param workspaceId - Workspace id.
   * @param signal - Abort signal.
   * @returns The invites envelope.
   */
  listInvites: (workspaceId: string, signal?: AbortSignal) =>
    request<{ invites: Invite[] }>("GET", `/v1/workspaces/${seg(workspaceId)}/invites`, {
      signal,
    }),
  /**
   * Invites someone by email. The API stores the address lowercased.
   *
   * @param workspaceId - Workspace id.
   * @param body - Email and role.
   * @returns The invite and the one-time URL to share.
   */
  createInvite: (workspaceId: string, body: { email: string; role: Role }) =>
    request<CreateInviteResponse>("POST", `/v1/workspaces/${seg(workspaceId)}/invites`, {
      body,
    }),
  /**
   * Revokes a pending invite.
   *
   * @param workspaceId - Workspace id.
   * @param inviteId - Invite id.
   * @returns Resolves on 204.
   */
  revokeInvite: (workspaceId: string, inviteId: string) =>
    request<void>("DELETE", `/v1/workspaces/${seg(workspaceId)}/invites/${seg(inviteId)}`),

  /**
   * Previews an invite link (public). 404 when the link is invalid, used or expired.
   *
   * @param token - Token from the invite URL.
   * @param signal - Abort signal.
   * @returns Workspace name, invited email, role and expiry.
   */
  getInvite: (token: string, signal?: AbortSignal) =>
    request<InvitePreview>("GET", `/v1/invites/${seg(token)}`, { signal }),
  /**
   * Accepts an invite, creating the account first when signed out.
   *
   * @param token - Token from the invite URL.
   * @param body - Name and password when signed out; empty otherwise.
   * @returns The joined workspace id.
   */
  acceptInvite: (token: string, body: AcceptInviteRequest) =>
    request<AcceptInviteResponse>("POST", `/v1/invites/${seg(token)}/accept`, { body }),

  /**
   * Lists a workspace's servers, sorted by name.
   *
   * @param workspaceId - Workspace id.
   * @param signal - Abort signal.
   * @returns The nodes envelope.
   */
  listNodes: (workspaceId: string, signal?: AbortSignal) =>
    request<{ nodes: Node[] }>("GET", `/v1/workspaces/${seg(workspaceId)}/nodes`, { signal }),
  /**
   * Reads one server.
   *
   * @param workspaceId - Workspace id.
   * @param nodeId - Node id.
   * @param signal - Abort signal.
   * @returns The node.
   */
  getNode: (workspaceId: string, nodeId: string, signal?: AbortSignal) =>
    request<Node>("GET", `/v1/workspaces/${seg(workspaceId)}/nodes/${seg(nodeId)}`, {
      signal,
    }),
  /**
   * Removes a server and revokes its credential.
   *
   * @param workspaceId - Workspace id.
   * @param nodeId - Node id.
   * @returns Resolves on 204.
   */
  deleteNode: (workspaceId: string, nodeId: string) =>
    request<void>("DELETE", `/v1/workspaces/${seg(workspaceId)}/nodes/${seg(nodeId)}`),
  /**
   * Mints a single-use join token that expires after `JOIN_TOKEN_TTL_MS`.
   *
   * @param workspaceId - Workspace id.
   * @returns The token, its expiry and the install one-liner.
   */
  createJoinToken: (workspaceId: string) =>
    request<JoinToken>("POST", `/v1/workspaces/${seg(workspaceId)}/nodes/join-tokens`),

  /**
   * Reads one page of the audit log, newest first.
   *
   * @param workspaceId - Workspace id.
   * @param params - Cursor from the previous page, and page size (1-200).
   * @param signal - Abort signal.
   * @returns The entries and the cursor for the next page.
   */
  listAuditLogs: (
    workspaceId: string,
    params: { cursor?: string | null; limit?: number } = {},
    signal?: AbortSignal,
  ) =>
    request<AuditLogPage>("GET", `/v1/workspaces/${seg(workspaceId)}/audit-logs`, {
      query: { cursor: params.cursor, limit: params.limit },
      signal,
    }),
};
