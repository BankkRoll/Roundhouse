/** Chromium's User-Agent Client Hints, not yet in TypeScript's DOM types. */
interface NavigatorUAData {
  platform: string;
}

/**
 * Whether the visitor is on an Apple platform, where Cmd replaces Ctrl in shortcuts.
 *
 * @param nav - Navigator to inspect. Defaults to the global one.
 * @returns `true` on macOS, iOS and iPadOS.
 */
export function isApplePlatform(
  nav: (Navigator & { userAgentData?: NavigatorUAData }) | undefined = globalThis.navigator,
): boolean {
  if (!nav) return false;
  // COMPAT: `navigator.platform` is deprecated; Client Hints only exist in Chromium, so
  // Safari and Firefox fall back to the user agent string.
  const platform = nav.userAgentData?.platform ?? nav.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform);
}
