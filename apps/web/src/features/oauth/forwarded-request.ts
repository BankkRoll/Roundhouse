import type { AuthorizationParams } from "../../lib/api/oauth-types";

const PARAM_NAMES = [
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "resource",
  "scope",
] as const satisfies readonly (keyof AuthorizationParams)[];

/**
 * Decodes the `request` value `/oauth/authorize` forwards to the consent page: the
 * client's parameters as base64url JSON. Anything malformed decodes to no parameters,
 * which the API then rejects with a readable error.
 *
 * @param value - The page's `request` query value.
 * @returns The authorization parameters, strings only.
 * @example
 * decodeForwardedRequest("eyJjbGllbnRfaWQiOiJ4In0"); // { client_id: "x" }
 */
export function decodeForwardedRequest(value: string | undefined): AuthorizationParams {
  if (!value) return {};
  let parsed: unknown;
  try {
    const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const params: AuthorizationParams = {};
  for (const name of PARAM_NAMES) {
    const v = (parsed as Record<string, unknown>)[name];
    if (typeof v === "string") params[name] = v;
  }
  return params;
}
