import { PRODUCT_NAME } from "@roundhouse/shared";

/**
 * Builds a browser tab title from the most to least specific part, skipping blanks.
 *
 * @param parts - e.g. the page and workspace names.
 * @returns e.g. `"Servers · Nightjar Labs · Roundhouse"`.
 * @example
 * formatDocumentTitle("Servers", "Nightjar Labs"); // "Servers · Nightjar Labs · Roundhouse"
 * formatDocumentTitle("Sign in");                  // "Sign in · Roundhouse"
 */
export function formatDocumentTitle(...parts: (string | null | undefined)[]): string {
  return [...parts, PRODUCT_NAME]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" · ");
}
