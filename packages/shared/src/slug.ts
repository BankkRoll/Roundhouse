/**
 * Turns a display name into a URL-safe slug.
 *
 * @param name - Arbitrary human-entered name.
 * @param maxLength - Upper bound on the result length.
 * @param fallback - Returned when nothing usable remains.
 * @returns Lowercase ASCII slug of `[a-z0-9-]` that neither starts nor ends with `-`.
 * @example
 * slugify("Acme Corp — Prod!"); // "acme-corp-prod"
 */
export function slugify(name: string, maxLength = 40, fallback = "workspace"): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/, "");
  return slug || fallback;
}
