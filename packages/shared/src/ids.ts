import { monotonicFactory } from "ulidx";

// IDs double as pagination cursors, so they must sort correctly even when
// several are minted in the same millisecond.
const ulid = monotonicFactory();

/**
 * Entity prefixes keep IDs self-describing in logs, URLs, and support tickets.
 * Changing a prefix is a breaking change for stored data.
 */
export const ID_PREFIXES = {
  user: "usr",
  session: "ses",
  account: "acc",
  verification: "ver",
  workspace: "ws",
  member: "mem",
  invite: "inv",
  apiToken: "tok",
  auditLog: "aud",
  node: "node",
  joinToken: "njt",
  message: "msg",
  project: "prj",
  environment: "env",
  service: "svc",
  serviceConfig: "cfg",
  variable: "var",
  build: "bld",
  deployment: "dep",
  deploymentEvent: "dev",
  placement: "plc",
  domain: "dom",
  githubInstallation: "ghi",
  logChunk: "log",
  /** A replica on a node; also the container's identity in desired_state. */
  workload: "wl",
  /** Better Auth's two-factor model; the key must match its model name. */
  twoFactor: "tfa",
  team: "team",
  teamMember: "tmm",
  projectAccessGrant: "pag",
  /** Single-use state of a GitHub installation claim. */
  githubClaim: "ghc",
  /** One run of the master key rotation workflow. */
  keyRotation: "krot",
  /** A workspace's sealed cloud provider API token. */
  providerCredential: "pcr",
  /** One one-click provisioning run; also its workflow instance ID. */
  nodeProvision: "prov",
  /** One user's OAuth consent for an MCP client in one workspace. */
  oauthGrant: "oag",
  /** A reviewable batch of staged changes (ADR 0006). */
  changeSet: "chs",
  /** One operation staged in a change set. */
  stagedChange: "stg",
  /** A "connects to" edge drawn between two services on the canvas (ADR 0006). */
  serviceEdge: "edg",
  /** A service's persistent volume in one environment (ADR 0004). */
  volume: "vol",
  /** One backup of a volume; also its workflow instance ID. */
  backup: "bak",
  /** A service's backup schedule and retention in one environment. */
  backupPolicy: "bpl",
  /** One restore of a backup; also its workflow instance ID. */
  restore: "rst",
  /** One move of a volume between nodes; also its workflow instance ID. */
  volumeMigration: "mig",
  /** One data-browser query, correlating `db_query` with its result. */
  dbQuery: "dbq",
  /** A published TCP port of a single-replica service (ADR 0004). */
  tcpProxy: "tcp",
  /** One rotation of a database's credentials. */
  credentialRotation: "rot",
  /** A control-plane-issued TLS certificate (ADR 0009); also names its workflow instances. */
  certificate: "cer",
  /** One run of a cron service (ADR 0010); also its workflow instance ID. */
  cronRun: "crn",
  /** One drain of a node (ADR 0005); its workflow instance ID is `drain-<node>-<ts>`. */
  nodeDrain: "drn",
  /** One pull request's preview of one project (ADR 0007). */
  preview: "prv",
  /** One web shell session (ADR 0012). */
  shellSession: "shl",
  /** One Cloudflare Containers deployment of a service (ADR 0011). */
  cfDeployment: "cfd",
  /** One registry-to-registry image copy on a builder (ADR 0011). */
  imagePush: "psh",
} as const;

/** An entity kind that has an ID prefix. */
export type IdKind = keyof typeof ID_PREFIXES;

/**
 * Generates a prefixed, lexicographically sortable ID.
 *
 * @param kind - Entity kind, which determines the prefix.
 * @returns An ID such as `node_01J9Z6…`.
 * @example
 * newId("workspace"); // "ws_01J9Z6Y4M0V8…"
 */
export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${ulid()}`;
}

/**
 * Type guard for strings that name an {@link IdKind}.
 *
 * @param value - Candidate kind, e.g. a Better Auth model name.
 * @returns `true` when `value` has a registered prefix.
 */
export function isIdKind(value: string): value is IdKind {
  return Object.hasOwn(ID_PREFIXES, value);
}
