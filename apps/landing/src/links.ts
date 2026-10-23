/**
 * Outbound links and copy-pasteable commands used across the landing page.
 *
 * @module
 */

/** Source repository. */
export const REPO_URL = "https://github.com/BankkRoll/Open-Rail";

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
