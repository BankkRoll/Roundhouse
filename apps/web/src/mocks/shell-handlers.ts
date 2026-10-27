/**
 * MSW mocks of the web shell (ADR 0012 "Web shell", ADR 0014 §15): the replica list
 * with its gate, the shell socket, and the audit list of sessions.
 *
 * The socket mirrors the relay: the upgrade is accepted and refusals arrive as close
 * codes; then `opened`, binary output (the mock echoes input back), `resize` and `close`
 * control frames, and `exit` followed by a 1000 close.
 *
 * @module
 */
import {
  SHELL_CLOSE_CODES,
  SHELL_DENIAL_CLOSE_CODES,
  type ShellClientMessage,
  type ShellExitReason,
  type ShellServerMessage,
  shellGate,
} from "@roundhouse/shared";
import { HttpResponse, http, ws } from "msw";
import type { ShellGate, ShellSession, ShellTarget } from "../lib/api/shell-client";
import { accessFor } from "./access-resolve";
import { apiError, currentUser, notFound, requireWorkspace, unauthorized } from "./common";
import { db, nextId } from "./db";

/** Default idle timeout the mock relay reports, as the API's default. */
export const MOCK_SHELL_IDLE_TIMEOUT_S = 900;

/** One socket the mock relay accepted. */
export interface MockShellSession {
  id: string;
  url: URL;
  workloadId: string;
  /** Binary frames the client sent, decoded as UTF-8. */
  input: string[];
  /** Control frames the client sent. */
  control: ShellClientMessage[];
  open: boolean;
  /** Sends a server message or output bytes down the socket. */
  send: (data: string | Uint8Array) => void;
  close: (code: number, reason: string) => void;
}

interface ShellMockState {
  /** Sockets accepted, oldest first. */
  sessions: MockShellSession[];
  /** Nodes whose agent predates the shell protocol. */
  outdatedNodes: Set<string>;
  /** When set, every new socket closes with it at once (busy, node unavailable). */
  refuseWith: number | null;
  /** Rows of `GET /v1/workspaces/{ws}/shell-sessions`. */
  rows: ShellSession[];
}

/** The mock relay's state; tests read and steer it. Reset after every test. */
export const shellMock: ShellMockState = {
  sessions: [],
  outdatedNodes: new Set(),
  refuseWith: null,
  rows: [],
};

/** Restores {@link shellMock}. */
export function resetShellMock(): void {
  shellMock.sessions = [];
  shellMock.outdatedNodes = new Set();
  shellMock.refuseWith = null;
  shellMock.rows = [];
}

const decoder = new TextDecoder();

function serviceScope(serviceId: string) {
  const service = db.deploy.services.find((row) => row.id === serviceId && !row.deleted);
  const project = service
    ? db.deploy.projects.find((row) => row.id === service.project_id && !row.deleted)
    : undefined;
  return service && project ? { service, project } : null;
}

function gateFor(workspaceId: string, projectId: string, environmentId: string): ShellGate {
  const user = currentUser();
  if (!user) return { allowed: false, reason: "forbidden" };
  const decision = shellGate({
    credential: "session",
    accessAllowed: accessFor(workspaceId, user).check("shell:open", { projectId, environmentId })
      .allowed,
    twoFactorEnabled: Boolean(db.security.twoFactor[user.id]),
    freshSession: !db.sessionStale,
    environmentProtected: false,
  });
  return decision.allowed
    ? { allowed: true, reason: null }
    : { allowed: false, reason: decision.reason };
}

function targetsOf(serviceId: string, environmentId: string): ShellTarget[] {
  const active = db.deploy.deployments.filter(
    (row) =>
      row.service_id === serviceId &&
      row.environment_id === environmentId &&
      (row.status === "active" || row.status === "deploying"),
  );
  return db.deploy.placements
    .filter((row) => active.some((deployment) => deployment.id === row.deployment_id))
    .filter((row) => row.workload_id && row.node_id)
    .map((row) => ({
      workload_id: row.workload_id as string,
      deployment_id: row.deployment_id,
      replica: row.replica,
      node_id: row.node_id as string,
      node_name: row.node_name ?? row.node_id ?? "",
      state: row.state === "healthy" ? "running" : row.state,
      shell_supported: !shellMock.outdatedNodes.has(row.node_id as string),
    }))
    .sort((a, b) => a.replica - b.replica);
}

/**
 * Closes after the frames already sent: msw delivers a close at once but messages on
 * the next tick, so closing right after an `exit` would drop it.
 */
function closeAfterSend(session: MockShellSession, code: number, reason: string): void {
  setTimeout(() => session.close(code, reason), 0);
}

const REFUSAL_MESSAGES: Record<number, string> = {
  [SHELL_CLOSE_CODES.nodeUnavailable]: "The node's agent isn't connected",
  [SHELL_CLOSE_CODES.busy]: "The node runs its maximum number of sessions",
};

const shellLink = ws.link(/\/v1\/workloads\/[^/]+\/shell(\?.*)?$/);

const socketHandler = shellLink.addEventListener("connection", ({ client }) => {
  const workloadId = decodeURIComponent(
    /\/v1\/workloads\/([^/]+)\/shell/.exec(client.url.pathname)?.[1] ?? "",
  );
  const user = currentUser();
  if (!user) {
    client.close(SHELL_CLOSE_CODES.unauthorized, "unauthorized");
    return;
  }
  const placement = db.deploy.placements.find((row) => row.workload_id === workloadId);
  const deployment = placement
    ? db.deploy.deployments.find((row) => row.id === placement.deployment_id)
    : undefined;
  const scope = deployment ? serviceScope(deployment.service_id) : null;
  if (!placement || !deployment || !scope) {
    client.close(SHELL_CLOSE_CODES.notFound, "not found");
    return;
  }
  const gate = gateFor(scope.project.workspace_id, scope.project.id, deployment.environment_id);
  if (!gate.allowed && gate.reason) {
    client.close(SHELL_DENIAL_CLOSE_CODES[gate.reason], gate.reason);
    return;
  }
  // NOTE: Like the relay, refusals after the gate send an `exit` with the reason first.
  const refuse = (code: number, reason: ShellExitReason, message: string) => {
    const exit: ShellServerMessage = { type: "exit", code: null, reason, message };
    client.send(JSON.stringify(exit));
    setTimeout(() => client.close(code, message), 0);
  };
  if (placement.node_id && shellMock.outdatedNodes.has(placement.node_id)) {
    refuse(SHELL_CLOSE_CODES.agentOutdated, "error", "The node's agent predates web shells");
    return;
  }
  if (shellMock.refuseWith !== null) {
    refuse(
      shellMock.refuseWith,
      shellMock.refuseWith === SHELL_CLOSE_CODES.nodeUnavailable ? "node_disconnected" : "error",
      REFUSAL_MESSAGES[shellMock.refuseWith] ?? "Refused",
    );
    return;
  }

  const session: MockShellSession = {
    id: nextId("shl"),
    url: client.url,
    workloadId,
    input: [],
    control: [],
    open: true,
    // NOTE: Copied so bytes from another realm (a test's TextEncoder) pass msw's type check.
    send: (data) => client.send(typeof data === "string" ? data : new Uint8Array(data)),
    close: (code, reason) => {
      session.open = false;
      client.close(code, reason);
    },
  };
  shellMock.sessions.push(session);
  const now = Date.now();
  shellMock.rows.push({
    id: session.id,
    project_id: scope.project.id,
    environment_id: deployment.environment_id,
    service_id: scope.service.id,
    workload_id: workloadId,
    deployment_id: deployment.id,
    replica: placement.replica,
    node_id: placement.node_id,
    user_id: user.id,
    token_id: null,
    command: "/bin/sh",
    container_user: "node",
    started_at: now,
    opened_at: now,
    ended_at: null,
    end_reason: null,
    exit_code: null,
    bytes_in: 0,
    bytes_out: 0,
  });
  const opened: ShellServerMessage = {
    type: "opened",
    session_id: session.id,
    node_id: placement.node_id ?? "",
    node_name: placement.node_name ?? "",
    user: "node",
    replica: placement.replica,
    idle_timeout_s: MOCK_SHELL_IDLE_TIMEOUT_S,
    max_duration_s: 8 * 3600,
  };
  client.send(JSON.stringify(opened));

  client.addEventListener("message", (event) => {
    const data: unknown = event.data;
    if (typeof data === "string") {
      let message: ShellClientMessage;
      try {
        message = JSON.parse(data) as ShellClientMessage;
      } catch {
        session.close(SHELL_CLOSE_CODES.policy, "malformed frame");
        return;
      }
      session.control.push(message);
      if (message.type === "close") {
        const exit: ShellServerMessage = { type: "exit", code: null, reason: "closed" };
        client.send(JSON.stringify(exit));
        closeAfterSend(session, SHELL_CLOSE_CODES.normal, "closed");
      }
      return;
    }
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : null;
    if (!bytes) return;
    session.input.push(decoder.decode(bytes));
    client.send(new Uint8Array(bytes));
  });
});

/**
 * Ends a mock session the way the relay does: an `exit` message, then a 1000 close.
 *
 * @param session - The session.
 * @param exit - Reason and exit code.
 */
export function exitShellSession(
  session: MockShellSession,
  exit: { reason: Extract<ShellServerMessage, { type: "exit" }>["reason"]; code: number | null },
): void {
  session.send(JSON.stringify({ type: "exit", ...exit } satisfies ShellServerMessage));
  closeAfterSend(session, SHELL_CLOSE_CODES.normal, exit.reason);
}

/** HTTP handlers of the shell routes. */
export const shellHandlers = [
  http.get("*/v1/services/:serviceId/shell-targets", ({ params, request }) => {
    const environmentId = new URL(request.url).searchParams.get("environment_id");
    if (!environmentId) {
      return apiError(400, "invalid_request", "environment_id: Required");
    }
    if (!currentUser()) return unauthorized();
    const scope = serviceScope(String(params.serviceId));
    if (!scope) return notFound("Service");
    const guard = requireWorkspace(scope.project.workspace_id, "projects:read");
    if (!guard.ok) return guard.response.status === 403 ? notFound("Service") : guard.response;
    return HttpResponse.json({
      targets: targetsOf(scope.service.id, environmentId),
      gate: gateFor(scope.project.workspace_id, scope.project.id, environmentId),
    });
  }),

  http.get("*/v1/workspaces/:workspaceId/shell-sessions", ({ params, request }) => {
    const guard = requireWorkspace(String(params.workspaceId), "audit:read");
    if (!guard.ok) return guard.response;
    const projectId = new URL(request.url).searchParams.get("project_id");
    const sessions = shellMock.rows
      .filter((row) => !projectId || row.project_id === projectId)
      .sort((a, b) => b.started_at - a.started_at);
    return HttpResponse.json({ sessions, next_cursor: null });
  }),

  http.post("*/v1/shell-sessions/:sessionId/terminate", ({ params }) => {
    const user = currentUser();
    if (!user) return unauthorized();
    const row = shellMock.rows.find((entry) => entry.id === params.sessionId);
    const project = row
      ? db.deploy.projects.find((entry) => entry.id === row.project_id)
      : undefined;
    if (!row || !project) return notFound("Shell session");
    const allowed = accessFor(project.workspace_id, user).check("shell:open", {
      projectId: row.project_id,
      environmentId: row.environment_id,
    }).allowed;
    const guard = requireWorkspace(project.workspace_id, "members:manage");
    if (!allowed || (row.user_id !== user.id && !guard.ok)) {
      return apiError(403, "forbidden", "You can't terminate this shell session");
    }
    if (row.ended_at !== null) return apiError(409, "conflict", "The session already ended");
    row.ended_at = Date.now();
    row.end_reason = "terminated";
    for (const session of shellMock.sessions.filter((entry) => entry.id === row.id)) {
      exitShellSession(session, { reason: "revoked", code: null });
    }
    return HttpResponse.json(row);
  }),

  http.get("*/v1/workloads/:workloadId/shell", () =>
    // NOTE: Identity is checked only after an upgrade, so a plain request is always 426.
    apiError(426, "upgrade_required", "Expected a WebSocket upgrade"),
  ),
];

/** The shell socket handler. */
export const shellWebSocketHandlers = [socketHandler];
