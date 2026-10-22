/**
 * Pure helpers for the new-service flow: checking what the user typed before the API
 * does, and suggesting a service name from the source.
 *
 * @module
 */
import { slugify } from "@openrail/shared";

/** Longest service name the API accepts. */
export const MAX_SERVICE_NAME = 100;

const IMAGE_CHARS = /^[A-Za-z0-9._\-/:@]+$/;

/**
 * Loose check of a Docker image reference. The API applies the full `distribution`
 * grammar; this only catches typos early (spaces, uppercase repositories, empty tags).
 *
 * @param image - What the user typed.
 * @returns An error message, or `null` when it looks plausible.
 * @example
 * imageReferenceError("nginx:1.27"); // null
 * imageReferenceError("My App");     // "Image references can't contain spaces."
 */
export function imageReferenceError(image: string): string | null {
  const value = image.trim();
  if (!value) return "Enter an image, e.g. nginx:1.27 or ghcr.io/acme/api:latest.";
  if (/\s/.test(value)) return "Image references can't contain spaces.";
  if (!IMAGE_CHARS.test(value)) return "Use letters, digits, and . _ - / : @ only.";
  const [name] = value.split("@");
  const lastSlash = (name ?? "").lastIndexOf("/");
  const colon = (name ?? "").lastIndexOf(":");
  const repository = colon > lastSlash ? (name ?? "").slice(0, colon) : (name ?? "");
  const path =
    repository.includes("/") && /[.:]|localhost/.test(repository.split("/")[0] ?? "")
      ? repository.split("/").slice(1).join("/")
      : repository;
  if (path !== path.toLowerCase()) return "Repository names must be lowercase.";
  if (colon > lastSlash && colon === (name ?? "").length - 1) return "The tag after : is empty.";
  return null;
}

/**
 * Checks a public git clone URL the way the API's schema does: HTTPS, a host and a path,
 * and no embedded credentials.
 *
 * @param url - What the user typed.
 * @returns An error message, or `null` when valid.
 */
export function gitUrlError(url: string): string | null {
  const value = url.trim();
  if (!value) return "Enter an HTTPS clone URL.";
  if (!value.startsWith("https://"))
    return "Use an https:// URL; SSH and git:// URLs aren't supported.";
  if (/^https:\/\/[^/]*@/.test(value)) return "Remove the credentials from the URL.";
  if (!/^https:\/\/[^\s/@?#]+\/[^\s?#]+$/.test(value))
    return "Expected a URL like https://github.com/acme/app.git.";
  return null;
}

/**
 * Checks a branch name the way the API's schema does.
 *
 * @param branch - What the user typed.
 * @returns An error message, or `null` when valid.
 */
export function branchError(branch: string): string | null {
  const value = branch.trim();
  if (!value) return "Enter a branch.";
  if (
    !/^[A-Za-z0-9._/-]+$/.test(value) ||
    value.startsWith("/") ||
    value.includes("..") ||
    /[/.]$/.test(value)
  ) {
    return "That isn't a valid branch name.";
  }
  return null;
}

/**
 * Checks a directory inside the repository: relative, without `..` or backslashes.
 *
 * @param dir - What the user typed; `.` is the repository root.
 * @returns An error message, or `null` when valid.
 */
export function rootDirError(dir: string): string | null {
  const value = dir.trim();
  if (!value) return "Enter a directory, or . for the repository root.";
  if (
    !/^[A-Za-z0-9._\-/]{1,512}$/.test(value) ||
    value.startsWith("/") ||
    value.split("/").includes("..")
  ) {
    return "Use a relative path inside the repository, like apps/web.";
  }
  return null;
}

/**
 * Suggests a service name from where its code comes from.
 *
 * @param source - An image reference or a repository URL.
 * @returns e.g. `"api"` for `ghcr.io/acme/api:1.4` or `"storefront"` for
 *   `https://github.com/acme/storefront.git`; empty when nothing usable.
 */
export function suggestServiceName(source: string): string {
  const value = source.trim();
  if (!value) return "";
  const withoutDigest = value.split("@")[0] ?? "";
  const lastSegment =
    withoutDigest
      .replace(/\.git$/, "")
      .replace(/\/+$/, "")
      .split("/")
      .pop() ?? "";
  const withoutTag = lastSegment.split(":")[0] ?? "";
  return slugify(withoutTag, 40, "");
}

/**
 * Parses an optional port field.
 *
 * @param value - What the user typed; empty means "no port".
 * @returns The port, `null` for none, or an error message.
 */
export function parsePort(value: string): number | null | string {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return "Enter a port from 1 to 65535.";
  return port;
}
