/**
 * In-memory backing store for the MSW handlers. Each test starts from {@link resetDb},
 * which seeds a signed-in owner with a workspace, four members, one pending invite, two
 * nodes (one reporting, one still pending), a few audit entries, and the Phase 1 data
 * described in `./deploy-db`.
 *
 * @module
 */
import type { Role } from "@roundhouse/shared";
import type {
  AuditLogEntry,
  Invite,
  JoinToken,
  Node,
  SetupStatus,
  User,
  Workspace,
} from "../lib/api/types";
import { type DeployDb, emptyDeploy, seedDeploy } from "./deploy-db";

/** A stored user, including the password the sign-in handler checks. */
export interface DbUser extends User {
  password: string;
}

/** A stored membership row. */
export interface DbMembership {
  id: string;
  workspace_id: string;
  user_id: string;
  role: Role;
  created_at: number;
}

/** A stored invite with its token, workspace and acceptance time. */
export interface DbInvite extends Invite {
  workspace_id: string;
  token: string;
  /** Set when redeemed. Accepted invites stay in the table, like the real API's. */
  accepted_at?: number | null;
}

/** A stored audit row. `actor_name` is a fallback; handlers resolve names at read time. */
export type DbAuditEntry = AuditLogEntry & { workspace_id: string };

/** The whole mock database. */
export interface MockDb {
  setup: SetupStatus;
  /** Value of the Worker's MASTER_KEY secret once configured. */
  masterKey: string;
  sessionUserId: string | null;
  users: DbUser[];
  workspaces: Omit<Workspace, "role">[];
  memberships: DbMembership[];
  invites: DbInvite[];
  nodes: (Node & { workspace_id: string })[];
  joinTokens: (JoinToken & { workspace_id: string })[];
  audit: DbAuditEntry[];
  /** Projects, services, deployments and the rest of the deploy pipeline. */
  deploy: DeployDb;
  counter: number;
}

const GiB = 1024 ** 3;

/** Workspace id of the seeded workspace. */
export const WORKSPACE_ID = "ws_acme";

/** Seeded users by role in {@link WORKSPACE_ID}. */
export const USERS = {
  owner: {
    id: "usr_ada",
    name: "Ada Lovelace",
    email: "ada@example.com",
    image: null,
    instance_admin: true,
  },
  admin: { id: "usr_bob", name: "Bob Builder", email: "bob@example.com", image: null },
  member: { id: "usr_cara", name: "Cara Mel", email: "cara@example.com", image: null },
  viewer: { id: "usr_dan", name: "Dan Viewer", email: "dan@example.com", image: null },
} as const satisfies Record<Role, User>;

/** Password for every seeded user. */
export const PASSWORD = "correct-horse-battery";

/** The MASTER_KEY secret the mock Worker is configured with. */
export const MASTER_KEY = "bWFzdGVyLWtleS1mb3ItdGVzdHMtb25seS0zMmJ5dGVz";

/** Token of the seeded pending invite (for erin@example.com, as a member). */
export const INVITE_TOKEN = "inv_pending";

/**
 * Builds a node record with sensible defaults for an online, reporting server.
 *
 * @param overrides - Fields to change.
 * @returns A complete node.
 */
export function makeNode(overrides: Partial<Node> = {}): Node {
  const now = Date.now();
  return {
    id: "node_hel1",
    name: "hel-1",
    hostname: "hel-1.example.com",
    status: "online",
    provider: "hetzner",
    region: "hel1",
    public_ip: "203.0.113.10",
    os: "linux",
    arch: "amd64",
    kernel: "6.8.0-45-generic",
    docker_version: "27.3.1",
    agent_version: "0.1.0",
    capabilities: { docker: true, gvisor: false, builder: true },
    cpu_total: 8,
    mem_total: 16 * GiB,
    disk_total: 160 * GiB,
    cpu_percent: 38,
    mem_used: 11.4 * GiB,
    disk_used: 64 * GiB,
    load1: 1.42,
    last_heartbeat_at: now - 4_000,
    created_at: now - 41 * 86_400_000,
    ...overrides,
  };
}

/**
 * A node that has registered but never sent a heartbeat: every usage field is null and
 * the provider is the API's default.
 *
 * @param overrides - Fields to change.
 * @returns A pending node.
 */
export function makePendingNode(overrides: Partial<Node> = {}): Node {
  return makeNode({
    id: "node_fsn1",
    name: "fsn-1",
    hostname: null,
    status: "pending",
    provider: "server",
    region: null,
    public_ip: null,
    os: null,
    arch: null,
    kernel: null,
    docker_version: null,
    agent_version: null,
    capabilities: null,
    cpu_total: null,
    mem_total: null,
    disk_total: null,
    cpu_percent: null,
    mem_used: null,
    disk_used: null,
    load1: null,
    last_heartbeat_at: null,
    ...overrides,
  });
}

/**
 * Builds an audit log entry. Defaults to the API's record of `hel-1` joining, where the
 * node itself is the actor.
 *
 * @param overrides - Fields to change.
 * @returns A complete entry.
 */
export function makeAuditEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: "aud_1",
    actor_type: "node",
    actor_id: "node_hel1",
    actor_name: "hel-1",
    action: "node.joined",
    target_type: "node",
    target_id: "node_hel1",
    metadata: { name: "hel-1", hostname: "hel-1.example.com", agent_version: "0.1.0" },
    ip: "198.51.100.7",
    created_at: Date.now() - 60_000,
    ...overrides,
  };
}

function seed(): MockDb {
  const now = Date.now();
  const users: DbUser[] = Object.values(USERS).map((user) => ({ ...user, password: PASSWORD }));
  const byOwner = {
    actor_type: "user",
    actor_id: USERS.owner.id,
    actor_name: USERS.owner.name,
  } as const;
  return {
    setup: { needs_setup: false, master_key_configured: true },
    masterKey: MASTER_KEY,
    sessionUserId: USERS.owner.id,
    users,
    workspaces: [
      { id: WORKSPACE_ID, name: "Acme", slug: "acme", created_at: now - 90 * 86_400_000 },
    ],
    memberships: (Object.keys(USERS) as Role[]).map((role, index) => ({
      id: `mem_${role}`,
      workspace_id: WORKSPACE_ID,
      user_id: USERS[role].id,
      role,
      created_at: now - (10 - index) * 86_400_000,
    })),
    invites: [
      {
        id: "inv_1",
        token: INVITE_TOKEN,
        workspace_id: WORKSPACE_ID,
        email: "erin@example.com",
        role: "member",
        expires_at: now + 6 * 86_400_000,
        created_at: now - 86_400_000,
        accepted_at: null,
      },
    ],
    nodes: [
      { ...makeNode(), workspace_id: WORKSPACE_ID },
      { ...makePendingNode(), workspace_id: WORKSPACE_ID },
    ],
    joinTokens: [],
    audit: [
      makeAuditEntry({ id: "aud_3", created_at: now - 120_000 }),
      makeAuditEntry({
        ...byOwner,
        id: "aud_2",
        action: "invite.created",
        target_type: "invite",
        target_id: "inv_1",
        metadata: { email: "erin@example.com", role: "member" },
        created_at: now - 3_600_000,
      }),
      makeAuditEntry({
        ...byOwner,
        id: "aud_1",
        action: "workspace.created",
        target_type: "workspace",
        target_id: WORKSPACE_ID,
        metadata: null,
        created_at: now - 86_400_000,
      }),
    ].map((entry) => ({ ...entry, workspace_id: WORKSPACE_ID })),
    deploy: seedDeploy(WORKSPACE_ID, now),
    counter: 0,
  };
}

/** The live mock database. Mutate it freely inside a test. */
export let db: MockDb = seed();

/** Restores the seeded state. Called after every test. */
export function resetDb(): void {
  db = seed();
}

/**
 * Puts the database into the pristine first-run state: no users, nothing set up.
 *
 * @param masterKeyConfigured - Whether the Worker already has `MASTER_KEY`.
 */
export function seedFreshInstall(masterKeyConfigured = true): void {
  db = {
    ...seed(),
    setup: { needs_setup: true, master_key_configured: masterKeyConfigured },
    sessionUserId: null,
    users: [],
    workspaces: [],
    memberships: [],
    invites: [],
    nodes: [],
    audit: [],
    deploy: emptyDeploy(),
  };
}

/**
 * Signs a seeded user in, or signs everyone out with `null`.
 *
 * @param userId - User id to act as.
 */
export function signInAs(userId: string | null): void {
  db.sessionUserId = userId;
}

/**
 * Generates a unique id for rows created by handlers.
 *
 * @param prefix - Entity prefix such as `node`.
 * @returns A new id.
 */
export function nextId(prefix: string): string {
  db.counter += 1;
  return `${prefix}_mock${db.counter}`;
}
