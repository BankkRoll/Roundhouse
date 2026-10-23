/**
 * MSW handlers for every Phase 1 route in `PHASE1_ROUTES`, plus a WebSocket link that
 * plays the project's realtime socket.
 *
 * Requests are validated with the route's own zod schemas (params, query, headers and
 * body, imported from the API source), and failures use the API's `defaultHook` wording
 * (`path: message`), so the mocks reject exactly what the API rejects. After that the
 * handlers follow the API's order: 401 without a session, 404 when the row is missing
 * or the caller isn't a member of its workspace, 403 when the role lacks the route's
 * action, then 409 conflicts.
 *
 * Mutations broadcast the realtime messages the API would (`deployment.updated`,
 * `service.updated`) to sockets of the project. Like the API, the socket is accepted and
 * then closed with `REALTIME_CLOSE_CODES` when the caller may not have it, and new
 * project, environment and service slugs are suffixed with `freeSlug` instead of refused.
 *
 * @module
 */
import {
  type Action,
  API_TOKEN_DISPLAY_PREFIX_LENGTH,
  API_TOKEN_PREFIX,
  type ApiTokenScope,
  type BuiltinVariable,
  CANCELLABLE_DEPLOYMENT_STATUSES,
  type DeploymentStatus,
  defaultServiceConfig,
  freeSlug,
  generatedHostname,
  parseReferences,
  REALTIME_CLOSE_CODES,
  RESERVED_SERVICE_SLUGS,
  ROLLBACK_SOURCE_STATUSES,
  resolveVariables,
  scopesBeyondRole,
  secretBuildArgsValid,
  secretDerivedVariables,
  slugify,
} from "@roundhouse/shared";
import { HttpResponse, http, ws } from "msw";
import { PHASE1_ROUTES, policyOf } from "../../../api/src/contracts";
import type {
  ApiToken,
  Deployment,
  DeploymentDetail,
  Environment,
  Project,
  ProjectDetail,
  ProjectSummary,
  RealtimeServerMessage,
  Service,
  ServiceConfig,
  Variable,
} from "../lib/api/deploy-types";
import {
  apiError,
  currentUser,
  type Guard,
  invalid,
  notFound,
  recordAudit,
  requireWorkspace,
  unauthorized,
} from "./common";
import { db, nextId } from "./db";
import type { DbApiToken, DbDeployment, DbVariable } from "./deploy-db";

// -----------------------------------------------------------------------------
// Validation with the contract's schemas
// -----------------------------------------------------------------------------

interface ZodIssue {
  path: PropertyKey[];
  message: string;
}

interface Schema {
  safeParse(
    value: unknown,
  ): { success: true; data: unknown } | { success: false; error: { issues: ZodIssue[] } };
}

interface RouteRequest {
  params?: Schema;
  query?: Schema;
  headers?: Schema;
  body?: { content: { "application/json": { schema: Schema } } };
}

type RouteName = keyof typeof PHASE1_ROUTES;

type Validated =
  | {
      ok: true;
      params: Record<string, string>;
      query: Record<string, unknown>;
      body: Record<string, unknown>;
    }
  | { ok: false; response: Response };

/** Mirrors `createRouter`'s defaultHook: the first issue as `path: message`. */
function issueResponse(issues: ZodIssue[]): Response {
  const issue = issues[0];
  const where = issue?.path.length ? `${issue.path.map(String).join(".")}: ` : "";
  return invalid(`${where}${issue?.message ?? "invalid"}`);
}

/**
 * Validates a request against a contract route the way `@hono/zod-openapi` does:
 * params, query, headers, then the JSON body.
 */
async function validate(
  name: RouteName,
  request: Request,
  params: Record<string, string | readonly string[] | undefined>,
): Promise<Validated> {
  const spec = (PHASE1_ROUTES[name] as { request?: RouteRequest }).request ?? {};
  const url = new URL(request.url);
  const parts: [Schema | undefined, unknown][] = [
    [spec.params, params],
    [spec.query, Object.fromEntries(url.searchParams)],
    [spec.headers, Object.fromEntries(request.headers)],
  ];
  const out: unknown[] = [];
  for (const [schema, value] of parts) {
    if (!schema) {
      out.push(value);
      continue;
    }
    const result = schema.safeParse(value);
    if (!result.success) return { ok: false, response: issueResponse(result.error.issues) };
    out.push(result.data);
  }
  let body: unknown = {};
  const bodySchema = spec.body?.content["application/json"].schema;
  if (bodySchema) {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return { ok: false, response: invalid("Malformed JSON in request body") };
    }
    const result = bodySchema.safeParse(raw);
    if (!result.success) return { ok: false, response: issueResponse(result.error.issues) };
    body = result.data;
  }
  return {
    ok: true,
    params: out[0] as Record<string, string>,
    query: out[1] as Record<string, unknown>,
    body: body as Record<string, unknown>,
  };
}

/** The RBAC action a contract route requires. */
function actionOf(name: RouteName): Action {
  return policyOf(PHASE1_ROUTES[name]).action as Action;
}

/** Path of a contract route in MSW syntax, matching any origin. */
function mswPath(name: RouteName): string {
  return `*${PHASE1_ROUTES[name].path.replace(/\{([^}]+)\}/g, ":$1")}`;
}

const conflict = (message: string) => apiError(409, "conflict", message);
const noContent = () => new HttpResponse(null, { status: 204 });

// -----------------------------------------------------------------------------
// Row lookups and shaping
// -----------------------------------------------------------------------------

type Found<T> =
  | { ok: true; row: T; guard: Extract<Guard, { ok: true }> }
  | { ok: false; response: Response };

function liveProject(projectId: string) {
  return db.deploy.projects.find((row) => row.id === projectId && !row.deleted);
}

function liveService(serviceId: string) {
  const service = db.deploy.services.find((row) => row.id === serviceId && !row.deleted);
  return service && liveProject(service.project_id) ? service : undefined;
}

/** Resolves a row's workspace and checks the caller, in the API's order. */
function authorize<T>(
  row: T | undefined,
  what: string,
  workspaceId: (row: T) => string | undefined,
  action: Action,
): Found<T> {
  if (!currentUser()) return { ok: false, response: unauthorized() };
  const owner = row ? workspaceId(row) : undefined;
  if (!row || !owner) return { ok: false, response: notFound(what) };
  const guard = requireWorkspace(owner, action);
  // NOTE: Non-members get the same 404 as a missing row, so ids can't be probed.
  if (!guard.ok) {
    return { ok: false, response: guard.response.status === 404 ? notFound(what) : guard.response };
  }
  return { ok: true, row, guard };
}

function projectAccess(projectId: string, action: Action) {
  return authorize(liveProject(projectId), "Project", (project) => project.workspace_id, action);
}

function serviceAccess(serviceId: string, action: Action) {
  return authorize(
    liveService(serviceId),
    "Service",
    (service) => liveProject(service.project_id)?.workspace_id,
    action,
  );
}

function deploymentAccess(deploymentId: string, action: Action) {
  const row = db.deploy.deployments.find((entry) => entry.id === deploymentId);
  return authorize(
    row,
    "Deployment",
    (deployment) => {
      const service = liveService(deployment.service_id);
      return service ? liveProject(service.project_id)?.workspace_id : undefined;
    },
    action,
  );
}

function environmentOf(projectId: string, environmentId: unknown): Environment | undefined {
  return db.deploy.environments.find(
    (row) => row.id === environmentId && row.project_id === projectId,
  );
}

function stripProject({ deleted: _deleted, ...project }: Project & { deleted?: boolean }): Project {
  return project;
}

function stripService({ deleted: _deleted, ...service }: Service & { deleted?: boolean }): Service {
  return service;
}

function projectDetail(project: Project): ProjectDetail {
  return {
    ...stripProject(project),
    environments: db.deploy.environments
      .filter((row) => row.project_id === project.id)
      .sort((a, b) =>
        a.kind === "production" ? -1 : b.kind === "production" ? 1 : a.created_at - b.created_at,
      ),
    services: db.deploy.services
      .filter((row) => row.project_id === project.id && !row.deleted)
      .map(stripService),
  };
}

function toDeployment(row: DbDeployment): Deployment {
  return { ...row, build: db.deploy.builds.find((build) => build.id === row.build_id) ?? null };
}

function toDetail(row: DbDeployment): DeploymentDetail {
  return {
    ...toDeployment(row),
    events: db.deploy.events
      .filter((event) => event.deployment_id === row.id)
      .sort((a, b) => a.created_at - b.created_at),
    placements: db.deploy.placements
      .filter((placement) => placement.deployment_id === row.id)
      .sort((a, b) => a.replica - b.replica),
  };
}

function latestConfig(serviceId: string, environmentId: string): ServiceConfig | undefined {
  return db.deploy.configs
    .filter((row) => row.service_id === serviceId && row.environment_id === environmentId)
    .sort((a, b) => b.version - a.version)[0];
}

/**
 * Stand-in for the API's per-project HMAC fingerprint: 8 hex of FNV-1a, so equal values
 * still match in the mock without it holding a key.
 */
function mockFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function toVariable(row: DbVariable): Variable {
  return {
    key: row.key,
    tier: row.tier,
    locked: row.locked,
    value: row.tier === "secret" ? null : row.value,
    fingerprint: mockFingerprint(row.value),
    available_at_build: row.available_at_build,
    mount_as_file: row.mount_as_file,
    version: row.version,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

function variablesOf(scope: DbVariable["scope"], ownerId: string, environmentId: string) {
  return db.deploy.variables.filter(
    (row) =>
      row.scope === scope && row.owner_id === ownerId && row.environment_id === environmentId,
  );
}

function listVariables(scope: DbVariable["scope"], ownerId: string, environmentId: string) {
  return {
    variables: variablesOf(scope, ownerId, environmentId)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(toVariable),
  };
}

function byNewest(a: { created_at: number; id: string }, b: { created_at: number; id: string }) {
  return b.created_at - a.created_at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

function byId(a: { id: string }, b: { id: string }) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Mirrors the API's `projectSummaries`: services by id, each with its latest config
 * version, first domain (by id) and newest deployment in `environment`.
 */
function summarize(project: Project, environment: Environment | undefined): ProjectSummary {
  const detail = projectDetail(project);
  return {
    ...detail,
    environment: environment ?? null,
    services: [...detail.services].sort(byId).map((service) => {
      if (!environment) {
        return {
          service,
          config_version: null,
          source: null,
          domain: null,
          latest_deployment: null,
        };
      }
      const config = latestConfig(service.id, environment.id);
      const domain = db.deploy.domains
        .filter((row) => row.service_id === service.id && row.environment_id === environment.id)
        .sort(byId)[0];
      const latest = db.deploy.deployments
        .filter((row) => row.service_id === service.id && row.environment_id === environment.id)
        .sort(byNewest)[0];
      return {
        service,
        config_version: config?.version ?? null,
        source: config?.source ?? null,
        domain: domain ? { hostname: domain.hostname, url: domain.url } : null,
        latest_deployment: latest ? toDeployment(latest) : null,
      };
    }),
  };
}

function productionOf(projectId: string): Environment | undefined {
  return db.deploy.environments.find(
    (row) => row.project_id === projectId && row.kind === "production",
  );
}

/** Deployments whose replicas belong on nodes; the API's `LIVE_DEPLOYMENT_STATUSES`. */
const LIVE_STATUSES: readonly DeploymentStatus[] = ["deploying", "active", "crashed"];

/** Mirrors the API's `resolveServiceEnvironment`, built-ins included. */
function resolveEnvironment(service: Service, environment: Environment) {
  const live = db.deploy.services.filter(
    (row) => row.project_id === service.project_id && !row.deleted,
  );
  const values = (scope: DbVariable["scope"], ownerId: string) =>
    Object.fromEntries(
      variablesOf(scope, ownerId, environment.id).map((row) => [row.key, row.value]),
    );
  const services: Record<string, Record<string, string>> = {};
  const builtins: Record<string, Partial<Record<BuiltinVariable, string>>> = {};
  for (const entry of live) {
    services[entry.slug] = values("service", entry.id);
    const port = latestConfig(entry.id, environment.id)?.networking.port;
    const host = db.deploy.domains
      .filter((row) => row.service_id === entry.id && row.environment_id === environment.id)
      .sort(byId)[0]?.hostname;
    builtins[entry.slug] = {
      ...(port ? { PORT: String(port) } : {}),
      ...(host ? { ROUNDHOUSE_PUBLIC_DOMAIN: host } : {}),
      ROUNDHOUSE_PRIVATE_DOMAIN: `${entry.slug}.${environment.slug}.internal`,
      ROUNDHOUSE_ENVIRONMENT: environment.slug,
      ROUNDHOUSE_SERVICE_NAME: entry.name,
    };
  }
  const current = db.deploy.deployments
    .filter(
      (row) =>
        row.service_id === service.id &&
        row.environment_id === environment.id &&
        LIVE_STATUSES.includes(row.status),
    )
    .sort(byNewest)[0];
  const own = builtins[service.slug];
  if (current && own) {
    own.ROUNDHOUSE_DEPLOYMENT_ID = current.id;
    const sha = db.deploy.builds.find((row) => row.id === current.build_id)?.commit_sha;
    if (sha) own.ROUNDHOUSE_GIT_COMMIT_SHA = sha;
  }
  return resolveVariables({
    service: service.slug,
    services,
    shared: values("shared", service.project_id),
    builtins,
  });
}

/**
 * Mirrors the API's `local_keys`: the service's secrets plus every plain variable of it
 * whose resolution reaches a secret (`secretDerivedVariables`), sorted.
 */
function localKeys(service: Service, environment: Environment): string[] {
  const live = db.deploy.services.filter(
    (row) => row.project_id === service.project_id && !row.deleted,
  );
  const raw = (rows: DbVariable[]) => Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const secretKeys = (rows: DbVariable[]) =>
    rows.filter((row) => row.tier === "secret").map((row) => row.key);
  const services: Record<string, Record<string, string>> = {};
  const secretServiceKeys: Record<string, string[]> = {};
  for (const entry of live) {
    const rows = variablesOf("service", entry.id, environment.id);
    services[entry.slug] = raw(rows);
    secretServiceKeys[entry.slug] = secretKeys(rows);
  }
  const shared = variablesOf("shared", service.project_id, environment.id);
  const derived = secretDerivedVariables({
    services,
    shared: raw(shared),
    secretServiceKeys,
    secretSharedKeys: secretKeys(shared),
  });
  return [
    ...(secretServiceKeys[service.slug] ?? []),
    ...(derived.services[service.slug] ?? []),
  ].sort();
}

function toApiToken({ workspace_id: _w, secret: _s, ...token }: DbApiToken): ApiToken {
  return token;
}

const SECRET_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function tokenSecret(): string {
  let out = API_TOKEN_PREFIX;
  for (let i = 0; i < 40; i++) {
    out += SECRET_ALPHABET[Math.floor(Math.random() * SECRET_ALPHABET.length)];
  }
  return out;
}

function randomHex(length: number): string {
  let out = "";
  while (out.length < length) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

// -----------------------------------------------------------------------------
// Realtime
// -----------------------------------------------------------------------------

/** The mock realtime socket, shared by the HTTP handlers (broadcasts) and tests. */
export const realtimeLink = ws.link(/\/v1\/projects\/[^/]+\/realtime$/);

interface SocketState {
  projectId: string;
  topics: Set<string>;
  send: (data: string) => void;
  close: (code: number, reason: string) => void;
}

const sockets = new Map<unknown, SocketState>();

/** Every message the mock socket sent, oldest first; the contract test validates them. */
export const sentRealtimeMessages: RealtimeServerMessage[] = [];

function send(state: SocketState, message: RealtimeServerMessage) {
  sentRealtimeMessages.push(message);
  state.send(JSON.stringify(message));
}

/**
 * Sends a message to every socket open on a project. Log lines go only to sockets
 * subscribed to their deployment or build, like the API's `ProjectRoom`.
 *
 * @param projectId - Project whose sockets receive it.
 * @param message - The server message.
 */
export function broadcastRealtime(projectId: string, message: RealtimeServerMessage): void {
  const topic =
    message.type === "log.lines"
      ? message.source.type === "runtime"
        ? `deployment_logs:${message.source.deployment_id}`
        : `build_logs:${message.source.build_id}`
      : null;
  for (const state of sockets.values()) {
    if (state.projectId !== projectId) continue;
    if (topic && !state.topics.has(topic)) continue;
    send(state, message);
  }
}

/**
 * Log topics currently subscribed on a project's sockets.
 *
 * @param projectId - Project id.
 * @returns Topic keys such as `deployment_logs:dep_1`.
 */
export function realtimeSubscriptions(projectId: string): string[] {
  return [...sockets.values()]
    .filter((state) => state.projectId === projectId)
    .flatMap((state) => [...state.topics]);
}

/**
 * Closes a project's open sockets the way the API's periodic re-check does when the
 * session lapses (4401) or membership is lost (4403).
 *
 * @param projectId - Project whose sockets close.
 * @param code - One of `REALTIME_CLOSE_CODES`.
 */
export function closeRealtime(projectId: string, code: number): void {
  for (const [client, state] of sockets) {
    if (state.projectId !== projectId) continue;
    sockets.delete(client);
    state.close(code, "closed by server");
  }
}

/** Closes every mock socket (between tests). */
export function resetRealtime(): void {
  sockets.clear();
  sentRealtimeMessages.length = 0;
}

function projectOfDeployment(deployment: DbDeployment): string | undefined {
  return db.deploy.services.find((service) => service.id === deployment.service_id)?.project_id;
}

function announceDeployment(row: DbDeployment) {
  const projectId = projectOfDeployment(row);
  if (projectId)
    broadcastRealtime(projectId, { type: "deployment.updated", deployment: toDeployment(row) });
}

const realtimeHandler = realtimeLink.addEventListener("connection", ({ client }) => {
  const projectId = /\/v1\/projects\/([^/]+)\/realtime/.exec(client.url.pathname)?.[1] ?? "";
  const project = liveProject(decodeURIComponent(projectId));
  // NOTE: Like the API, the upgrade is accepted and the reason reported as a close code,
  // because a browser can't read the status of a refused upgrade.
  if (!currentUser()) {
    client.close(REALTIME_CLOSE_CODES.unauthorized, "unauthorized");
    return;
  }
  const guard = project
    ? requireWorkspace(project.workspace_id, actionOf("projectRealtime"))
    : undefined;
  if (!project || !guard || (!guard.ok && guard.response.status === 404)) {
    client.close(REALTIME_CLOSE_CODES.notFound, "not found");
    return;
  }
  if (!guard.ok) {
    client.close(REALTIME_CLOSE_CODES.forbidden, "forbidden");
    return;
  }
  const state: SocketState = {
    projectId: project.id,
    topics: new Set(),
    send: (data) => client.send(data),
    close: (code, reason) => client.close(code, reason),
  };
  sockets.set(client, state);
  send(state, { type: "presence", users: db.deploy.presence });
  client.addEventListener("message", (event) => {
    let message: unknown;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const parsed = message as {
      type?: string;
      topic?: { kind?: string; deployment_id?: string; build_id?: string };
    };
    const topic = parsed.topic;
    if (!topic) return;
    const key =
      topic.kind === "deployment_logs"
        ? `deployment_logs:${topic.deployment_id}`
        : `build_logs:${topic.build_id}`;
    if (parsed.type === "subscribe") state.topics.add(key);
    if (parsed.type === "unsubscribe") state.topics.delete(key);
  });
  client.addEventListener("close", () => sockets.delete(client));
});

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

function createConfigs(
  service: Service,
  source: ServiceConfig["source"],
  overrides: Record<string, Record<string, unknown> | null | undefined>,
  userId: string,
): ServiceConfig[] {
  const now = Date.now();
  return db.deploy.environments
    .filter((environment) => environment.project_id === service.project_id)
    .map((environment) => {
      const base = defaultServiceConfig(source);
      const merged = { ...base } as Record<string, unknown>;
      for (const [part, value] of Object.entries(overrides)) {
        if (value === undefined) continue;
        merged[part] =
          part === "healthcheck" || value === null
            ? value
            : { ...(base[part as keyof typeof base] as object), ...value };
      }
      return {
        id: nextId("cfg"),
        service_id: service.id,
        environment_id: environment.id,
        version: 1,
        created_by: userId,
        created_at: now,
        ...(merged as Omit<
          ServiceConfig,
          "id" | "service_id" | "environment_id" | "version" | "created_by" | "created_at"
        >),
      };
    });
}

function ensureGeneratedDomain(service: Service, config: ServiceConfig) {
  const appsDomain = db.deploy.instance.apps_domain;
  if (!appsDomain || !config.networking.generated_domain || config.networking.port === null) return;
  const exists = db.deploy.domains.some(
    (row) =>
      row.service_id === service.id &&
      row.environment_id === config.environment_id &&
      row.type === "generated",
  );
  if (exists) return;
  const environment = db.deploy.environments.find((row) => row.id === config.environment_id);
  const hostname = generatedHostname(
    service.slug,
    environment?.slug ?? "env",
    appsDomain,
    Math.random,
  );
  db.deploy.domains.push({
    id: nextId("dom"),
    service_id: service.id,
    environment_id: config.environment_id,
    hostname,
    url: `${db.deploy.instance.tls_mode === "off" ? "http" : "https"}://${hostname}`,
    type: "generated",
    target_port: config.networking.port,
    verification_status: "verified",
    tls_status: db.deploy.instance.tls_mode === "off" ? "disabled" : "pending",
    created_at: Date.now(),
  });
}

function logPage(key: string, query: Record<string, unknown>) {
  const lines = db.deploy.logs[key] ?? [];
  const limit = Number(query.limit ?? 200);
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;
  const end = cursor ? Math.min(lines.length, Number(cursor.replace(/^o/, "")) || 0) : lines.length;
  const start = Math.max(0, end - limit);
  return {
    lines: lines.slice(start, end),
    next_cursor: start > 0 ? `o${start}` : null,
  };
}

function requireInstanceAdmin(): Response | null {
  const user = currentUser();
  if (!user) return unauthorized();
  return user.instance_admin
    ? null
    : apiError(403, "forbidden", "Only instance admins can perform instance:manage");
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newDeployment(
  service: Service,
  environmentId: string,
  config: ServiceConfig,
  fields: Partial<DbDeployment>,
  userId: string | null,
): DbDeployment {
  const now = Date.now();
  return {
    id: nextId("dep"),
    project_id: service.project_id,
    service_id: service.id,
    environment_id: environmentId,
    config_version: config.version,
    build_id: null,
    image: null,
    status: "queued",
    trigger: "manual",
    triggered_by: userId,
    rollback_of: null,
    failure_reason: null,
    started_at: null,
    finished_at: null,
    created_at: now,
    updated_at: now,
    ...fields,
  };
}

function startDeployment(
  service: Service,
  environmentId: string,
  config: ServiceConfig,
  commitSha: string | undefined,
  trigger: DbDeployment["trigger"],
  userId: string | null,
): DbDeployment {
  const row = newDeployment(service, environmentId, config, { trigger }, userId);
  if (config.source.type === "git") {
    const buildId = nextId("bld");
    db.deploy.builds.push({
      id: buildId,
      deployment_id: row.id,
      service_id: service.id,
      commit_sha: commitSha ?? randomHex(40),
      commit_message: null,
      commit_author: null,
      status: "queued",
      node_id: null,
      image_repository: `127.0.0.1:5000/${service.project_id.toLowerCase()}/${service.id.toLowerCase()}`,
      image_digest: null,
      started_at: null,
      finished_at: null,
      error: null,
      created_at: row.created_at,
    });
    row.build_id = buildId;
  } else {
    row.image = config.source.image;
  }
  // Like the API, a new deployment supersedes older in-flight ones of the same service.
  for (const older of db.deploy.deployments) {
    if (
      older.service_id === service.id &&
      older.environment_id === environmentId &&
      CANCELLABLE_DEPLOYMENT_STATUSES.includes(older.status)
    ) {
      older.status = "cancelled";
      older.failure_reason = `Superseded by ${row.id}`;
      older.finished_at = row.created_at;
      older.updated_at = row.created_at;
      announceDeployment(older);
    }
  }
  db.deploy.deployments.push(row);
  db.deploy.events.push({
    id: nextId("dev"),
    deployment_id: row.id,
    type: "status_changed",
    message: "Queued",
    data: null,
    created_at: row.created_at,
  });
  return row;
}

/** Phase 1 route handlers, in the order of `PHASE1_ROUTES`. */
export const deployHandlers = [
  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------
  http.get(mswPath("listProjects"), async ({ request, params }) => {
    const input = await validate("listProjects", request, params);
    if (!input.ok) return input.response;
    const access = requireWorkspace(input.params.workspaceId ?? "", actionOf("listProjects"));
    if (!access.ok) return access.response;
    const slug = input.query.slug as string | undefined;
    const projects = db.deploy.projects
      .filter(
        (row) =>
          row.workspace_id === input.params.workspaceId &&
          !row.deleted &&
          (slug === undefined || row.slug === slug),
      )
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(stripProject);
    return HttpResponse.json({ projects });
  }),

  http.post(mswPath("createProject"), async ({ request, params }) => {
    const input = await validate("createProject", request, params);
    if (!input.ok) return input.response;
    const workspaceId = input.params.workspaceId ?? "";
    const access = requireWorkspace(workspaceId, actionOf("createProject"));
    if (!access.ok) return access.response;
    const name = String(input.body.name);
    const taken = new Set(
      db.deploy.projects
        .filter((row) => row.workspace_id === workspaceId && !row.deleted)
        .map((row) => row.slug),
    );
    const slug = freeSlug(
      taken,
      typeof input.body.slug === "string" ? input.body.slug : slugify(name, 40, "project"),
    );
    const now = Date.now();
    const project: Project = {
      id: nextId("prj"),
      workspace_id: workspaceId,
      name,
      slug,
      description: typeof input.body.description === "string" ? input.body.description : null,
      created_at: now,
      updated_at: now,
    };
    db.deploy.projects.push(project);
    db.deploy.environments.push({
      id: nextId("env"),
      project_id: project.id,
      name: "production",
      slug: "production",
      kind: "production",
      pr_number: null,
      source_branch: null,
      created_at: now,
    });
    recordAudit({
      workspaceId,
      actorType: "user",
      actorId: access.user.id,
      action: "project.created",
      targetType: "project",
      targetId: project.id,
      metadata: { name },
    });
    return HttpResponse.json(projectDetail(project), { status: 201 });
  }),

  http.get(mswPath("getProject"), async ({ request, params }) => {
    const input = await validate("getProject", request, params);
    if (!input.ok) return input.response;
    const found = projectAccess(input.params.projectId ?? "", actionOf("getProject"));
    if (!found.ok) return found.response;
    return HttpResponse.json(projectDetail(found.row));
  }),

  http.patch(mswPath("updateProject"), async ({ request, params }) => {
    const input = await validate("updateProject", request, params);
    if (!input.ok) return input.response;
    const found = projectAccess(input.params.projectId ?? "", actionOf("updateProject"));
    if (!found.ok) return found.response;
    const project = found.row;
    const slug = input.body.slug as string | undefined;
    if (
      slug &&
      db.deploy.projects.some(
        (row) =>
          row.workspace_id === project.workspace_id &&
          !row.deleted &&
          row.slug === slug &&
          row.id !== project.id,
      )
    ) {
      return conflict(`A project with slug "${slug}" already exists`);
    }
    if (typeof input.body.name === "string") project.name = input.body.name;
    if (slug) project.slug = slug;
    if (input.body.description !== undefined)
      project.description = (input.body.description as string | null) ?? null;
    project.updated_at = Date.now();
    recordAudit({
      workspaceId: project.workspace_id,
      actorType: "user",
      actorId: found.guard.user.id,
      action: "project.updated",
      targetType: "project",
      targetId: project.id,
      metadata: { name: project.name },
    });
    return HttpResponse.json(stripProject(project));
  }),

  http.delete(mswPath("deleteProject"), async ({ request, params }) => {
    const input = await validate("deleteProject", request, params);
    if (!input.ok) return input.response;
    const found = projectAccess(input.params.projectId ?? "", actionOf("deleteProject"));
    if (!found.ok) return found.response;
    found.row.deleted = true;
    for (const service of db.deploy.services) {
      if (service.project_id === found.row.id) service.deleted = true;
    }
    recordAudit({
      workspaceId: found.row.workspace_id,
      actorType: "user",
      actorId: found.guard.user.id,
      action: "project.deleted",
      targetType: "project",
      targetId: found.row.id,
      metadata: { name: found.row.name },
    });
    return noContent();
  }),

  http.get(mswPath("getProjectSummary"), async ({ request, params }) => {
    const input = await validate("getProjectSummary", request, params);
    if (!input.ok) return input.response;
    const found = projectAccess(input.params.projectId ?? "", actionOf("getProjectSummary"));
    if (!found.ok) return found.response;
    const requested = input.query.environment_id as string | undefined;
    const environment =
      requested === undefined ? productionOf(found.row.id) : environmentOf(found.row.id, requested);
    if (!environment) return notFound("Environment");
    return HttpResponse.json(summarize(found.row, environment));
  }),

  http.get(mswPath("listProjectSummaries"), async ({ request, params }) => {
    const input = await validate("listProjectSummaries", request, params);
    if (!input.ok) return input.response;
    const workspaceId = input.params.workspaceId ?? "";
    const access = requireWorkspace(workspaceId, actionOf("listProjectSummaries"));
    if (!access.ok) return access.response;
    const projects = db.deploy.projects
      .filter((row) => row.workspace_id === workspaceId && !row.deleted)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : byId(a, b)))
      .map((row) => summarize(row, productionOf(row.id)));
    return HttpResponse.json({ projects });
  }),

  // ---------------------------------------------------------------------------
  // Environments
  // ---------------------------------------------------------------------------
  http.get(mswPath("listEnvironments"), async ({ request, params }) => {
    const input = await validate("listEnvironments", request, params);
    if (!input.ok) return input.response;
    const found = projectAccess(input.params.projectId ?? "", actionOf("listEnvironments"));
    if (!found.ok) return found.response;
    return HttpResponse.json({ environments: projectDetail(found.row).environments });
  }),

  http.post(mswPath("createEnvironment"), async ({ request, params }) => {
    const input = await validate("createEnvironment", request, params);
    if (!input.ok) return input.response;
    const found = projectAccess(input.params.projectId ?? "", actionOf("createEnvironment"));
    if (!found.ok) return found.response;
    const name = String(input.body.name);
    const taken = new Set(
      db.deploy.environments.filter((row) => row.project_id === found.row.id).map((r) => r.slug),
    );
    const slug = freeSlug(
      taken,
      typeof input.body.slug === "string" ? input.body.slug : slugify(name, 40, "env"),
    );
    const environment: Environment = {
      id: nextId("env"),
      project_id: found.row.id,
      name,
      slug,
      kind: input.body.kind as Environment["kind"],
      pr_number: (input.body.pr_number as number | undefined) ?? null,
      source_branch: (input.body.source_branch as string | undefined) ?? null,
      created_at: Date.now(),
    };
    db.deploy.environments.push(environment);
    recordAudit({
      workspaceId: found.row.workspace_id,
      actorType: "user",
      actorId: found.guard.user.id,
      action: "project.updated",
      targetType: "project",
      targetId: found.row.id,
      metadata: { environment_id: environment.id },
    });
    return HttpResponse.json(environment, { status: 201 });
  }),

  // ---------------------------------------------------------------------------
  // Services
  // ---------------------------------------------------------------------------
  http.get(mswPath("listServices"), async ({ request, params }) => {
    const input = await validate("listServices", request, params);
    if (!input.ok) return input.response;
    const found = projectAccess(input.params.projectId ?? "", actionOf("listServices"));
    if (!found.ok) return found.response;
    return HttpResponse.json({ services: projectDetail(found.row).services });
  }),

  http.post(mswPath("createService"), async ({ request, params }) => {
    const input = await validate("createService", request, params);
    if (!input.ok) return input.response;
    const found = projectAccess(input.params.projectId ?? "", actionOf("createService"));
    if (!found.ok) return found.response;
    const name = String(input.body.name);
    const taken = new Set(
      db.deploy.services
        .filter((row) => row.project_id === found.row.id && !row.deleted)
        .map((row) => row.slug),
    );
    const slug = freeSlug(
      taken,
      typeof input.body.slug === "string" ? input.body.slug : slugify(name, 40, "service"),
      RESERVED_SERVICE_SLUGS,
    );
    const now = Date.now();
    const service: Service = {
      id: nextId("svc"),
      project_id: found.row.id,
      name,
      slug,
      kind: input.body.kind as Service["kind"],
      icon: (input.body.icon as string | undefined) ?? null,
      created_at: now,
      updated_at: now,
    };
    db.deploy.services.push(service);
    const configs = createConfigs(
      service,
      input.body.source as ServiceConfig["source"],
      (input.body.config as Record<string, Record<string, unknown> | null>) ?? {},
      found.guard.user.id,
    );
    db.deploy.configs.push(...configs);
    for (const config of configs) ensureGeneratedDomain(service, config);
    recordAudit({
      workspaceId: found.row.workspace_id,
      actorType: "user",
      actorId: found.guard.user.id,
      action: "service.created",
      targetType: "service",
      targetId: service.id,
      metadata: { name, project_id: found.row.id },
    });
    broadcastRealtime(found.row.id, { type: "service.updated", service });
    return HttpResponse.json({ service, configs }, { status: 201 });
  }),

  http.get(mswPath("getService"), async ({ request, params }) => {
    const input = await validate("getService", request, params);
    if (!input.ok) return input.response;
    const found = serviceAccess(input.params.serviceId ?? "", actionOf("getService"));
    if (!found.ok) return found.response;
    return HttpResponse.json(stripService(found.row));
  }),

  http.patch(mswPath("updateService"), async ({ request, params }) => {
    const input = await validate("updateService", request, params);
    if (!input.ok) return input.response;
    const found = serviceAccess(input.params.serviceId ?? "", actionOf("updateService"));
    if (!found.ok) return found.response;
    const service = found.row;
    const body = input.body;
    const others = new Set(
      db.deploy.services
        .filter(
          (row) => row.project_id === service.project_id && !row.deleted && row.id !== service.id,
        )
        .map((row) => row.slug),
    );
    const requested = body.slug as string | undefined;
    // NOTE: A rename is exact, so a taken slug is a conflict; only a reserved one is
    // suffixed, as on create.
    if (requested && others.has(requested)) {
      return conflict(`A service with slug "${requested}" already exists`);
    }
    const slug = requested && freeSlug(others, requested, RESERVED_SERVICE_SLUGS);
    let config: ServiceConfig | null = null;
    const parts = [
      "source",
      "build",
      "deploy",
      "resources",
      "healthcheck",
      "networking",
      "placement",
    ] as const;
    const changes = parts.filter((part) => body[part] !== undefined);
    if (changes.length > 0) {
      const environment = environmentOf(service.project_id, body.environment_id);
      if (!environment) return notFound("Environment");
      const latest = latestConfig(service.id, environment.id);
      if (!latest) return notFound("Config");
      if (body.expected_version !== undefined && body.expected_version !== latest.version) {
        return conflict(
          `Config changed: the latest version is ${latest.version}, not ${body.expected_version}`,
        );
      }
      const next = { ...latest } as Record<string, unknown>;
      for (const part of changes) {
        const value = body[part];
        next[part] =
          part === "source" || part === "healthcheck" || value === null
            ? value
            : { ...(latest[part] as object), ...(value as object) };
      }
      // Mirrors the API's mergeConfig: cross-field rules are checked after the merge.
      if (!secretBuildArgsValid(next.build as ServiceConfig["build"])) {
        return apiError(
          400,
          "invalid_request",
          "build.secret_build_args: secret_build_args must name distinct keys of build_args",
        );
      }
      config = {
        ...(next as ServiceConfig),
        id: nextId("cfg"),
        version: latest.version + 1,
        created_by: found.guard.user.id,
        created_at: Date.now(),
      };
      db.deploy.configs.push(config);
      ensureGeneratedDomain(service, config);
    }
    if (typeof body.name === "string") service.name = body.name;
    if (slug) service.slug = slug;
    if (body.icon !== undefined) service.icon = (body.icon as string | null) ?? null;
    service.updated_at = Date.now();
    const project = liveProject(service.project_id);
    recordAudit({
      workspaceId: project?.workspace_id ?? "",
      actorType: "user",
      actorId: found.guard.user.id,
      action: "service.updated",
      targetType: "service",
      targetId: service.id,
      metadata: config ? { version: config.version, parts: changes } : { name: service.name },
    });
    broadcastRealtime(service.project_id, {
      type: "service.updated",
      service: stripService(service),
    });
    return HttpResponse.json({ service: stripService(service), config });
  }),

  http.delete(mswPath("deleteService"), async ({ request, params }) => {
    const input = await validate("deleteService", request, params);
    if (!input.ok) return input.response;
    const found = serviceAccess(input.params.serviceId ?? "", actionOf("deleteService"));
    if (!found.ok) return found.response;
    found.row.deleted = true;
    recordAudit({
      workspaceId: liveProject(found.row.project_id)?.workspace_id ?? "",
      actorType: "user",
      actorId: found.guard.user.id,
      action: "service.deleted",
      targetType: "service",
      targetId: found.row.id,
      metadata: { name: found.row.name },
    });
    broadcastRealtime(found.row.project_id, {
      type: "service.updated",
      service: stripService(found.row),
    });
    return noContent();
  }),

  http.get(mswPath("getServiceConfig"), async ({ request, params }) => {
    const input = await validate("getServiceConfig", request, params);
    if (!input.ok) return input.response;
    const found = serviceAccess(input.params.serviceId ?? "", actionOf("getServiceConfig"));
    if (!found.ok) return found.response;
    const environment = environmentOf(found.row.project_id, input.query.environment_id);
    if (!environment) return notFound("Environment");
    const version = input.query.version as number | undefined;
    const config =
      version === undefined
        ? latestConfig(found.row.id, environment.id)
        : db.deploy.configs.find(
            (row) =>
              row.service_id === found.row.id &&
              row.environment_id === environment.id &&
              row.version === version,
          );
    return config ? HttpResponse.json(config) : notFound("Config");
  }),

  // ---------------------------------------------------------------------------
  // Variables
  // ---------------------------------------------------------------------------
  ...(["service", "shared"] as const).flatMap((scope) => {
    const names =
      scope === "service"
        ? (["listServiceVariables", "putServiceVariables"] as const)
        : (["listSharedVariables", "putSharedVariables"] as const);
    const resolve = (id: string, action: Action) => {
      if (scope === "service") {
        const found = serviceAccess(id, action);
        return found.ok
          ? {
              ...found,
              projectId: found.row.project_id,
              workspaceId: liveProject(found.row.project_id)?.workspace_id ?? "",
            }
          : found;
      }
      const found = projectAccess(id, action);
      return found.ok
        ? { ...found, projectId: found.row.id, workspaceId: found.row.workspace_id }
        : found;
    };
    const ownerParam = scope === "service" ? "serviceId" : "projectId";
    return [
      http.get(mswPath(names[0]), async ({ request, params }) => {
        const input = await validate(names[0], request, params);
        if (!input.ok) return input.response;
        const ownerId = input.params[ownerParam] ?? "";
        const found = resolve(ownerId, actionOf(names[0]));
        if (!found.ok) return found.response;
        const environment = environmentOf(found.projectId, input.query.environment_id);
        if (!environment) return notFound("Environment");
        return HttpResponse.json(listVariables(scope, ownerId, environment.id));
      }),

      http.put(mswPath(names[1]), async ({ request, params }) => {
        const input = await validate(names[1], request, params);
        if (!input.ok) return input.response;
        const ownerId = input.params[ownerParam] ?? "";
        const found = resolve(ownerId, actionOf(names[1]));
        if (!found.ok) return found.response;
        const environment = environmentOf(found.projectId, input.query.environment_id);
        if (!environment) return notFound("Environment");
        const set = input.body.set as {
          key: string;
          value?: string;
          tier?: DbVariable["tier"];
          available_at_build?: boolean;
          mount_as_file?: boolean;
        }[];
        const remove = input.body.delete as string[];
        // Mirrors the API's assertValidReferences: every malformed reference, by key.
        const details = set.flatMap(({ key, value }) =>
          parseReferences(value ?? "").errors.map((e) => ({
            field: key,
            code: e.code,
            message: e.message,
            start: e.start,
            end: e.end,
          })),
        );
        const first = details[0];
        if (first) {
          return apiError(
            400,
            "invalid_reference",
            `${first.field}: ${first.message} (at ${first.start}-${first.end})`,
            details,
          );
        }
        const now = Date.now();
        for (const entry of set) {
          const existing = variablesOf(scope, ownerId, environment.id).find(
            (row) => row.key === entry.key,
          );
          if (existing) {
            existing.value = entry.value ?? existing.value;
            existing.tier = entry.tier ?? existing.tier;
            existing.available_at_build = entry.available_at_build ?? existing.available_at_build;
            existing.mount_as_file = entry.mount_as_file ?? existing.mount_as_file;
            existing.version += 1;
            existing.updated_at = now;
            existing.updated_by = found.guard.user.id;
          } else {
            db.deploy.variables.push({
              scope,
              owner_id: ownerId,
              environment_id: environment.id,
              key: entry.key,
              value: entry.value ?? "",
              tier: entry.tier ?? "plain",
              locked: false,
              available_at_build: entry.available_at_build ?? false,
              mount_as_file: entry.mount_as_file ?? false,
              version: 1,
              updated_at: now,
              updated_by: found.guard.user.id,
            });
          }
        }
        db.deploy.variables = db.deploy.variables.filter(
          (row) =>
            !(
              row.scope === scope &&
              row.owner_id === ownerId &&
              row.environment_id === environment.id &&
              remove.includes(row.key)
            ),
        );
        recordAudit({
          workspaceId: found.workspaceId,
          actorType: "user",
          actorId: found.guard.user.id,
          action: "variables.updated",
          targetType: scope === "service" ? "service" : "project",
          targetId: ownerId,
          metadata: {
            environment_id: environment.id,
            set: set.map((entry) => entry.key),
            deleted: remove,
          },
        });
        return HttpResponse.json({
          ...listVariables(scope, ownerId, environment.id),
          warnings: [],
        });
      }),
    ];
  }),

  http.get(mswPath("resolveServiceVariables"), async ({ request, params }) => {
    const input = await validate("resolveServiceVariables", request, params);
    if (!input.ok) return input.response;
    const found = serviceAccess(input.params.serviceId ?? "", actionOf("resolveServiceVariables"));
    if (!found.ok) return found.response;
    const environment = environmentOf(found.row.project_id, input.query.environment_id);
    if (!environment) return notFound("Environment");
    const result = resolveEnvironment(found.row, environment);
    if (!result.ok) {
      const details = result.errors.map((e) => ({
        field: `${e.variable.namespace}.${e.variable.name}`,
        code: e.code,
        message: e.message,
        ...(e.start !== undefined ? { start: e.start, end: e.end } : {}),
      }));
      const first = details[0];
      return apiError(400, "invalid_reference", `${first?.field}: ${first?.message}`, details);
    }
    // SECURITY: Like the API, no secret value and no value derived from one leaves here.
    const local = localKeys(found.row, environment);
    const variables = Object.fromEntries(
      Object.entries(result.env)
        .filter(([key]) => !local.includes(key))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    recordAudit({
      workspaceId: liveProject(found.row.project_id)?.workspace_id ?? "",
      actorType: "user",
      actorId: found.guard.user.id,
      action: "variables.resolved",
      targetType: "service",
      targetId: found.row.id,
      metadata: { environment_id: environment.id, keys: Object.keys(variables), local_keys: local },
    });
    return HttpResponse.json({ variables, local_keys: local });
  }),

  // ---------------------------------------------------------------------------
  // Deployments and logs
  // ---------------------------------------------------------------------------
  http.get(mswPath("listDeployments"), async ({ request, params }) => {
    const input = await validate("listDeployments", request, params);
    if (!input.ok) return input.response;
    const found = serviceAccess(input.params.serviceId ?? "", actionOf("listDeployments"));
    if (!found.ok) return found.response;
    const environment = environmentOf(found.row.project_id, input.query.environment_id);
    if (!environment) return notFound("Environment");
    const limit = input.query.limit as number;
    const all = db.deploy.deployments
      .filter((row) => row.service_id === found.row.id && row.environment_id === environment.id)
      .sort(byNewest);
    const cursor = input.query.cursor as string | undefined;
    const from = cursor ? all.findIndex((row) => row.id === cursor) + 1 : 0;
    const page = all.slice(from, from + limit);
    return HttpResponse.json({
      deployments: page.map(toDeployment),
      next_cursor: from + limit < all.length ? (page.at(-1)?.id ?? null) : null,
    });
  }),

  http.post(mswPath("createDeployment"), async ({ request, params }) => {
    const input = await validate("createDeployment", request, params);
    if (!input.ok) return input.response;
    const found = serviceAccess(input.params.serviceId ?? "", actionOf("createDeployment"));
    if (!found.ok) return found.response;
    const environment = environmentOf(found.row.project_id, input.query.environment_id);
    if (!environment) return notFound("Environment");
    const config = latestConfig(found.row.id, environment.id);
    if (!config) return conflict("This environment has no config for the service");
    if (config.deploy.replicas === 0)
      return conflict("The service has 0 replicas; scale it up to deploy");
    const row = startDeployment(
      found.row,
      environment.id,
      config,
      input.body.commit_sha as string | undefined,
      "manual",
      found.guard.user.id,
    );
    recordAudit({
      workspaceId: liveProject(found.row.project_id)?.workspace_id ?? "",
      actorType: "user",
      actorId: found.guard.user.id,
      action: "deployment.created",
      targetType: "deployment",
      targetId: row.id,
      metadata: { service_id: found.row.id, environment_id: environment.id },
    });
    announceDeployment(row);
    return HttpResponse.json(toDeployment(row), { status: 201 });
  }),

  http.get(mswPath("getDeployment"), async ({ request, params }) => {
    const input = await validate("getDeployment", request, params);
    if (!input.ok) return input.response;
    const found = deploymentAccess(input.params.deploymentId ?? "", actionOf("getDeployment"));
    if (!found.ok) return found.response;
    return HttpResponse.json(toDetail(found.row));
  }),

  http.post(mswPath("rollbackDeployment"), async ({ request, params }) => {
    const input = await validate("rollbackDeployment", request, params);
    if (!input.ok) return input.response;
    const found = deploymentAccess(input.params.deploymentId ?? "", actionOf("rollbackDeployment"));
    if (!found.ok) return found.response;
    const source = found.row;
    if (!ROLLBACK_SOURCE_STATUSES.includes(source.status)) {
      return conflict(`Can't roll back to a ${source.status} deployment`);
    }
    const service = liveService(source.service_id);
    const config = db.deploy.configs.find(
      (row) =>
        row.service_id === source.service_id &&
        row.environment_id === source.environment_id &&
        row.version === source.config_version,
    );
    if (!service || !config) return notFound("Deployment");
    const row = newDeployment(
      service,
      source.environment_id,
      config,
      {
        trigger: "rollback",
        rollback_of: source.id,
        image: source.image,
      },
      found.guard.user.id,
    );
    db.deploy.deployments.push(row);
    recordAudit({
      workspaceId: liveProject(service.project_id)?.workspace_id ?? "",
      actorType: "user",
      actorId: found.guard.user.id,
      action: "deployment.rolled_back",
      targetType: "deployment",
      targetId: row.id,
      metadata: { rollback_of: source.id, service_id: service.id },
    });
    announceDeployment(row);
    return HttpResponse.json(toDeployment(row), { status: 201 });
  }),

  http.post(mswPath("cancelDeployment"), async ({ request, params }) => {
    const input = await validate("cancelDeployment", request, params);
    if (!input.ok) return input.response;
    const found = deploymentAccess(input.params.deploymentId ?? "", actionOf("cancelDeployment"));
    if (!found.ok) return found.response;
    const row = found.row;
    if (!CANCELLABLE_DEPLOYMENT_STATUSES.includes(row.status)) {
      return conflict(`Can't cancel a ${row.status} deployment`);
    }
    const now = Date.now();
    row.status = "cancelled";
    row.finished_at = now;
    row.updated_at = now;
    const build = db.deploy.builds.find((entry) => entry.id === row.build_id);
    if (build && (build.status === "queued" || build.status === "running")) {
      build.status = "cancelled";
      build.finished_at = now;
    }
    const service = liveService(row.service_id);
    recordAudit({
      workspaceId: service ? (liveProject(service.project_id)?.workspace_id ?? "") : "",
      actorType: "user",
      actorId: found.guard.user.id,
      action: "deployment.cancelled",
      targetType: "deployment",
      targetId: row.id,
      metadata: { service_id: row.service_id },
    });
    announceDeployment(row);
    return HttpResponse.json(toDeployment(row));
  }),

  http.get(mswPath("getDeploymentLogs"), async ({ request, params }) => {
    const input = await validate("getDeploymentLogs", request, params);
    if (!input.ok) return input.response;
    const found = deploymentAccess(input.params.deploymentId ?? "", actionOf("getDeploymentLogs"));
    if (!found.ok) return found.response;
    return HttpResponse.json(logPage(`deployment:${found.row.id}`, input.query));
  }),

  http.get(mswPath("getBuildLogs"), async ({ request, params }) => {
    const input = await validate("getBuildLogs", request, params);
    if (!input.ok) return input.response;
    const build = db.deploy.builds.find((row) => row.id === input.params.buildId);
    const found = deploymentAccess(build?.deployment_id ?? "", actionOf("getBuildLogs"));
    if (!found.ok) return found.response.status === 404 ? notFound("Build") : found.response;
    return HttpResponse.json(logPage(`build:${build?.id}`, input.query));
  }),

  // ---------------------------------------------------------------------------
  // Domains
  // ---------------------------------------------------------------------------
  http.get(mswPath("listDomains"), async ({ request, params }) => {
    const input = await validate("listDomains", request, params);
    if (!input.ok) return input.response;
    const found = serviceAccess(input.params.serviceId ?? "", actionOf("listDomains"));
    if (!found.ok) return found.response;
    const environmentId = input.query.environment_id as string | undefined;
    const domains = db.deploy.domains.filter(
      (row) =>
        row.service_id === found.row.id && (!environmentId || row.environment_id === environmentId),
    );
    return HttpResponse.json({ domains });
  }),

  // ---------------------------------------------------------------------------
  // Instance settings
  // ---------------------------------------------------------------------------
  http.get(mswPath("getInstanceSettings"), () => {
    const denied = requireInstanceAdmin();
    if (denied) return denied;
    return HttpResponse.json(db.deploy.instance);
  }),

  http.patch(mswPath("updateInstanceSettings"), async ({ request, params }) => {
    const input = await validate("updateInstanceSettings", request, params);
    if (!input.ok) return input.response;
    const denied = requireInstanceAdmin();
    if (denied) return denied;
    const user = currentUser();
    if (input.body.apps_domain !== undefined)
      db.deploy.instance.apps_domain = (input.body.apps_domain as string | null) ?? null;
    if (input.body.tls_mode !== undefined)
      db.deploy.instance.tls_mode = input.body.tls_mode as typeof db.deploy.instance.tls_mode;
    if (input.body.log_retention_days !== undefined)
      db.deploy.instance.log_retention_days = input.body.log_retention_days as number;
    // NOTE: Instances have no audit log of their own; like the API, the change is recorded
    // in every workspace the caller owns.
    const owned = db.memberships.filter((row) => row.user_id === user?.id && row.role === "owner");
    for (const membership of owned) {
      recordAudit({
        workspaceId: membership.workspace_id,
        actorType: "user",
        actorId: user?.id ?? null,
        action: "instance.settings_updated",
        targetType: "instance",
        targetId: "instance",
        metadata: { ...input.body },
      });
    }
    return HttpResponse.json(db.deploy.instance);
  }),

  // ---------------------------------------------------------------------------
  // GitHub App
  // ---------------------------------------------------------------------------
  http.get(mswPath("getGithubStatus"), async ({ request, params }) => {
    const input = await validate("getGithubStatus", request, params);
    if (!input.ok) return input.response;
    const workspaceId = String(input.query.workspace_id);
    const access = requireWorkspace(workspaceId, actionOf("getGithubStatus"));
    if (!access.ok) return access.response;
    const { app, installations } = db.deploy.github;
    return HttpResponse.json({
      configured: app !== null,
      app,
      installations: installations.filter((row) => row.workspace_id === workspaceId),
    });
  }),

  http.post(mswPath("createGithubManifest"), async ({ request, params }) => {
    const input = await validate("createGithubManifest", request, params);
    if (!input.ok) return input.response;
    const denied = requireInstanceAdmin();
    if (denied) return denied;
    if (db.deploy.github.app) return conflict("This instance already has a GitHub App");
    const workspaceId = String(input.body.workspace_id);
    const state = `ghs_${randomHex(32)}`;
    db.deploy.github.states.push({
      state,
      workspace_id: workspaceId,
      expires_at: Date.now() + 10 * 60_000,
    });
    const origin = new URL(request.url).origin;
    const organization = input.body.organization as string | undefined;
    const base = organization
      ? `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new`
      : "https://github.com/settings/apps/new";
    return HttpResponse.json({
      manifest: {
        name: `Roundhouse (${new URL(origin).hostname})`,
        url: origin,
        hook_attributes: { url: `${origin}/v1/webhooks/github` },
        redirect_url: `${origin}/v1/github/callback`,
        setup_url: `${origin}/v1/github/callback`,
        public: false,
        default_permissions: { contents: "read", metadata: "read" },
        default_events: ["push"],
      },
      state,
      post_url: `${base}?state=${state}`,
    });
  }),

  http.get(mswPath("githubCallback"), async ({ request, params }) => {
    const input = await validate("githubCallback", request, params);
    if (!input.ok) return input.response;
    const user = currentUser();
    if (!user) return unauthorized();
    const {
      state,
      code,
      installation_id: installationId,
    } = input.query as {
      state: string;
      code?: string;
      installation_id?: number;
    };
    const pending = db.deploy.github.states.find(
      (row) => row.state === state && row.expires_at > Date.now(),
    );
    if (!pending) return invalid("state: unknown or expired");
    const redirect = (location: string) =>
      new HttpResponse(null, { status: 302, headers: { location } });
    const back = (params: Record<string, string>) =>
      redirect(`/settings/github?${new URLSearchParams(params)}`);
    if (installationId === undefined && code) {
      const denied = requireInstanceAdmin();
      if (denied) return denied;
      db.deploy.github.states = db.deploy.github.states.filter((row) => row !== pending);
      db.deploy.github.app = {
        id: 900_001,
        slug: "roundhouse-mock",
        name: "Roundhouse (mock)",
        html_url: "https://github.com/apps/roundhouse-mock",
        install_url: "https://github.com/apps/roundhouse-mock/installations/new",
      };
      recordAudit({
        workspaceId: pending.workspace_id,
        actorType: "user",
        actorId: user.id,
        action: "github.app_created",
        targetType: "github_app",
        targetId: "900001",
      });
      // Like the API: straight on to GitHub's install page for the new App.
      return redirect(`${db.deploy.github.app.html_url}/installations/new?state=${state}`);
    }
    if (installationId !== undefined) {
      const access = requireWorkspace(pending.workspace_id, actionOf("githubCallback"));
      if (!access.ok)
        return access.response.status === 404
          ? apiError(403, "forbidden", "Not a member of this workspace")
          : access.response;
      const setupAction = (input.query as { setup_action?: string }).setup_action;
      if (setupAction === "request") return back({ status: "requested" });
      const reject = (reason: string) => {
        recordAudit({
          workspaceId: pending.workspace_id,
          actorType: "user",
          actorId: user.id,
          action: "github.installation_rejected",
          targetType: "github_installation",
          targetId: String(installationId),
          metadata: { installation_id: installationId, reason },
        });
        return back({ error: reason });
      };
      // NOTE: Like the API, the link is spent before the OAuth code is checked. The mock's
      // stand-ins for GitHub's answers: code "denied" can't see the installation, code
      // "invalid" fails the exchange.
      if (pending.used) return reject("link_used");
      pending.used = true;
      if (!code) return reject("authorization_required");
      if (code === "invalid") return reject("authorization_failed");
      if (code === "denied") return reject("installation_not_accessible");
      db.deploy.github.installations.push({
        id: nextId("ghi"),
        installation_id: installationId,
        account_login: "new-account",
        account_type: "User",
        workspace_id: pending.workspace_id,
        created_at: Date.now(),
      });
      recordAudit({
        workspaceId: pending.workspace_id,
        actorType: "user",
        actorId: user.id,
        action: "github.installation_added",
        targetType: "github_installation",
        targetId: String(installationId),
      });
      return back({ status: "installed" });
    }
    return invalid("code or installation_id is required");
  }),

  http.get(mswPath("listGithubRepositories"), async ({ request, params }) => {
    const input = await validate("listGithubRepositories", request, params);
    if (!input.ok) return input.response;
    const workspaceId = String(input.query.workspace_id);
    const access = requireWorkspace(workspaceId, actionOf("listGithubRepositories"));
    if (!access.ok) return access.response;
    if (!db.deploy.github.app) {
      return apiError(400, "github_not_configured", "This instance has no GitHub App yet");
    }
    const installationIds = new Set(
      db.deploy.github.installations
        .filter((row) => row.workspace_id === workspaceId)
        .map((row) => row.id),
    );
    const only = input.query.installation_id as string | undefined;
    const repositories = db.deploy.github.repositories.filter(
      (repo) =>
        installationIds.has(repo.installation_id) && (!only || repo.installation_id === only),
    );
    return HttpResponse.json({ repositories });
  }),

  http.post(mswPath("githubWebhook"), async ({ request, params }) => {
    const raw = await request.clone().text();
    const input = await validate("githubWebhook", request, params);
    if (!input.ok) return input.response;
    const signature = request.headers.get("x-hub-signature-256") ?? "";
    // SECURITY: The API compares in constant time; equality is enough for a mock.
    if (signature !== `sha256=${await hmacHex(db.deploy.github.webhookSecret, raw)}`) {
      return apiError(401, "invalid_signature", "Invalid webhook signature");
    }
    if (request.headers.get("x-github-event") === "push") {
      const payload = JSON.parse(raw) as {
        ref?: string;
        after?: string;
        repository?: { clone_url?: string };
      };
      const branch = payload.ref?.replace(/^refs\/heads\//, "");
      for (const service of db.deploy.services.filter((row) => !row.deleted)) {
        for (const environment of db.deploy.environments.filter(
          (row) => row.project_id === service.project_id,
        )) {
          const config = latestConfig(service.id, environment.id);
          if (config?.source.type !== "git") continue;
          if (
            config.source.repo_url !== payload.repository?.clone_url ||
            config.source.branch !== branch
          )
            continue;
          announceDeployment(
            startDeployment(service, environment.id, config, payload.after, "push", null),
          );
        }
      }
    }
    return new HttpResponse(null, { status: 202 });
  }),

  // ---------------------------------------------------------------------------
  // Realtime (plain HTTP; upgrades are answered by `realtimeLink`)
  // ---------------------------------------------------------------------------
  http.get(mswPath("projectRealtime"), async ({ request, params }) => {
    const input = await validate("projectRealtime", request, params);
    if (!input.ok) return input.response;
    // NOTE: Identity is checked only after an upgrade, so a plain request is always 426.
    return apiError(426, "upgrade_required", "Expected a WebSocket upgrade");
  }),

  // ---------------------------------------------------------------------------
  // API tokens
  // ---------------------------------------------------------------------------
  http.get(mswPath("listApiTokens"), async ({ request, params }) => {
    const input = await validate("listApiTokens", request, params);
    if (!input.ok) return input.response;
    const workspaceId = input.params.workspaceId ?? "";
    const access = requireWorkspace(workspaceId, actionOf("listApiTokens"));
    if (!access.ok) return access.response;
    const tokens = db.deploy.tokens
      .filter((row) => row.workspace_id === workspaceId)
      .sort(byNewest)
      .map(toApiToken);
    return HttpResponse.json({ tokens });
  }),

  http.post(mswPath("createApiToken"), async ({ request, params }) => {
    const input = await validate("createApiToken", request, params);
    if (!input.ok) return input.response;
    const workspaceId = input.params.workspaceId ?? "";
    const access = requireWorkspace(workspaceId, actionOf("createApiToken"));
    if (!access.ok) return access.response;
    const scopes = input.body.scopes as ApiTokenScope[];
    const beyond = scopesBeyondRole(access.membership.role, scopes);
    if (beyond.length > 0) {
      return apiError(
        403,
        "forbidden",
        `Your role (${access.membership.role}) cannot grant ${beyond.join(", ")}`,
      );
    }
    const now = Date.now();
    const days = input.body.expires_in_days as number | null;
    const secret = tokenSecret();
    const row: DbApiToken = {
      id: nextId("tok"),
      workspace_id: workspaceId,
      name: String(input.body.name),
      scopes,
      prefix: secret.slice(0, API_TOKEN_DISPLAY_PREFIX_LENGTH),
      secret,
      created_by: { user_id: access.user.id, name: access.user.name },
      last_used_at: null,
      expires_at: days === null ? null : now + days * 24 * 60 * 60 * 1000,
      revoked_at: null,
      created_at: now,
    };
    db.deploy.tokens.push(row);
    recordAudit({
      workspaceId,
      actorType: "user",
      actorId: access.user.id,
      action: "token.created",
      targetType: "api_token",
      targetId: row.id,
      metadata: { name: row.name, scopes, expires_at: row.expires_at },
    });
    return HttpResponse.json({ token: toApiToken(row), secret }, { status: 201 });
  }),

  http.delete(mswPath("revokeApiToken"), async ({ request, params }) => {
    const input = await validate("revokeApiToken", request, params);
    if (!input.ok) return input.response;
    const workspaceId = input.params.workspaceId ?? "";
    const access = requireWorkspace(workspaceId, actionOf("revokeApiToken"));
    if (!access.ok) return access.response;
    const token = db.deploy.tokens.find(
      (row) => row.id === input.params.tokenId && row.workspace_id === workspaceId,
    );
    if (!token) return notFound("Token");
    if (token.revoked_at === null) {
      token.revoked_at = Date.now();
      recordAudit({
        workspaceId,
        actorType: "user",
        actorId: access.user.id,
        action: "token.revoked",
        targetType: "api_token",
        targetId: token.id,
        metadata: { name: token.name },
      });
    }
    return noContent();
  }),
];

/** WebSocket handlers; registered next to {@link deployHandlers}. */
export const deployWebSocketHandlers = [realtimeHandler];
