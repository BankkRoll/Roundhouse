/**
 * Turns a display name into a URL-safe slug.
 *
 * @param name - Arbitrary human-entered name.
 * @param maxLength - Upper bound on the result length.
 * @returns Lowercase ASCII slug, or `"workspace"` if nothing usable remains.
 * @example
 * slugify("Acme Corp — Prod!"); // "acme-corp-prod"
 */
export function slugify(name: string, maxLength = 40): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/, "");
  return slug || "workspace";
}
