/**
 * What the security section claims about Roundhouse's design, one entry per defence.
 *
 * Every entry names the file that makes it true, and the page links it, so a reader can
 * check the claim against the code. Keep the copy to what that file does: no claim goes
 * here without its evidence.
 *
 * @module
 */

import { JOIN_TOKEN_MINUTES } from "../content";

/** Identifier of one defence, used by the advisory table to say what blocks a class. */
export type DefenceId =
  | "dial-out"
  | "signed"
  | "arguments"
  | "paths"
  | "networks"
  | "builds"
  | "write-only"
  | "sealed"
  | "master-key"
  | "forks"
  | "two-factor"
  | "setup"
  | "access"
  | "reauth"
  | "protected"
  | "audit"
  | "cloudflare"
  | "origin"
  | "page-policy"
  | "github"
  | "releases"
  | "join";

/** The part of the system a defence protects; each group is one block of the section. */
export type DefenceGroup = "servers" | "secrets" | "account" | "control-plane";

/** One design choice and the code behind it. */
export interface Defence {
  id: DefenceId;
  group: DefenceGroup;
  /** Short name, set as the row's title. */
  title: string;
  /** One or two plain sentences on what it does for the user. */
  body: string;
  /** Repository path of the code or document that makes the claim true. */
  evidence: string;
}

/** Every defence, in the order the page shows them within each group. */
export const DEFENCES: readonly Defence[] = [
  {
    id: "dial-out",
    group: "servers",
    title: "Servers call out, nothing calls in",
    body: "The agent on each server opens the connection to your control plane. No port on the server waits for commands, and the control plane holds no SSH keys to it.",
    evidence: "agent/internal/conn/conn.go",
  },
  {
    id: "signed",
    group: "servers",
    title: "Every command is signed, and works once",
    body: "Commands carry an Ed25519 signature from a key the server pinned when it joined, checked before a single field is read. A copy of one already run is refused, and commands carrying a password expire within a minute.",
    evidence: "packages/protocol/go/envelope.go",
  },
  {
    id: "arguments",
    group: "servers",
    title: "Settings never become shell commands",
    body: "What you type reaches the server as checked fields, passed to programs as separate arguments, never pasted into a shell. Git branch names are validated before git sees them.",
    evidence: "packages/protocol/src/limits.ts",
  },
  {
    id: "paths",
    group: "servers",
    title: "Files stay inside their folder",
    body: "Archives the agent unpacks and the code it builds can't reach outside their own folder, symlinks included. An app mounts only its own volumes, never a folder of the host.",
    evidence: "agent/internal/backup/tarball.go",
  },
  {
    id: "networks",
    group: "servers",
    title: "Each environment on its own network",
    body: "Staging can't reach production. Every environment gets its own network, and firewall rules on the encrypted WireGuard mesh drop traffic that crosses between them.",
    evidence: "agent/internal/netpol/netpol.go",
  },
  {
    id: "builds",
    group: "servers",
    title: "Builds without root",
    body: "Code builds in rootless BuildKit, in a separate builder for each project, and neither builds nor apps can reach the cloud provider's metadata address.",
    evidence: "agent/internal/builder/doc.go",
  },
  {
    id: "write-only",
    group: "secrets",
    title: "Secrets can't be read back",
    body: "Once saved, a secret is never returned by the API, the dashboard or the CLI, to anyone, admins included. You can replace it, and a fingerprint tells values apart.",
    evidence: "apps/api/src/lib/variables.ts",
  },
  {
    id: "sealed",
    group: "secrets",
    title: "Sealed to the one server that runs it",
    body: "Secrets travel inside a box only the receiving server's own key can open, so neither the connection nor a stolen signing key gives them up.",
    evidence: "packages/protocol/src/box.ts",
  },
  {
    id: "master-key",
    group: "secrets",
    title: "Encrypted under your key",
    body: "Stored variables and credentials are encrypted with AES-GCM under keys derived from your MASTER_KEY. There is no built-in fallback key: without yours, nothing that needs one runs.",
    evidence: "apps/api/src/lib/keyring.ts",
  },
  {
    id: "forks",
    group: "secrets",
    title: "Pull requests from forks get nothing secret",
    body: "A preview of someone else's fork gets no secrets and no registry passwords, and builds only on builder servers you set aside for it.",
    evidence: "apps/api/src/lib/previews/settings.ts",
  },
  {
    id: "two-factor",
    group: "account",
    title: "Two-factor for admins and owners",
    body: "Admins and owners can't change anything until they turn on two-factor. After five failed sign-ins in a day an account locks, for longer after each further try.",
    evidence: "apps/api/src/lib/two-factor-gate.ts",
  },
  {
    id: "setup",
    group: "account",
    title: "Only you can claim a new install",
    body: "First-run setup asks for your MASTER_KEY and works once, so nobody who finds a fresh install can make themselves its admin.",
    evidence: "apps/api/src/routes/setup.ts",
  },
  {
    id: "access",
    group: "account",
    title: "One access check for everything",
    body: "Every request about a project passes the same check. It looks the project and your role up in the database, and refuses when anything is missing. Only owners can appoint owners.",
    evidence: "packages/shared/src/rbac.ts",
  },
  {
    id: "reauth",
    group: "account",
    title: "Risky actions ask again",
    body: "Rotating keys, changing someone's role, inviting people or creating a server join token needs a sign-in from the last ten minutes. A shell into a running app also needs two-factor and its own permission.",
    evidence: "apps/api/src/lib/fresh-session.ts",
  },
  {
    id: "protected",
    group: "account",
    title: "Production starts protected",
    body: "A new project's production environment is protected: you choose who may deploy there, change its config or change its variables.",
    evidence: "apps/api/src/routes/projects.ts",
  },
  {
    id: "audit",
    group: "account",
    title: "A history that shows tampering",
    body: "The audit log is a hash chain with checkpoints kept outside the database. One click checks that no entry was edited, removed or reordered.",
    evidence: "apps/api/src/lib/audit-chain.ts",
  },
  {
    id: "cloudflare",
    group: "control-plane",
    title: "No dashboard server to break into",
    body: "The control plane and dashboard run as a Worker in your Cloudflare account. There is no machine running them to log in to, patch or forget, and no metadata service behind it.",
    evidence: "apps/api/wrangler.jsonc",
  },
  {
    id: "origin",
    group: "control-plane",
    title: "Links come from your address",
    body: "Invite, install and join links are built from the address you configured, never from the request, so a forged request can't point them at someone else's server.",
    evidence: "apps/api/src/lib/origin.ts",
  },
  {
    id: "page-policy",
    group: "control-plane",
    title: "A dashboard other sites can't drive",
    body: "The dashboard runs no inline or outside scripts, can't be framed by another site, and refuses changes sent from another origin.",
    evidence: "apps/web/public/_headers",
  },
  {
    id: "github",
    group: "control-plane",
    title: "GitHub can't be impersonated",
    body: "Webhooks are refused unless their signature matches, and a replay is ignored. A GitHub installation joins a workspace only when an admin of that GitHub account approves it.",
    evidence: "apps/api/src/lib/github.ts",
  },
  {
    id: "releases",
    group: "control-plane",
    title: "Signed releases",
    body: "Agent releases are signed, and the installer carries the release key. It refuses a download whose signature doesn't match.",
    evidence: "install/install.sh",
  },
  {
    id: "join",
    group: "control-plane",
    title: "Join tokens that work once",
    body: `A server joins with a token that expires in ${JOIN_TOKEN_MINUTES} minutes and works once. The credential it gets back is stored only as a hash and dies when you remove the server.`,
    evidence: "apps/api/src/lib/join-tokens.ts",
  },
];

/**
 * The defences of one group, in page order.
 *
 * @param group - The block of the section.
 * @returns Its defences.
 */
export function defencesIn(group: DefenceGroup): Defence[] {
  return DEFENCES.filter((defence) => defence.group === group);
}

/**
 * Looks a defence up by id.
 *
 * @param id - The defence.
 * @returns It.
 * @throws When the id is unknown, which the type rules out.
 */
export function defence(id: DefenceId): Defence {
  const found = DEFENCES.find((entry) => entry.id === id);
  if (!found) throw new Error(`unknown defence ${id}`);
  return found;
}
