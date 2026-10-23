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

/**
 * Picks `base`, or the first of `base-2`, `base-3`, … that is neither taken nor
 * reserved, shortening `base` so the result stays within `maxLength`. This is
 * how every slug the API allocates resolves a collision, so a client can
 * predict the slug it will get.
 *
 * @param taken - Slugs already in use in the scope.
 * @param base - Preferred slug.
 * @param reserved - Slugs that may never be used, even when free.
 * @param maxLength - Upper bound on the result length.
 * @returns A slug in neither set.
 * @example
 * freeSlug(new Set(["api"]), "api"); // "api-2"
 * freeSlug(new Set(), "shared", ["shared"]); // "shared-2"
 */
export function freeSlug(
  taken: ReadonlySet<string>,
  base: string,
  reserved: readonly string[] = [],
  maxLength = 40,
): string {
  const unavailable = (s: string) => taken.has(s) || reserved.includes(s);
  if (!unavailable(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const candidate = `${base.slice(0, maxLength - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!unavailable(candidate)) return candidate;
  }
}
