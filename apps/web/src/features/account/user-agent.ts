/**
 * Turns a session's `User-Agent` into what people recognise: "Chrome on macOS",
 * "roundhouse CLI". Best effort; anything unrecognised is shown as "Unknown device".
 *
 * @module
 */
import { PRODUCT_NAME } from "@roundhouse/shared";

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\//, "Opera"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\//, "Chrome"],
  [/\bSafari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/\biPhone|\biPad/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bMac OS X|\bMacintosh/, "macOS"],
  [/\bWindows\b/, "Windows"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b/, "Linux"],
];

/**
 * Describes the device behind a session.
 *
 * @param userAgent - The session's `User-Agent`, if it sent one.
 * @returns A short description.
 * @example
 * describeUserAgent("Mozilla/5.0 (Macintosh; …) Chrome/131.0 Safari/537.36"); // "Chrome on macOS"
 * describeUserAgent("roundhouse-cli/0.4.0 (linux; amd64)"); // "Roundhouse CLI"
 */
export function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  if (/^roundhouse(-cli)?\//i.test(userAgent)) return `${PRODUCT_NAME} CLI`;
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? "Unknown device";
}
