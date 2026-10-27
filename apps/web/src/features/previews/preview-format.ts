/**
 * How previews read in the dashboard: status labels and tones, and the guard on links
 * that come from GitHub.
 *
 * @module
 */
import type { PreviewStatus } from "@roundhouse/shared";
import type { BadgeProps } from "@roundhouse/ui";

/** Label, badge tone and one-line explanation of a preview status. */
export interface PreviewStatusMeta {
  label: string;
  tone: NonNullable<BadgeProps["tone"]>;
  description: string;
}

/** Display of every preview status. */
export const PREVIEW_STATUS: Record<PreviewStatus, PreviewStatusMeta> = {
  pending_approval: {
    label: "Needs approval",
    tone: "warning",
    description: "A fork PR waits for a project admin to approve its current commit.",
  },
  fork_disabled: {
    label: "Forks off",
    tone: "neutral",
    description: "This project doesn't build pull requests from forks.",
  },
  queued_limit: {
    label: "Queued",
    tone: "neutral",
    description: "Waits for a free slot under the active preview limit.",
  },
  creating: {
    label: "Creating",
    tone: "info",
    description: "Its environment is being created and deployed.",
  },
  active: { label: "Active", tone: "success", description: "Deployed and reachable." },
  failed: {
    label: "Failed",
    tone: "danger",
    description: "Creating it failed; the next push retries.",
  },
  expired: {
    label: "Expired",
    tone: "neutral",
    description: "Torn down after a quiet spell; the next push brings it back.",
  },
  closed: {
    label: "Closed",
    tone: "neutral",
    description: "Torn down because the PR closed, merged, became a draft, or was deleted.",
  },
};

/**
 * An http(s) link from the API, or `null` for anything else.
 *
 * SECURITY: PR and service URLs are built from GitHub payloads; refusing other schemes
 * keeps a `javascript:` URL from ever reaching an `href`.
 *
 * @param url - URL as the API returned it.
 * @returns The URL when it is http or https.
 * @example
 * webUrl("https://github.com/acme/shop/pull/4"); // the same URL
 * webUrl("javascript:alert(1)"); // null
 */
export function webUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}
