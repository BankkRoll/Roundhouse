import { PRODUCT_NAME } from "@openrail/shared";

/**
 * Builds a browser tab title from the most to least specific part, skipping blanks.
 *
 * @param parts - e.g. the page and workspace names.
 * @returns e.g. `"Servers · Nightjar Labs · OpenRail"`.
 * @example
 * formatDocumentTitle("Servers", "Nightjar Labs"); // "Servers · Nightjar Labs · OpenRail"
 * formatDocumentTitle("Sign in");                  // "Sign in · OpenRail"
 */
export function formatDocumentTitle(...parts: (string | null | undefined)[]): string {
  return [...parts, PRODUCT_NAME]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(" · ");
}
