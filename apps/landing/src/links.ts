/**
 * Outbound links and copy-pasteable commands used across the landing page.
 *
 * @module
 */

/** Source repository. */
export const REPO_URL = "https://github.com/BankkRoll/Roundhouse";

/** Agent and dashboard releases. */
export const RELEASES_URL = `${REPO_URL}/releases`;

/**
 * Where "Deploy to Cloudflare" leads. The README install section until the one-click
 * deploy button for `apps/api` works.
 */
export const DEPLOY_URL = `${REPO_URL}#install`;

/** Documentation entry point. The README is the docs until a docs site exists. */
export const DOCS_URL = `${REPO_URL}#readme`;

/** Contribution guide. */
export const CONTRIBUTING_URL = `${REPO_URL}/blob/main/CONTRIBUTING.md`;

/** Private vulnerability reporting. */
export const SECURITY_URL = `${REPO_URL}/security/advisories/new`;

/**
 * Agent install one-liner, in the exact shape the control plane prints (see
 * `installCommand` in apps/api), with placeholders for the install's origin and token.
 */
export const INSTALL_COMMAND =
  "curl -fsSL https://<your-control-plane>/install.sh | sudo bash -s -- --token <token>";

/** Stores the master key as a Worker secret; the setup wizard shows the same command. */
export const MASTER_KEY_COMMAND = "npx wrangler secret put MASTER_KEY";

/** The security policy: how to report a vulnerability and what is in scope. */
export const SECURITY_POLICY_URL = `${REPO_URL}/blob/main/SECURITY.md`;

/** The October 2026 security review, its findings and the crypto test-vector evidence. */
export const SECURITY_REVIEW_URL = `${REPO_URL}/blob/main/docs/security/review-2026-10.md`;

/**
 * Links a file or folder on the default branch, so a claim on the page can point at the
 * code that makes it true.
 *
 * @param path - Repository-relative path, without a leading slash.
 * @returns The GitHub URL.
 * @example
 * sourceUrl("agent/internal/conn/replay.go");
 * // "https://github.com/BankkRoll/Roundhouse/blob/main/agent/internal/conn/replay.go"
 */
export function sourceUrl(path: string): string {
  return `${REPO_URL}/blob/main/${path}`;
}
