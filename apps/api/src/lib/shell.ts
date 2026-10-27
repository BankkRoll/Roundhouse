/**
 * Web shell bookkeeping shared by the Worker routes and the relay in each
 * node's `NodeConnection` (ADR 0012 "Web shell", ADR 0014 §15).
 *
 * Responsibilities:
 * - {@link ShellDescriptor}: the trusted session the Worker hands the node's
 *   Durable Object with the upgrade ({@link SHELL_SESSION_HEADER});
 * - {@link recheckShellAccess}: whether the person behind an open shell may
 *   still hold it (credential, membership, `shell:open`, 2FA, protection);
 * - {@link revalidateShellSessions}: asks the nodes running matching open
 *   shells to re-check them now, after an access change;
 * - {@link finishShellSession}: ends a `shell_sessions` row once and audits
 *   `shell.closed` (ids, reason, duration, byte counts; never terminal data);
 * - {@link expireLostShellSessions}: the minute tick's sweep of rows whose
 *   relay was lost;
 * - {@link toApiShellSession}: the public shape of a row.
 *
 * SECURITY: nothing here ever sees terminal input or output.
 *
 * @module
 */
import {
  apiTokens,
  createDb,
  type Db,
  environments,
  projects,
  sessions,
  shellSessions,
  users,
  workspaces,
} from "@roundhouse/db";
import { DEFAULT_EXEC_MAX_DURATION_S } from "@roundhouse/protocol";
import { type Action, resolveAccess, type ShellExitReason } from "@roundhouse/shared";
import { and, eq, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import type { Env } from "../env";
import { loadWorkspaceAccess } from "./access";
import { recordAudit } from "./audit";

/** Header carrying the gated session as JSON ({@link ShellDescriptor}), Worker → node DO only. */
export const SHELL_SESSION_HEADER = "x-roundhouse-shell-session";

/** Path of the shell upgrade, for middleware that must leave it untouched. */
export const SHELL_PATH = /^\/v1\/workloads\/[^/]+\/shell$/;

/** Placement states with a container a shell can exec into. */
export const SHELL_TARGET_STATES = ["running", "healthy", "unhealthy"] as const;

/** The action an open shell must keep holding. */
const SHELL_ACTION: Action = "shell:open";

/**
 * How long past its maximum duration a row may stay open before the minute
 * tick decides its relay is gone.
 */
const LOST_SESSION_GRACE_MS = 5 * 60 * 1000;

/** Rows the minute tick ends per run. */
const EXPIRE_BATCH = 100;

/**
 * Why a row ended: a {@link ShellExitReason}, or `terminated` when someone
 * ended it through `POST /v1/shell-sessions/{id}/terminate`.
 */
export type ShellEndReason = ShellExitReason | "terminated";

/** A gated shell session, as the Worker hands it to the node's Durable Object. */
export interface ShellDescriptor {
  session_id: string;
  workspace_id: string;
  project_id: string;
  environment_id: string;
  service_id: string;
  workload_id: string;
  deployment_id: string;
  replica: number;
  node_id: string;
  node_name: string;
  user_id: string;
  /** API token that opened it; `null` for a browser session. */
  token_id: string | null;
  /** Better Auth session that opened it; `null` for a token. */
  auth_session_id: string | null;
  /** argv; only the relay's `exec_open` carries it, the row keeps argv[0]. */
  command: string[];
  cols: number;
  rows: number;
  /** `TERM` for the process. */
  term: string;
  idle_timeout_s: number;
  max_duration_s: number;
  /** Unix ms, as stored in the row. */
  started_at: number;
}

/** The fields of a {@link ShellDescriptor} a re-check reads. */
export type ShellSubject = Pick<
  ShellDescriptor,
  "workspace_id" | "project_id" | "environment_id" | "user_id" | "token_id" | "auth_session_id"
>;

/** Which open shells {@link revalidateShellSessions} re-checks. */
export interface ShellRevalidateFilter {
  /** Only shells in these projects. */
  projectIds?: readonly string[];
  /** Only shells of these users, tokens, shell sessions or browser sessions (any match). */
  userIds?: readonly string[];
  tokenIds?: readonly string[];
  sessionIds?: readonly string[];
  authSessionIds?: readonly string[];
}

/** The bindings reaching the shell relays need. */
export type ShellEnv = Pick<Env, "DB" | "NODE_CONNECTION">;

/**
 * Whether the person behind an open shell may still hold it: the browser
 * session still exists (or the token is live and still carries
 * `shell:open`), the project is live, they are still a member with
 * `shell:open` on its environment, two-factor authentication is still on,
 * and a token's environment hasn't become protected.
 *
 * NOTE: freshness is checked only when a shell opens. A session that
 * re-authenticated to open it keeps it past the re-auth window; the
 * idle and duration limits bound it instead (ADR 0012).
 *
 * @param db - Database client.
 * @param subject - Who opened the shell, where.
 * @param now - Current time, unix ms.
 * @returns `true` while the shell may stay open.
 */
export async function recheckShellAccess(
  db: Db,
  subject: ShellSubject,
  now = Date.now(),
): Promise<boolean> {
  let tokenScopes: Action[] | null = null;
  if (subject.auth_session_id) {
    const [session] = await db
      .select({ expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(and(eq(sessions.id, subject.auth_session_id), eq(sessions.userId, subject.user_id)))
      .limit(1);
    if (!session || +session.expiresAt <= now) return false;
  } else if (subject.token_id) {
    const [token] = await db
      .select({
        revokedAt: apiTokens.revokedAt,
        expiresAt: apiTokens.expiresAt,
        scopes: apiTokens.scopes,
        workspaceId: apiTokens.workspaceId,
      })
      .from(apiTokens)
      .where(eq(apiTokens.id, subject.token_id))
      .limit(1);
    if (!token || token.revokedAt || (token.expiresAt && +token.expiresAt <= now)) return false;
    if (token.workspaceId !== subject.workspace_id) return false;
    tokenScopes = token.scopes as Action[];
  } else {
    return false;
  }
  const [live] = await db
    .select({ twoFactor: users.twoFactorEnabled, protected: environments.protected })
    .from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .innerJoin(environments, eq(environments.projectId, projects.id))
    .innerJoin(users, eq(users.id, subject.user_id))
    .where(
      and(
        eq(projects.id, subject.project_id),
        eq(projects.workspaceId, subject.workspace_id),
        eq(environments.id, subject.environment_id),
        isNull(projects.deletedAt),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(1);
  if (!live?.twoFactor) return false;
  if (subject.token_id && live.protected) return false;
  const loaded = await loadWorkspaceAccess(
    db,
    subject.workspace_id,
    subject.user_id,
    subject.project_id,
  );
  if (loaded.role === null) return false;
  return resolveAccess(
    {
      userId: subject.user_id,
      workspaceRole: loaded.role,
      instanceAdmin: false,
      teamIds: loaded.teamIds,
      tokenScopes,
    },
    loaded.context,
  ).check(SHELL_ACTION, {
    projectId: subject.project_id,
    environmentId: subject.environment_id,
  }).allowed;
}

/**
 * Asks every node running a matching open shell to re-check it now and
 * close it when access lapsed (ADR 0014 §15 "Revocation"). Best effort like
 * the realtime re-check: each relay still re-checks every minute.
 *
 * @param env - Worker bindings.
 * @param filter - Which open shells; every open shell when empty.
 * @returns Shells closed.
 * @example
 * await revalidateShellSessions(c.env, { authSessionIds: [revokedId] });
 */
export async function revalidateShellSessions(
  env: ShellEnv,
  filter: ShellRevalidateFilter = {},
): Promise<number> {
  const subjects: SQL[] = [];
  const lists = [
    [shellSessions.userId, filter.userIds],
    [shellSessions.tokenId, filter.tokenIds],
    [shellSessions.id, filter.sessionIds],
    [shellSessions.authSessionId, filter.authSessionIds],
  ] as const;
  for (const [column, ids] of lists) {
    if (ids?.length) subjects.push(inArray(column, [...ids]));
  }
  const narrowed = lists.some(([, ids]) => ids !== undefined);
  if ((narrowed && !subjects.length) || filter.projectIds?.length === 0) return 0;
  let rows: { id: string; nodeId: string | null }[];
  try {
    rows = await createDb(env.DB)
      .select({ id: shellSessions.id, nodeId: shellSessions.nodeId })
      .from(shellSessions)
      .where(
        and(
          isNull(shellSessions.endedAt),
          filter.projectIds ? inArray(shellSessions.projectId, [...filter.projectIds]) : undefined,
          subjects.length ? or(...subjects) : undefined,
        ),
      );
  } catch (err) {
    console.warn("shell revalidate lookup failed", err instanceof Error ? err.name : "error");
    return 0;
  }
  const byNode = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.nodeId) continue;
    byNode.set(r.nodeId, [...(byNode.get(r.nodeId) ?? []), r.id]);
  }
  const results = await Promise.allSettled(
    [...byNode].map(([nodeId, sessionIds]) =>
      env.NODE_CONNECTION.get(env.NODE_CONNECTION.idFromName(nodeId)).revalidateShells({
        sessionIds,
      }),
    ),
  );
  let closed = 0;
  for (const r of results) {
    if (r.status === "fulfilled") closed += r.value;
    else
      console.warn("shell revalidate failed", r.reason instanceof Error ? r.reason.name : "error");
  }
  return closed;
}

/** How a session ended, for {@link finishShellSession}. */
export interface ShellEnding {
  reason: ShellEndReason;
  exitCode: number | null;
  bytesIn: number;
  bytesOut: number;
  /** The container user the agent reported, when it opened. */
  containerUser?: string | null;
  /** Who ended it; the system when omitted. */
  actor?: { actorType: "user" | "token" | "system"; actorId: string | null };
}

/**
 * Ends an open `shell_sessions` row and audits `shell.closed` (ids, reason,
 * exit code, duration, byte counts). A row that already ended is left
 * alone, so the relay, the terminate route and the minute tick can race.
 *
 * @param db - Database client.
 * @param sessionId - `shl_…`.
 * @param ending - How it ended.
 * @param now - Current time, unix ms.
 * @returns Whether this call ended it.
 */
export async function finishShellSession(
  db: Db,
  sessionId: string,
  ending: ShellEnding,
  now = Date.now(),
): Promise<boolean> {
  const [row] = await db
    .update(shellSessions)
    .set({
      endedAt: new Date(now),
      endReason: ending.reason,
      exitCode: ending.exitCode,
      bytesIn: ending.bytesIn,
      bytesOut: ending.bytesOut,
      ...(ending.containerUser ? { containerUser: ending.containerUser } : {}),
    })
    .where(and(eq(shellSessions.id, sessionId), isNull(shellSessions.endedAt)))
    .returning();
  if (!row) return false;
  await recordAudit(db, {
    workspaceId: row.workspaceId,
    ...(ending.actor ?? { actorType: "system", actorId: null }),
    action: "shell.closed",
    targetType: "shell_session",
    targetId: row.id,
    metadata: {
      project_id: row.projectId,
      environment_id: row.environmentId,
      service_id: row.serviceId,
      workload_id: row.workloadId,
      replica: row.replica,
      node_id: row.nodeId,
      container_user: row.containerUser,
      end_reason: row.endReason,
      exit_code: row.exitCode,
      duration_ms: Math.max(0, now - +row.startedAt),
      bytes_in: row.bytesIn,
      bytes_out: row.bytesOut,
    },
  });
  return true;
}

/**
 * Ends rows left open well past their maximum duration: their relay (the
 * node's Durable Object) was lost before it could finish them. A minute
 * tick claimer.
 *
 * @param env - Worker bindings.
 * @param now - The tick's time, unix ms.
 * @returns Rows ended.
 */
export async function expireLostShellSessions(env: Pick<Env, "DB">, now: number): Promise<number> {
  const db = createDb(env.DB);
  const cutoff = new Date(now - DEFAULT_EXEC_MAX_DURATION_S * 1000 - LOST_SESSION_GRACE_MS);
  const rows = await db
    .select({
      id: shellSessions.id,
      bytesIn: shellSessions.bytesIn,
      bytesOut: shellSessions.bytesOut,
    })
    .from(shellSessions)
    .where(and(isNull(shellSessions.endedAt), lt(shellSessions.startedAt, cutoff)))
    .limit(EXPIRE_BATCH);
  let ended = 0;
  for (const r of rows) {
    const done = await finishShellSession(
      db,
      r.id,
      { reason: "timeout", exitCode: null, bytesIn: r.bytesIn, bytesOut: r.bytesOut },
      now,
    );
    if (done) ended++;
  }
  return ended;
}

/**
 * The public shape of a `shell_sessions` row.
 *
 * @param r - The row.
 * @returns The API representation; timestamps are unix ms.
 */
export function toApiShellSession(r: typeof shellSessions.$inferSelect) {
  return {
    id: r.id,
    project_id: r.projectId,
    environment_id: r.environmentId,
    service_id: r.serviceId,
    workload_id: r.workloadId,
    deployment_id: r.deploymentId,
    replica: r.replica,
    node_id: r.nodeId,
    user_id: r.userId,
    token_id: r.tokenId,
    command: r.command,
    container_user: r.containerUser,
    started_at: +r.startedAt,
    opened_at: r.openedAt ? +r.openedAt : null,
    ended_at: r.endedAt ? +r.endedAt : null,
    end_reason: r.endReason,
    exit_code: r.exitCode,
    bytes_in: r.bytesIn,
    bytes_out: r.bytesOut,
  };
}
