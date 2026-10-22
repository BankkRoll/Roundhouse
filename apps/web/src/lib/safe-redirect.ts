/**
 * Validates a post-login redirect target.
 *
 * SECURITY: The value comes from the URL, so anything that could leave the origin
 * (absolute URLs, protocol-relative `//host`, backslash tricks browsers normalise to `//`)
 * is replaced with the fallback to prevent open redirects.
 *
 * @param target - Untrusted redirect path, usually from `?redirect=`.
 * @param fallback - Path used when `target` is missing or unsafe. Defaults to `/`.
 * @returns A same-origin path.
 * @example
 * safeRedirect("/w/ws_1/servers"); // "/w/ws_1/servers"
 * safeRedirect("https://evil.example"); // "/dashboard"
 */
export function safeRedirect(target: unknown, fallback = "/dashboard"): string {
  if (typeof target !== "string" || target.length === 0) return fallback;
  if (!target.startsWith("/")) return fallback;
  if (target.startsWith("//")) return fallback;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\u0000-\u001f\\]/.test(target)) return fallback;
  if (target.startsWith("/login") || target.startsWith("/setup")) return fallback;
  return target;
}
