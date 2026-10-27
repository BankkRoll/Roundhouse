/**
 * Web shell routes (ADR 0012 "Web shell", ADR 0014 §15).
 *
 * - `GET /v1/workloads/{workloadId}/shell` authenticates a browser session
 *   (with `Origin` checked) or a `tok_` API token, resolves the replica from
 *   its placement, applies `shell:open` and `shellGate` (2FA always, a fresh
 *   session, no token in a protected environment), records the session and
 *   hands only the upgrade and a trusted descriptor to the node's
 *   `NodeConnection`, which relays it to the agent. Refusals close the
 *   socket with a `SHELL_CLOSE_CODES` code after the upgrade.
 * - `GET /v1/services/{serviceId}/shell-targets` lists running replicas and
 *   previews the gate for the caller.
 * - `GET /v1/workspaces/{workspaceId}/shell-sessions` is the session history.
 * - `POST /v1/shell-sessions/{sessionId}/terminate` ends an open session.
 * - `GET /v1/shell-sessions/{sessionId}/recording` plays a recording back
 *   (decrypted asciicast) to an audit reader who may also open the shell,
 *   from a fresh browser session; audited `shell.recording_viewed`.
 * - {@link withShellRevocation} re-checks open shells after a sign-out or
 *   after two-factor authentication is turned off.
 *
 * SECURITY: Browsers don't apply CORS to WebSocket upgrades, so a cookie
 * upgrade is only accepted with an `Origin` equal to the control plane's
 * own; a bearer token can't be attached by another site's page.
 *
 * @module
 */
import {
  deployments,
  environments,
  nodes,
  placements,
  projects,
  services,
  shellSessions,
  users,
  workspaces,
} from "@roundhouse/db";
import {
  DEFAULT_EXEC_COMMAND,
  DEFAULT_EXEC_IDLE_TIMEOUT_S,
  DEFAULT_EXEC_MAX_DURATION_S,
  EXEC_PROTOCOL_VERSION,
  isValidExecCommand,
} from "@roundhouse/protocol";
import {
  ASCIICAST_CONTENT_TYPE,
  newId,
  SHELL_CLOSE_CODES,
  SHELL_DENIAL_CLOSE_CODES,
  type ShellCloseCode,
  type ShellCredential,
  type ShellDenial,
  shellGate,
} from "@roundhouse/shared";
import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import {
  type AppContext,
  actorOf,
  clientIp,
  createRouter,
  currentPrincipal,
  originOf,
  type Principal,
  requirePrincipal,
  requireWorkspace,
} from "../context";
import {
  getShellRecording,
  listShellSessions,
  listShellTargets,
  openShell,
  policyOf,
  terminateShellSession,
} from "../contracts";
import { bearerSecret } from "../lib/api-tokens";
import { recordAudit } from "../lib/audit";
import { ApiError, conflict, notFound } from "../lib/errors";
import { freshUntil } from "../lib/fresh-session";
import { effectiveStatus } from "../lib/nodes";
import { environmentOf, serviceScope } from "../lib/scope";
import {
  finishShellSession,
  revalidateShellSessions,
  SHELL_SESSION_HEADER,
  SHELL_TARGET_STATES,
  type ShellDescriptor,
  toApiShellSession,
} from "../lib/shell";
import { readShellRecording, shellRecordingRecipient } from "../lib/shell-recording";

const SESSION_CURSOR_RE = /^shl_[0-9A-Za-z]{1,64}$/;

/** Deployments whose replicas the targets list offers. */
const SERVING_STATUSES = ["active", "crashed"] as const;

const CLOSE_FOR_STATUS: Partial<Record<number, ShellCloseCode>> = {
  401: SHELL_CLOSE_CODES.unauthorized,
  404: SHELL_CLOSE_CODES.notFound,
  429: SHELL_CLOSE_CODES.unauthorized,
};

const DENIAL_MESSAGES: Record<ShellDenial, string> = {
  oauth_token: "OAuth tokens can't open a shell",
  forbidden: "You can't open a shell here",
  two_factor_required: "Turn on two-factor authentication to open a shell",
  reauth_required: "Confirm your password to open a shell",
  protected_environment: "API tokens can't open a shell in a protected environment",
};

/** Accepts the upgrade only to close it with `code`, so the client learns why. */
function closedSocket(code: ShellCloseCode, reason: string): Response {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();
  // Close reasons are capped at 123 bytes.
  server.close(code, reason.slice(0, 120));
  return new Response(null, { status: 101, webSocket: client });
}

/**
 * Runs `shellGate` for a caller who passed (or failed) the `shell:open`
 * check: how they authenticated, their 2FA, the session's freshness and
 * the environment's protection.
 */
async function evaluateGate(
  c: AppContext,
  principal: Principal,
  accessAllowed: boolean,
  environmentProtected: boolean,
): Promise<{ allowed: true } | { allowed: false; reason: ShellDenial }> {
  const credential: ShellCredential = principal.token?.oauth
    ? "oauth"
    : principal.token
      ? "api_token"
      : "session";
  const [user] = await c
    .get("db")
    .select({ twoFactorEnabled: users.twoFactorEnabled })
    .from(users)
    .where(eq(users.id, principal.user.id))
    .limit(1);
  const until = credential === "session" ? await freshUntil(c) : null;
  return shellGate({
    credential,
    accessAllowed,
    twoFactorEnabled: user?.twoFactorEnabled ?? false,
    freshSession: until !== null && Date.now() <= until,
    environmentProtected,
  });
}

/** The live placement behind a workload ID, with what the gate and relay need. */
async function shellTarget(c: AppContext, workloadId: string) {
  const [row] = await c
    .get("db")
    .select({
      workloadId: placements.workloadId,
      deploymentId: placements.deploymentId,
      replica: placements.replica,
      state: placements.state,
      environmentId: deployments.environmentId,
      serviceId: services.id,
      projectId: projects.id,
      workspaceId: projects.workspaceId,
      environmentProtected: environments.protected,
      node: nodes,
    })
    .from(placements)
    .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .innerJoin(environments, eq(environments.id, deployments.environmentId))
    .innerJoin(nodes, eq(nodes.id, placements.nodeId))
    .where(
      and(
        eq(placements.workloadId, workloadId),
        isNull(services.deletedAt),
        isNull(projects.deletedAt),
        isNull(workspaces.deletedAt),
        isNull(nodes.deletedAt),
      ),
    )
    .limit(1);
  return row;
}

/** The command a socket asks for, one `cmd` query value per argument. */
function commandOf(cmd: string | string[] | undefined): string[] {
  if (cmd === undefined) return [...DEFAULT_EXEC_COMMAND];
  return typeof cmd === "string" ? [cmd] : cmd;
}

/**
 * Runs a Better Auth request and, after a successful sign-out or after
 * two-factor authentication was turned off, re-checks the caller's open
 * shells at once (ADR 0014 §15 "Revocation") instead of at the next minute.
 *
 * @param c - Request context of `/api/auth/*`.
 * @param handle - Runs the Better Auth handler.
 * @returns The handler's response, unchanged.
 */
export async function withShellRevocation(
  c: AppContext,
  handle: () => Promise<Response>,
): Promise<Response> {
  const path = c.req.path;
  const watched =
    c.req.method === "POST" && (path.endsWith("/sign-out") || path.endsWith("/two-factor/disable"));
  if (!watched) return handle();
  let principal: Principal | null = null;
  try {
    principal = await currentPrincipal(c);
  } catch {
    // Not signed in in a way that could own a shell.
  }
  const res = await handle();
  if (res.ok && principal && !principal.token) {
    await revalidateShellSessions(
      c.env,
      path.endsWith("/sign-out") && principal.session
        ? { authSessionIds: [principal.session.id] }
        : { userIds: [principal.user.id] },
    );
  }
  return res;
}

/** Shell routes. */
export const shellRoutes = createRouter()
  .openapi(openShell, async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      throw new ApiError(426, "upgrade_required", "Expected a WebSocket upgrade");
    }
    const bearer = bearerSecret(c.req.header("authorization")) !== null;
    if (!bearer && c.req.header("origin") !== originOf(c)) {
      throw new ApiError(403, "forbidden", "Cross-origin WebSocket rejected");
    }
    const { workloadId } = c.req.valid("param");
    const query = c.req.valid("query");
    const command = commandOf(query.cmd);
    if (!isValidExecCommand(command)) {
      return closedSocket(SHELL_CLOSE_CODES.policy, "Invalid command");
    }

    let principal: Principal | null;
    try {
      principal = await currentPrincipal(c);
    } catch (err) {
      const code = err instanceof ApiError ? CLOSE_FOR_STATUS[err.status] : undefined;
      if (code) return closedSocket(code, (err as ApiError).message);
      throw err;
    }
    if (!principal) return closedSocket(SHELL_CLOSE_CODES.unauthorized, "Sign in to continue");
    if (principal.token?.oauth) {
      return closedSocket(SHELL_CLOSE_CODES.unauthorized, DENIAL_MESSAGES.oauth_token);
    }
    const target = await shellTarget(c, workloadId);
    if (!target) return closedSocket(SHELL_CLOSE_CODES.notFound, "Workload not found");

    let accessAllowed = true;
    try {
      await requireWorkspace(c, target.workspaceId, policyOf(openShell).action!, {
        projectId: target.projectId,
        environmentId: target.environmentId,
      });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.status === 403) accessAllowed = false;
      else {
        const code = CLOSE_FOR_STATUS[err.status];
        if (!code) throw err;
        return closedSocket(code, err.status === 404 ? "Workload not found" : err.message);
      }
    }
    const gate = await evaluateGate(c, principal, accessAllowed, target.environmentProtected);
    if (!gate.allowed) {
      return closedSocket(SHELL_DENIAL_CLOSE_CODES[gate.reason], DENIAL_MESSAGES[gate.reason]);
    }
    if (!(SHELL_TARGET_STATES as readonly string[]).includes(target.state)) {
      return closedSocket(SHELL_CLOSE_CODES.notFound, "The replica isn't running");
    }

    const db = c.get("db");
    const recipient = await shellRecordingRecipient(c.env, db, target.projectId);
    const now = Date.now();
    const sessionId = newId("shellSession");
    const descriptor: ShellDescriptor = {
      session_id: sessionId,
      workspace_id: target.workspaceId,
      project_id: target.projectId,
      environment_id: target.environmentId,
      service_id: target.serviceId,
      workload_id: target.workloadId,
      deployment_id: target.deploymentId,
      replica: target.replica,
      node_id: target.node.id,
      node_name: target.node.name,
      user_id: principal.user.id,
      token_id: principal.token?.id ?? null,
      auth_session_id: principal.token ? null : (principal.session?.id ?? null),
      command,
      cols: query.cols,
      rows: query.rows,
      term: query.term,
      idle_timeout_s: DEFAULT_EXEC_IDLE_TIMEOUT_S,
      max_duration_s: DEFAULT_EXEC_MAX_DURATION_S,
      started_at: now,
      recording_recipient: recipient,
    };
    const ip = clientIp(c);
    await db.insert(shellSessions).values({
      id: sessionId,
      workspaceId: target.workspaceId,
      projectId: target.projectId,
      environmentId: target.environmentId,
      serviceId: target.serviceId,
      workloadId: target.workloadId,
      deploymentId: target.deploymentId,
      replica: target.replica,
      nodeId: target.node.id,
      userId: principal.user.id,
      tokenId: descriptor.token_id,
      authSessionId: descriptor.auth_session_id,
      clientIp: ip,
      command: command[0]!,
      startedAt: new Date(now),
      recording: recipient ? "recording" : "none",
    });
    await recordAudit(db, {
      workspaceId: target.workspaceId,
      ...actorOf(principal),
      action: "shell.opened",
      targetType: "shell_session",
      targetId: sessionId,
      metadata: {
        project_id: target.projectId,
        environment_id: target.environmentId,
        service_id: target.serviceId,
        workload_id: target.workloadId,
        deployment_id: target.deploymentId,
        replica: target.replica,
        node_id: target.node.id,
        // SECURITY: argv[0] only; arguments may carry secrets.
        command: command[0],
        recorded: recipient !== null,
      },
      ip,
    });

    const headers = new Headers({ upgrade: "websocket" });
    headers.set(SHELL_SESSION_HEADER, JSON.stringify(descriptor));
    // Only the upgrade and the trusted descriptor travel on; credentials stay here.
    const stub = c.env.NODE_CONNECTION.get(c.env.NODE_CONNECTION.idFromName(target.node.id));
    try {
      return await stub.fetch(new Request(c.req.url, { headers }));
    } catch (err) {
      console.error("shell relay unreachable", err instanceof Error ? err.name : "error");
      await finishShellSession(db, sessionId, {
        reason: "error",
        exitCode: null,
        bytesIn: 0,
        bytesOut: 0,
        recording: "none",
      });
      return closedSocket(SHELL_CLOSE_CODES.nodeUnavailable, "The node's relay is unavailable");
    }
  })
  .openapi(listShellTargets, async (c) => {
    const { serviceId } = c.req.valid("param");
    const { environment_id } = c.req.valid("query");
    const { project, caller } = await serviceScope(
      c,
      serviceId,
      policyOf(listShellTargets).action!,
      environment_id,
    );
    const environment = await environmentOf(c, project.id, environment_id);
    const rows = await c
      .get("db")
      .select({ placement: placements, node: nodes })
      .from(placements)
      .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
      .innerJoin(nodes, eq(nodes.id, placements.nodeId))
      .where(
        and(
          eq(deployments.serviceId, serviceId),
          eq(deployments.environmentId, environment_id),
          inArray(deployments.status, [...SERVING_STATUSES]),
          inArray(placements.state, [...SHELL_TARGET_STATES]),
          isNull(nodes.deletedAt),
        ),
      )
      .orderBy(desc(deployments.createdAt), asc(placements.replica));
    const now = Date.now();
    const gate = await evaluateGate(
      c,
      caller.principal,
      caller.allows(policyOf(openShell).action as "shell:open"),
      environment.protected,
    );
    return c.json(
      {
        targets: rows.map(({ placement, node }) => {
          const status = effectiveStatus(node, now);
          return {
            workload_id: placement.workloadId,
            deployment_id: placement.deploymentId,
            replica: placement.replica,
            node_id: node.id,
            node_name: node.name,
            state: placement.state,
            shell_supported:
              (status === "online" || status === "degraded") &&
              node.protocolVersion >= EXEC_PROTOCOL_VERSION &&
              node.encryptionPublicKey !== null,
          };
        }),
        gate: gate.allowed
          ? { allowed: true, reason: null }
          : { allowed: false, reason: gate.reason },
      },
      200,
    );
  })
  .openapi(listShellSessions, async (c) => {
    const { workspaceId } = c.req.valid("param");
    const query = c.req.valid("query");
    await requireWorkspace(c, workspaceId, policyOf(listShellSessions).action!);
    if (query.cursor && !SESSION_CURSOR_RE.test(query.cursor)) {
      throw new ApiError(400, "invalid_request", "cursor: malformed");
    }
    // Session IDs are monotonic ULIDs, so ID order is start order.
    const rows = await c
      .get("db")
      .select()
      .from(shellSessions)
      .where(
        and(
          eq(shellSessions.workspaceId, workspaceId),
          query.project_id ? eq(shellSessions.projectId, query.project_id) : undefined,
          query.cursor ? lt(shellSessions.id, query.cursor) : undefined,
        ),
      )
      .orderBy(desc(shellSessions.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    return c.json(
      {
        sessions: page.map(toApiShellSession),
        next_cursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
      },
      200,
    );
  })
  .openapi(terminateShellSession, async (c) => {
    const { sessionId } = c.req.valid("param");
    const principal = await requirePrincipal(c);
    const db = c.get("db");
    const [row] = await db
      .select({ session: shellSessions })
      .from(shellSessions)
      .innerJoin(projects, eq(projects.id, shellSessions.projectId))
      .innerJoin(workspaces, eq(workspaces.id, shellSessions.workspaceId))
      .where(
        and(
          eq(shellSessions.id, sessionId),
          isNull(projects.deletedAt),
          isNull(workspaces.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Shell session");
    const { session } = row;
    const own = session.userId === principal.user.id;
    let caller: Awaited<ReturnType<typeof requireWorkspace>>;
    try {
      caller = own
        ? await requireWorkspace(c, session.workspaceId, policyOf(terminateShellSession).action!, {
            projectId: session.projectId,
            environmentId: session.environmentId,
          })
        : await requireWorkspace(c, session.workspaceId, "members:manage");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw notFound("Shell session");
      throw err;
    }
    if (session.endedAt) throw conflict("The shell session already ended");

    const actor = caller.actor;
    let ended = false;
    if (session.nodeId) {
      const stub = c.env.NODE_CONNECTION.get(c.env.NODE_CONNECTION.idFromName(session.nodeId));
      try {
        ended = await stub.terminateShell(sessionId, actor);
      } catch (err) {
        console.warn("shell terminate failed", err instanceof Error ? err.name : "error");
      }
    }
    if (!ended) {
      // No relay holds it (its node or Durable Object is gone): end the row here.
      await finishShellSession(db, sessionId, {
        reason: "terminated",
        exitCode: null,
        bytesIn: session.bytesIn,
        bytesOut: session.bytesOut,
        actor,
      });
    }
    await recordAudit(db, {
      workspaceId: session.workspaceId,
      ...actor,
      action: "shell.terminated",
      targetType: "shell_session",
      targetId: sessionId,
      metadata: {
        project_id: session.projectId,
        environment_id: session.environmentId,
        service_id: session.serviceId,
        workload_id: session.workloadId,
        replica: session.replica,
        node_id: session.nodeId,
        own,
      },
      ip: clientIp(c),
    });
    const [updated] = await db
      .select()
      .from(shellSessions)
      .where(eq(shellSessions.id, sessionId))
      .limit(1);
    return c.json(toApiShellSession(updated!), 200);
  })
  .openapi(getShellRecording, async (c) => {
    // The router already refused stale sessions and API tokens (`reauth: true`).
    const { sessionId } = c.req.valid("param");
    const db = c.get("db");
    const [row] = await db
      .select({ session: shellSessions })
      .from(shellSessions)
      .innerJoin(projects, eq(projects.id, shellSessions.projectId))
      .innerJoin(workspaces, eq(workspaces.id, shellSessions.workspaceId))
      .where(
        and(
          eq(shellSessions.id, sessionId),
          isNull(projects.deletedAt),
          isNull(workspaces.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw notFound("Shell session");
    const { session } = row;
    let caller: Awaited<ReturnType<typeof requireWorkspace>>;
    try {
      caller = await requireWorkspace(c, session.workspaceId, policyOf(getShellRecording).action!);
      // SECURITY: a recording shows what the shell showed, secrets included,
      // so it takes the right to open that shell too.
      await requireWorkspace(c, session.workspaceId, "shell:open", {
        projectId: session.projectId,
        environmentId: session.environmentId,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw notFound("Shell session");
      throw err;
    }
    if (session.recording !== "stored" || session.recordingParts < 1) {
      throw notFound("Shell recording");
    }
    const body = await readShellRecording(c.env, db, session);
    await recordAudit(db, {
      workspaceId: session.workspaceId,
      ...caller.actor,
      action: "shell.recording_viewed",
      targetType: "shell_session",
      targetId: sessionId,
      metadata: {
        project_id: session.projectId,
        environment_id: session.environmentId,
        service_id: session.serviceId,
        user_id: session.userId,
      },
      ip: clientIp(c),
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": `${ASCIICAST_CONTENT_TYPE}; charset=utf-8`,
        "cache-control": "no-store",
      },
    });
  });
