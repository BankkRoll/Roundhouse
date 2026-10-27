/**
 * Contract test: every response the MSW mocks produce must be one the real API declares.
 *
 * Two sources define the API's routes, and both are read from the API source:
 * - the mounted routers (`apps/api/src/routes/*.ts`), through their OpenAPI registries;
 * - `PHASE1_ROUTES` and `CREDENTIAL_ROUTES` in `apps/api/src/contracts.ts`, route
 *   definitions checked directly, so their mocks are held to the contract before (and
 *   regardless of whether) their API handlers are mounted.
 *
 * Both carry each route's statuses and zod response schemas, the same schemas that
 * generate `/v1/openapi.json`. Each scenario below drives a mock handler into a success
 * or error case, and every response is checked for:
 *
 * 1. a matching API route (method + path),
 * 2. a status that route declares,
 * 3. a body that passes the route's zod schema for that status.
 *
 * The test also requires a one-to-one mapping between mock handlers and API routes, and
 * that every handler was exercised. Messages the mock realtime socket sends are checked
 * against `RealtimeServerMessageSchema`. Changing a schema or a mock without the other
 * fails.
 */
import {
  API_TOKEN_PRESETS,
  JOIN_TOKEN_TTL_MS,
  REALTIME_CLOSE_CODES,
  type Role,
} from "@roundhouse/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CREDENTIAL_ROUTES, PHASE1_ROUTES } from "../../../api/src/contracts";
import { RealtimeServerMessageSchema } from "../../../api/src/schemas";
import { ACCESS_SEED } from "./access-db";
import { requireApprovalIn } from "./changes-handlers";
import { DATA_SEED } from "./data-db";
import {
  db,
  INVITE_TOKEN,
  MASTER_KEY,
  makeNode,
  PASSWORD,
  resetDb,
  seedFreshInstall,
  signInAs,
  USERS,
  WORKSPACE_ID,
} from "./db";
import { SEED } from "./deploy-db";
import { realtimeSubscriptions, sentRealtimeMessages } from "./deploy-handlers";
import { handlers } from "./handlers";
import { MOCK_BACKUP_CODES, MOCK_TOTP_CODE } from "./security-db";

// -----------------------------------------------------------------------------
// API route definitions, read from the API source
// -----------------------------------------------------------------------------

interface ZodLike {
  safeParse(value: unknown): { success: boolean; error?: { issues: unknown[] } };
}

interface RouteConfig {
  method: string;
  path: string;
  responses: Record<string, { content?: { "application/json"?: { schema: ZodLike } } }>;
}

interface ApiRoute {
  key: string;
  pattern: RegExp;
  config: RouteConfig;
}

const ROUTE_MODULES = [
  "setup",
  "workspaces",
  "invites",
  "nodes",
  "audit",
  "projects",
  "services",
  "domains",
  "variables",
  "deployments",
  "github",
  "instance",
  "realtime",
  "tokens",
  "providers",
  "templates",
  "changes",
  "metrics",
  "databases",
  "data-browser",
  "backups",
  "signing-keys",
  "instance-admin",
  "auth-security",
  "access",
] as const;

async function loadApiRoutes(): Promise<ApiRoute[]> {
  const modules = await Promise.all(
    // NOTE: A variable specifier keeps the web typecheck from following the import into
    // Worker-only code (D1 and Durable Object bindings) that it has no types for.
    ROUTE_MODULES.map(
      (name) =>
        import(/* @vite-ignore */ `@roundhouse/api-source/routes/${name}.ts`) as Promise<
          Record<string, unknown>
        >,
    ),
  );
  // NOTE: Keyed by method and path, so a Phase 1 route that later gets a mounted handler
  // (and so also appears in a router's registry) is still one route, not two.
  const routes = new Map<string, ApiRoute>();
  const add = ({ method, path, ...rest }: RouteConfig) => {
    const key = routeKey(method, path);
    routes.set(key, {
      key,
      pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`),
      config: { method, path, ...rest },
    });
  };
  for (const route of [...Object.values(PHASE1_ROUTES), ...Object.values(CREDENTIAL_ROUTES)]) {
    add(route as unknown as RouteConfig);
  }
  for (const module of modules) {
    for (const router of Object.values(module)) {
      const registry = (
        router as { openAPIRegistry?: { definitions: { type: string; route?: RouteConfig }[] } }
      ).openAPIRegistry;
      for (const definition of registry?.definitions ?? []) {
        if (definition.type === "route" && definition.route) add(definition.route);
      }
    }
  }
  return [...routes.values()];
}

/** Normalises API paths (`/v1/x/{id}`) and MSW paths (`/v1/x/:id`, origin wildcard) alike. */
function routeKey(method: string, path: string): string {
  const normalised = path
    .replace(/^\*/, "")
    .replace(/\{[^}]+\}/g, "{}")
    .replace(/:[^/]+/g, "{}");
  return `${method.toUpperCase()} ${normalised}`;
}

/** Better Auth's endpoints are not part of the OpenAPI document; see the sign-in test. */
const BETTER_AUTH_PATHS = new Set([
  "/api/auth/sign-in/email",
  "/api/auth/sign-out",
  "/api/auth/two-factor/enable",
  "/api/auth/two-factor/verify-totp",
  "/api/auth/two-factor/verify-backup-code",
  "/api/auth/two-factor/disable",
  "/api/auth/two-factor/generate-backup-codes",
]);

let apiRoutes: ApiRoute[] = [];
/** `Location` of the last response `call` received, for redirects. */
let lastLocation: string | null = null;
const exercised = new Set<string>();
/** Every response body `call` received, so a test can check none ever carried a staged value. */
const responseTexts: string[] = [];
/**
 * Values the change set scenarios stage as secrets. Deliberately unlike any real credential
 * format; no response body may ever contain them.
 */
const STAGED_VALUE = "staged-fixture-value-one";
const STAGED_VALUE_TWO = "staged-fixture-value-two";
const failures: string[] = [];

beforeAll(async () => {
  apiRoutes = await loadApiRoutes();
}, 60_000);

afterAll(() => {
  resetDb();
});

interface Call {
  status: number;
  body: unknown;
}

/**
 * Sends a request through MSW and checks the response against the API's declaration.
 * Violations are collected rather than thrown so one run reports all of them.
 */
async function call(
  method: string,
  path: string,
  body?: unknown,
  init: { headers?: Record<string, string>; rawBody?: string } = {},
): Promise<Call> {
  const url = new URL(path, window.location.origin);
  const raw = init.rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  const response = await fetch(url, {
    method,
    headers: {
      ...(raw === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
    body: raw,
    // NOTE: The GitHub callback answers 302; the redirect itself is what is checked.
    redirect: "manual",
  });
  lastLocation = response.headers.get("location");
  const text = await response.text();
  responseTexts.push(text);
  const parsed: unknown = text ? JSON.parse(text) : undefined;
  if (BETTER_AUTH_PATHS.has(url.pathname)) {
    exercised.add(`${method} ${url.pathname}`);
    return { status: response.status, body: parsed };
  }

  const route = apiRoutes.find(
    (candidate) =>
      candidate.config.method.toUpperCase() === method && candidate.pattern.test(url.pathname),
  );
  const label = `${method} ${url.pathname} → ${response.status}`;
  if (!route) {
    failures.push(`${label}: no such API route`);
    return { status: response.status, body: parsed };
  }
  exercised.add(route.key);
  const declared = route.config.responses[String(response.status)];
  if (!declared) {
    const statuses = Object.keys(route.config.responses).join(", ");
    failures.push(`${label}: status not declared by the API (declares ${statuses})`);
    return { status: response.status, body: parsed };
  }
  const schema = declared.content?.["application/json"]?.schema;
  if (schema) {
    const result = schema.safeParse(parsed);
    if (!result.success) {
      failures.push(`${label}: body fails the API schema: ${JSON.stringify(result.error?.issues)}`);
    }
  } else if (text) {
    failures.push(`${label}: API declares no body, mock sent ${text}`);
  }
  return { status: response.status, body: parsed };
}

function as(role: Role | null) {
  signInAs(role ? USERS[role].id : null);
}

const WS = `/v1/workspaces/${WORKSPACE_ID}`;
const OTHER_WS = "/v1/workspaces/ws_other";

/** Runs a scenario against a fresh database and returns the status it ends with. */
async function fresh<T>(scenario: () => Promise<T>): Promise<T> {
  resetDb();
  return scenario();
}

// -----------------------------------------------------------------------------
// Scenarios
// -----------------------------------------------------------------------------

describe("MSW mocks match the API contract", () => {
  it("setup: 400 → 503 → 403 → 409 order, then 201", async () => {
    await fresh(async () => {
      expect((await call("GET", "/v1/setup")).status).toBe(200);
      const valid = {
        master_key: MASTER_KEY,
        name: "Ada",
        email: "ada@example.org",
        password: "a-long-enough-password",
        workspace_name: "Engines",
      };
      seedFreshInstall(false);
      expect((await call("POST", "/v1/setup", { ...valid, password: "short" })).status).toBe(400);
      expect((await call("POST", "/v1/setup", { ...valid, master_key: "wrong" })).status).toBe(503);
      seedFreshInstall(true);
      expect((await call("POST", "/v1/setup", { ...valid, master_key: "wrong" })).status).toBe(403);
      const created = await call("POST", "/v1/setup", { ...valid, master_key: `  ${MASTER_KEY} ` });
      expect(created.status).toBe(201);
      expect((await call("POST", "/v1/setup", { ...valid, master_key: "wrong" })).status).toBe(403);
      expect((await call("POST", "/v1/setup", valid)).status).toBe(409);
      expect(await call("POST", "/v1/setup", { ...valid, password: "short" })).toMatchObject({
        status: 400,
        body: { error: { code: "invalid_request" } },
      });
    });
  });

  it("me and workspaces", async () => {
    await fresh(async () => {
      db.workspaces.push({ id: "ws_b", name: "Beta", slug: "beta", created_at: 1 });
      db.memberships.push({
        id: "mem_b",
        workspace_id: "ws_b",
        user_id: USERS.owner.id,
        role: "viewer",
        created_at: 1,
      });
      db.workspaces.push({ id: "ws_0", name: "Aardvark", slug: "aardvark", created_at: 1 });
      db.memberships.push({
        id: "mem_0",
        workspace_id: "ws_0",
        user_id: USERS.owner.id,
        role: "viewer",
        created_at: 1,
      });
      const me = await call("GET", "/v1/me");
      expect((me.body as { workspaces: { name: string }[] }).workspaces.map((w) => w.name)).toEqual(
        ["Aardvark", "Acme", "Beta"],
      );
      as(null);
      expect((await call("GET", "/v1/me")).status).toBe(401);

      expect((await call("POST", "/v1/workspaces", { name: "Lab" })).status).toBe(401);
      as("owner");
      expect((await call("POST", "/v1/workspaces", { name: "  " })).status).toBe(400);
      expect((await call("POST", "/v1/workspaces", { name: "Lab" })).status).toBe(201);
      expect((await call("POST", "/v1/workspaces", { name: "Lab" })).body).toMatchObject({
        slug: "lab-2",
      });
      for (const role of ["admin", "member"] as const) {
        as(role);
        expect(await call("POST", "/v1/workspaces", { name: "Lab" })).toMatchObject({
          status: 403,
          body: { error: { code: "forbidden" } },
        });
      }

      as("viewer");
      expect((await call("GET", WS)).status).toBe(200);
      expect((await call("GET", OTHER_WS)).status).toBe(404);
      expect((await call("PATCH", WS, { name: "Nope" })).status).toBe(403);
      as("owner");
      expect((await call("PATCH", WS, { name: "" })).status).toBe(400);
      expect((await call("PATCH", OTHER_WS, { name: "X" })).status).toBe(404);
      expect(await call("PATCH", WS, { name: "Acme Robotics" })).toMatchObject({
        status: 200,
        body: { name: "Acme Robotics", slug: "acme", staged_changes: true },
      });
      expect((await call("PATCH", WS, {})).status).toBe(400);
      expect((await call("PATCH", WS, { staged_changes: "yes" })).status).toBe(400);
      expect(await call("PATCH", WS, { staged_changes: false })).toMatchObject({
        status: 200,
        body: { name: "Acme Robotics", staged_changes: false },
      });
      expect(db.audit.at(-1)).toMatchObject({
        action: "workspace.settings_updated",
        metadata: { from: { staged_changes: true }, to: { staged_changes: false } },
      });
      expect(
        await call("GET", `/v1/projects/${SEED.project}/canvas?environment_id=${SEED.production}`),
      ).toMatchObject({ status: 200, body: { staging: false } });
      expect((await call("GET", WS)).body).toMatchObject({ staged_changes: false });
      as("member");
      expect((await call("PATCH", WS, { staged_changes: true })).status).toBe(403);
      as(null);
      expect((await call("GET", WS)).status).toBe(401);
      expect((await call("PATCH", WS, { name: "X" })).status).toBe(401);
    });
  });

  it("members: role changes", async () => {
    await fresh(async () => {
      expect((await call("GET", `${WS}/members`)).status).toBe(200);
      expect((await call("GET", `${OTHER_WS}/members`)).status).toBe(404);
      as("viewer");
      expect((await call("GET", `${WS}/members`)).status).toBe(403);
      as(null);
      expect((await call("GET", `${WS}/members`)).status).toBe(401);
      expect((await call("PATCH", `${WS}/members/mem_member`, { role: "admin" })).status).toBe(401);

      as("owner");
      expect((await call("PATCH", `${WS}/members/mem_member`, { role: "boss" })).status).toBe(400);
      expect((await call("PATCH", `${WS}/members/mem_nope`, { role: "admin" })).status).toBe(404);
      expect(await call("PATCH", `${WS}/members/mem_owner`, { role: "admin" })).toMatchObject({
        status: 409,
        body: { error: { code: "last_owner" } },
      });
      expect((await call("PATCH", `${WS}/members/mem_member`, { role: "admin" })).status).toBe(200);
      as("admin");
      expect((await call("PATCH", `${WS}/members/mem_viewer`, { role: "owner" })).status).toBe(403);
      expect((await call("PATCH", `${WS}/members/mem_owner`, { role: "viewer" })).status).toBe(403);
    });
  });

  it("members: removal and leaving", async () => {
    await fresh(async () => {
      as(null);
      expect((await call("DELETE", `${WS}/members/mem_viewer`)).status).toBe(401);
      as("member");
      expect((await call("DELETE", `${WS}/members/mem_viewer`)).status).toBe(403);
      as("viewer");
      expect((await call("DELETE", `${WS}/members/mem_viewer`)).status).toBe(204);
      expect(db.audit.at(-1)).toMatchObject({ action: "member.left" });
      as("admin");
      expect((await call("DELETE", `${WS}/members/mem_owner`)).status).toBe(403);
      expect((await call("DELETE", `${WS}/members/mem_gone`)).status).toBe(404);
      expect((await call("DELETE", `${OTHER_WS}/members/mem_owner`)).status).toBe(404);
      expect((await call("DELETE", `${WS}/members/mem_member`)).status).toBe(204);
      expect(db.audit.at(-1)).toMatchObject({ action: "member.removed" });
      as("owner");
      expect(await call("DELETE", `${WS}/members/mem_owner`)).toMatchObject({
        status: 409,
        body: { error: { code: "last_owner" } },
      });
    });
  });

  it("invites: management", async () => {
    await fresh(async () => {
      const now = Date.now();
      const seeded = db.invites[0];
      if (!seeded) throw new Error("seed changed");
      db.invites.push(
        { ...seeded, id: "inv_used", token: "inv_used", accepted_at: now },
        { ...seeded, id: "inv_old", token: "inv_old", expires_at: now - 1 },
      );
      const list = await call("GET", `${WS}/invites`);
      expect((list.body as { invites: { id: string }[] }).invites.map((i) => i.id)).toEqual([
        "inv_1",
      ]);
      expect((await call("GET", `${OTHER_WS}/invites`)).status).toBe(404);
      as("member");
      expect((await call("GET", `${WS}/invites`)).status).toBe(403);
      expect(
        (await call("POST", `${WS}/invites`, { email: "x@y.io", role: "viewer" })).status,
      ).toBe(403);
      expect((await call("DELETE", `${WS}/invites/inv_1`)).status).toBe(403);
      as(null);
      expect((await call("GET", `${WS}/invites`)).status).toBe(401);
      expect(
        (await call("POST", `${WS}/invites`, { email: "x@y.io", role: "viewer" })).status,
      ).toBe(401);
      expect((await call("DELETE", `${WS}/invites/inv_1`)).status).toBe(401);

      as("admin");
      expect((await call("POST", `${WS}/invites`, { email: "nope", role: "viewer" })).status).toBe(
        400,
      );
      expect((await call("POST", `${WS}/invites`, { email: "x@y.io", role: "owner" })).status).toBe(
        403,
      );
      expect(
        (await call("POST", `${OTHER_WS}/invites`, { email: "x@y.io", role: "viewer" })).status,
      ).toBe(404);
      expect(
        await call("POST", `${WS}/invites`, { email: "CARA@example.com", role: "viewer" }),
      ).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
      expect(
        await call("POST", `${WS}/invites`, { email: "Frank@Example.com", role: "viewer" }),
      ).toMatchObject({ status: 201, body: { invite: { email: "frank@example.com" } } });
      expect((await call("DELETE", `${WS}/invites/inv_used`)).status).toBe(404);
      expect((await call("DELETE", `${WS}/invites/inv_1`)).status).toBe(204);
    });
  });

  it("invites: preview and accept, with the token in the body", async () => {
    const lookup = (token: string) => call("POST", "/v1/invites/lookup", { token });
    const accept = (token: string, body: Record<string, unknown> = {}) =>
      call("POST", "/v1/invites/accept", { token, ...body });
    await fresh(async () => {
      as(null);
      expect((await lookup(INVITE_TOKEN)).status).toBe(200);
      expect((await lookup("inv_nope")).status).toBe(404);
      expect((await call("POST", "/v1/invites/lookup", {})).status).toBe(400);
      expect((await accept(INVITE_TOKEN, { name: "Erin" })).status).toBe(400);
      expect((await accept("inv_nope", { name: "E", password: "x".repeat(12) })).status).toBe(404);
      as("viewer");
      expect(await accept(INVITE_TOKEN)).toMatchObject({
        status: 403,
        body: { error: { code: "email_mismatch" } },
      });
      as(null);
      const seeded = db.invites[0];
      if (seeded) seeded.email = USERS.member.email;
      expect(
        await accept(INVITE_TOKEN, { name: "Cara", password: "a-long-enough-password" }),
      ).toMatchObject({ status: 409, body: { error: { code: "account_exists" } } });
      if (seeded) seeded.email = "erin@example.com";
      expect(
        (await accept(INVITE_TOKEN, { name: "Erin", password: "a-long-enough-password" })).status,
      ).toBe(200);
      expect(db.invites[0]?.accepted_at).toEqual(expect.any(Number));
      expect((await lookup(INVITE_TOKEN)).status).toBe(404);
      expect((await accept(INVITE_TOKEN)).status).toBe(404);
    });

    await fresh(async () => {
      const seeded = db.invites[0];
      if (seeded) seeded.expires_at = Date.now() - 1;
      expect((await lookup(INVITE_TOKEN)).status).toBe(404);
      if (seeded) {
        seeded.expires_at = Date.now() + 60_000;
        seeded.email = USERS.viewer.email;
      }
      db.memberships = db.memberships.filter((row) => row.user_id !== USERS.viewer.id);
      as("viewer");
      expect((await accept(INVITE_TOKEN)).status).toBe(200);
    });
  });

  it("nodes", async () => {
    await fresh(async () => {
      db.nodes.push({
        ...makeNode({ id: "node_stale", name: "ams-1", last_heartbeat_at: Date.now() - 60_000 }),
        workspace_id: WORKSPACE_ID,
      });
      const list = await call("GET", `${WS}/nodes`);
      const nodes = (list.body as { nodes: { name: string; status: string; provider: string }[] })
        .nodes;
      expect(nodes.map((node) => node.name)).toEqual(["ams-1", "fsn-1", "hel-1"]);
      expect(nodes[0]?.status).toBe("offline");
      expect(nodes[1]?.provider).toBe("server");
      expect((await call("GET", `${OTHER_WS}/nodes`)).status).toBe(404);
      expect((await call("GET", `${WS}/nodes/node_hel1`)).status).toBe(200);
      expect((await call("GET", `${WS}/nodes/node_nope`)).status).toBe(404);

      const before = Date.now();
      const token = await call("POST", `${WS}/nodes/join-tokens`);
      expect(token.status).toBe(201);
      const { expires_at, install_command } = token.body as JoinTokenBody;
      expect(expires_at - before).toBeGreaterThanOrEqual(JOIN_TOKEN_TTL_MS - 1000);
      expect(expires_at - before).toBeLessThanOrEqual(JOIN_TOKEN_TTL_MS + 1000);
      expect(install_command).toMatch(/\| sudo bash -s -- --token njt_/);
      expect((await call("POST", `${OTHER_WS}/nodes/join-tokens`)).status).toBe(404);

      as("member");
      expect((await call("POST", `${WS}/nodes/join-tokens`)).status).toBe(403);
      expect((await call("DELETE", `${WS}/nodes/node_hel1`)).status).toBe(403);
      as(null);
      expect((await call("GET", `${WS}/nodes`)).status).toBe(401);
      expect((await call("GET", `${WS}/nodes/node_hel1`)).status).toBe(401);
      expect((await call("POST", `${WS}/nodes/join-tokens`)).status).toBe(401);
      expect((await call("DELETE", `${WS}/nodes/node_hel1`)).status).toBe(401);
      as("admin");
      expect((await call("DELETE", `${WS}/nodes/node_nope`)).status).toBe(404);
      expect((await call("DELETE", `${WS}/nodes/node_hel1`)).status).toBe(204);
    });
  });

  it("metrics: service series, project summary, node series", async () => {
    await fresh(async () => {
      const env = `environment_id=${SEED.production}`;
      const service = await call("GET", `/v1/services/${SEED.web}/metrics?${env}&group=replica`);
      expect(service.status).toBe(200);
      expect((service.body as { step_s: number }).step_s).toBeGreaterThan(0);
      expect((await call("GET", `/v1/services/${SEED.web}/metrics`)).status).toBe(400);
      expect((await call("GET", `/v1/services/svc_nope/metrics?${env}`)).status).toBe(404);

      const summary = await call("GET", `/v1/projects/${SEED.project}/metrics/summary?${env}`);
      expect(summary).toMatchObject({ status: 200, body: { environment_id: SEED.production } });

      expect((await call("GET", `${WS}/nodes/node_hel1/metrics`)).status).toBe(200);
      expect((await call("GET", `${WS}/nodes/node_nope/metrics`)).status).toBe(404);

      as(null);
      expect((await call("GET", `/v1/services/${SEED.web}/metrics?${env}`)).status).toBe(401);
    });
  });

  it("audit log", async () => {
    await fresh(async () => {
      db.audit = Array.from({ length: 5 }, (_, i) => ({
        ...db.audit[0]!,
        id: `aud_${i}`,
        created_at: Date.now() - i * 1000,
      }));
      const first = await call("GET", `${WS}/audit-logs?limit=2`);
      const page = first.body as { items: { id: string }[]; next_cursor: string | null };
      expect(page.items.map((item) => item.id)).toEqual(["aud_4", "aud_3"]);
      expect(page.next_cursor).toBe("aud_3");
      const last = await call("GET", `${WS}/audit-logs?limit=200&cursor=aud_1`);
      expect(last.body).toMatchObject({ items: [{ id: "aud_0" }], next_cursor: null });
      expect((await call("GET", `${WS}/audit-logs?limit=201`)).status).toBe(400);
      expect((await call("GET", `${WS}/audit-logs?limit=0`)).status).toBe(400);
      expect((await call("GET", `${OTHER_WS}/audit-logs`)).status).toBe(404);
      as("member");
      expect((await call("GET", `${WS}/audit-logs`)).status).toBe(403);
      as(null);
      expect((await call("GET", `${WS}/audit-logs`)).status).toBe(401);
    });
  });

  it("records the node itself as the actor of node.joined", async () => {
    await fresh(async () => {
      const page = await call("GET", `${WS}/audit-logs`);
      const joined = (page.body as { items: Record<string, unknown>[] }).items.find(
        (item) => item.action === "node.joined",
      );
      expect(joined).toMatchObject({
        actor_type: "node",
        actor_id: "node_hel1",
        actor_name: "hel-1",
      });
    });
  });

  it("answers Better Auth sign-in in Better Auth's own shapes", async () => {
    await fresh(async () => {
      as(null);
      const wrong = await call("POST", "/api/auth/sign-in/email", {
        email: USERS.owner.email,
        password: "nope",
      });
      expect(wrong).toEqual({
        status: 401,
        body: { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
      });
      const ok = await call("POST", "/api/auth/sign-in/email", {
        email: USERS.owner.email.toUpperCase(),
        password: "correct-horse-battery",
      });
      expect(ok).toMatchObject({ status: 200, body: { user: { id: USERS.owner.id } } });
      expect(await call("POST", "/api/auth/sign-out", {})).toEqual({
        status: 200,
        body: { success: true },
      });
    });
  });

  it("account security: status, enrollment, second-factor sign-in, sessions, admin tools", async () => {
    await fresh(async () => {
      as(null);
      expect((await call("GET", "/v1/auth/security")).status).toBe(401);
      expect((await call("POST", "/v1/auth/reauth", {})).status).toBe(400);
      as("owner");
      expect(await call("GET", "/v1/auth/security")).toMatchObject({
        status: 200,
        body: {
          two_factor_enabled: false,
          two_factor_required: true,
          backup_codes_remaining: null,
        },
      });
      expect((await call("POST", "/api/auth/two-factor/enable", { password: "x" })).status).toBe(
        400,
      );
      const enrollment = await call("POST", "/api/auth/two-factor/enable", { password: PASSWORD });
      expect((enrollment.body as { backupCodes: string[] }).backupCodes).toHaveLength(10);
      expect(
        (await call("POST", "/api/auth/two-factor/verify-totp", { code: "000000" })).status,
      ).toBe(401);
      expect(
        (await call("POST", "/api/auth/two-factor/verify-totp", { code: MOCK_TOTP_CODE })).status,
      ).toBe(200);
      expect(await call("GET", "/v1/auth/security")).toMatchObject({
        body: { two_factor_enabled: true, backup_codes_remaining: 10 },
      });

      expect((await call("POST", "/v1/auth/reauth", { password: PASSWORD })).status).toBe(400);
      expect(
        (await call("POST", "/v1/auth/reauth", { password: "nope", code: MOCK_TOTP_CODE })).status,
      ).toBe(400);
      expect(
        (await call("POST", "/v1/auth/reauth", { password: PASSWORD, code: MOCK_TOTP_CODE }))
          .status,
      ).toBe(200);

      expect(await call("POST", "/api/auth/sign-out", {})).toMatchObject({ status: 200 });
      const challenge = await call("POST", "/api/auth/sign-in/email", {
        email: USERS.owner.email,
        password: PASSWORD,
      });
      expect(challenge).toEqual({
        status: 200,
        body: { twoFactorRedirect: true, twoFactorMethods: ["totp"] },
      });
      expect(
        (await call("POST", "/api/auth/two-factor/verify-backup-code", { code: "wrong" })).status,
      ).toBe(401);
      expect(
        (
          await call("POST", "/api/auth/two-factor/verify-backup-code", {
            code: MOCK_BACKUP_CODES[0],
          })
        ).status,
      ).toBe(200);

      const sessions = await call("GET", "/v1/auth/sessions");
      const list = (sessions.body as { sessions: { id: string; current: boolean }[] }).sessions;
      expect(list.filter((s) => s.current)).toHaveLength(1);
      expect((await call("DELETE", "/v1/auth/sessions/ses_nope")).status).toBe(404);
      expect((await call("DELETE", "/v1/auth/sessions/ses_laptop")).status).toBe(204);
      expect(await call("DELETE", "/v1/auth/sessions")).toEqual({
        status: 200,
        body: { revoked: 0 },
      });

      expect(
        (await call("POST", "/api/auth/two-factor/generate-backup-codes", { password: PASSWORD }))
          .status,
      ).toBe(400);
      const regenerated = await call("POST", "/api/auth/two-factor/generate-backup-codes", {
        password: PASSWORD,
        code: MOCK_TOTP_CODE,
      });
      expect((regenerated.body as { backupCodes: string[] }).backupCodes).toHaveLength(10);

      expect(
        (await call("POST", "/v1/instance/sign-in-lockouts/clear", { email: "x" })).status,
      ).toBe(400);
      db.security.locked["cara@example.com"] = Date.now() + 60_000;
      expect(
        await call("POST", "/v1/instance/sign-in-lockouts/clear", { email: "Cara@example.com" }),
      ).toEqual({ status: 200, body: { cleared: true } });
      expect((await call("DELETE", `/v1/instance/users/${USERS.owner.id}/two-factor`)).status).toBe(
        403,
      );
      expect((await call("DELETE", "/v1/instance/users/usr_nobody/two-factor")).status).toBe(404);
      expect((await call("DELETE", `/v1/instance/users/${USERS.admin.id}/two-factor`)).status).toBe(
        204,
      );

      expect(
        (await call("POST", "/api/auth/two-factor/disable", { password: PASSWORD })).status,
      ).toBe(400);
      expect(
        (
          await call("POST", "/api/auth/two-factor/disable", {
            password: PASSWORD,
            code: MOCK_TOTP_CODE,
          })
        ).status,
      ).toBe(200);

      as("member");
      expect(
        (await call("POST", "/v1/instance/sign-in-lockouts/clear", { email: "a@example.com" }))
          .status,
      ).toBe(403);
      expect((await call("DELETE", `/v1/instance/users/${USERS.admin.id}/two-factor`)).status).toBe(
        403,
      );
      db.security.locked["dan@example.com"] = Date.now() + 60_000;
      as(null);
      const locked = await call("POST", "/api/auth/sign-in/email", {
        email: USERS.viewer.email,
        password: PASSWORD,
      });
      expect(locked).toMatchObject({ status: 429, body: { code: "account_locked" } });
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 1: checked against PHASE1_ROUTES whether or not handlers are mounted
  // ---------------------------------------------------------------------------

  it("projects: list, create, read, rename, delete", async () => {
    await fresh(async () => {
      const list = await call("GET", `${WS}/projects`);
      expect((list.body as { projects: { name: string }[] }).projects.map((p) => p.name)).toEqual([
        "internal-tools",
        "storefront",
      ]);
      expect((await call("GET", `${OTHER_WS}/projects`)).status).toBe(404);
      expect((await call("POST", `${WS}/projects`, { name: "" })).status).toBe(400);
      expect(
        await call("POST", `${WS}/projects`, { name: "Shop", slug: "Not A Slug" }),
      ).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
      const created = await call("POST", `${WS}/projects`, {
        name: "Data Lake",
        description: "ETL",
      });
      expect(created).toMatchObject({
        status: 201,
        body: { slug: "data-lake", environments: [{ kind: "production" }], services: [] },
      });
      expect(await call("POST", `${WS}/projects`, { name: "data lake" })).toMatchObject({
        status: 201,
        body: { slug: "data-lake-2" },
      });
      expect(
        await call("POST", `${WS}/projects`, { name: "Lake 3", slug: "data-lake" }),
      ).toMatchObject({ status: 201, body: { slug: "data-lake-3" } });
      expect(await call("POST", `${WS}/projects`, { name: "!!!" })).toMatchObject({
        status: 201,
        body: { slug: "project" },
      });
      expect(await call("GET", `${WS}/projects?slug=data-lake-2`)).toMatchObject({
        status: 200,
        body: { projects: [{ name: "data lake", slug: "data-lake-2" }] },
      });
      expect(await call("GET", `${WS}/projects?slug=nope`)).toMatchObject({
        body: { projects: [] },
      });
      const id = (created.body as { id: string }).id;
      expect((await call("GET", `/v1/projects/${id}`)).status).toBe(200);
      expect((await call("GET", "/v1/projects/prj_nope")).status).toBe(404);
      expect((await call("PATCH", `/v1/projects/${id}`, {})).status).toBe(400);
      expect((await call("PATCH", `/v1/projects/${id}`, { slug: "storefront" })).status).toBe(409);
      expect(
        await call("PATCH", `/v1/projects/${id}`, { name: "Lake", description: null }),
      ).toMatchObject({ status: 200, body: { name: "Lake", description: null } });

      as("member");
      expect((await call("GET", `/v1/projects/${id}`)).status).toBe(200);
      expect((await call("POST", `${WS}/projects`, { name: "X" })).status).toBe(403);
      expect((await call("PATCH", `/v1/projects/${id}`, { name: "Y" })).status).toBe(403);
      expect((await call("DELETE", `/v1/projects/${id}`)).status).toBe(403);
      as(null);
      expect((await call("GET", `${WS}/projects`)).status).toBe(401);
      expect((await call("POST", `${WS}/projects`, { name: "X" })).status).toBe(401);
      expect((await call("GET", `/v1/projects/${id}`)).status).toBe(401);
      expect((await call("PATCH", `/v1/projects/${id}`, { name: "Y" })).status).toBe(401);
      expect((await call("DELETE", `/v1/projects/${id}`)).status).toBe(401);
      as("viewer");
      expect((await call("GET", `${WS}/projects`)).status).toBe(200);
      as("admin");
      expect((await call("DELETE", "/v1/projects/prj_nope")).status).toBe(404);
      expect((await call("DELETE", `/v1/projects/${id}`)).status).toBe(204);
      expect((await call("GET", `/v1/projects/${id}`)).status).toBe(404);
      expect(db.audit.at(-1)).toMatchObject({ action: "project.deleted" });
    });
  });

  it("environments", async () => {
    await fresh(async () => {
      const P = `/v1/projects/${SEED.project}`;
      expect(await call("GET", `${P}/environments`)).toMatchObject({
        status: 200,
        body: { environments: [{ kind: "production" }] },
      });
      expect((await call("GET", "/v1/projects/prj_nope/environments")).status).toBe(404);
      expect(
        (await call("POST", `${P}/environments`, { name: "Prod 2", kind: "production" })).status,
      ).toBe(400);
      expect(
        (await call("POST", `${P}/environments`, { name: "Staging", kind: "staging" })).status,
      ).toBe(201);
      expect(
        await call("POST", `${P}/environments`, { name: "staging", kind: "staging" }),
      ).toMatchObject({ status: 201, body: { slug: "staging-2" } });
      as("member");
      expect(
        (await call("POST", `${P}/environments`, { name: "QA", kind: "staging" })).status,
      ).toBe(403);
      as(null);
      expect((await call("GET", `${P}/environments`)).status).toBe(401);
      expect(
        (await call("POST", `${P}/environments`, { name: "QA", kind: "staging" })).status,
      ).toBe(401);
    });
  });

  it("services: create from both sources, read, update config versions, delete", async () => {
    await fresh(async () => {
      const P = `/v1/projects/${SEED.project}`;
      expect((await call("GET", `${P}/services`)).status).toBe(200);
      expect((await call("GET", "/v1/projects/prj_nope/services")).status).toBe(404);
      expect(
        (
          await call("POST", `${P}/services`, {
            name: "x",
            source: { type: "image", image: "Not Valid!" },
          })
        ).status,
      ).toBe(400);
      expect(
        await call("POST", `${P}/services`, {
          name: "shared",
          source: { type: "image", image: "nginx" },
        }),
      ).toMatchObject({ status: 201, body: { service: { slug: "shared-2" } } });
      expect(
        await call("POST", `${P}/services`, {
          name: "Reserved",
          slug: "shared",
          source: { type: "image", image: "nginx" },
        }),
      ).toMatchObject({ status: 201, body: { service: { slug: "shared-3" } } });
      const image = await call("POST", `${P}/services`, {
        name: "Cache",
        source: { type: "image", image: "redis:7" },
        config: { networking: { port: 6379, generated_domain: false } },
      });
      expect(image).toMatchObject({
        status: 201,
        body: { service: { slug: "cache" }, configs: [{ version: 1, networking: { port: 6379 } }] },
      });
      const git = await call("POST", `${P}/services`, {
        name: "docs",
        source: {
          type: "git",
          repo_url: "https://github.com/acme/docs.git",
          branch: "main",
          root_dir: ".",
        },
        config: { networking: { port: 8080, generated_domain: true } },
      });
      expect(git.status).toBe(201);
      expect(
        await call("POST", `${P}/services`, {
          name: "Cache",
          source: { type: "image", image: "redis" },
        }),
      ).toMatchObject({ status: 201, body: { service: { slug: "cache-2" } } });
      const id = (image.body as { service: { id: string } }).service.id;
      expect((await call("GET", `/v1/services/${id}`)).status).toBe(200);
      expect((await call("GET", "/v1/services/svc_nope")).status).toBe(404);

      const S = `/v1/services/${SEED.web}`;
      const env = `environment_id=${SEED.production}`;
      expect((await call("GET", `${S}/config`)).status).toBe(400);
      expect(await call("GET", `${S}/config?${env}`)).toMatchObject({
        status: 200,
        body: { version: 3 },
      });
      expect(await call("GET", `${S}/config?${env}&version=1`)).toMatchObject({
        body: { version: 1 },
      });
      expect((await call("GET", `${S}/config?${env}&version=99`)).status).toBe(404);
      expect((await call("GET", `${S}/config?environment_id=env_nope`)).status).toBe(404);

      expect((await call("PATCH", S, { deploy: { replicas: 3 } })).status).toBe(400);
      expect(
        (await call("PATCH", S, { environment_id: SEED.production, deploy: { replicas: 99 } }))
          .status,
      ).toBe(400);
      expect(
        await call("PATCH", S, {
          environment_id: SEED.production,
          healthcheck: { type: "http", interval_s: 5, timeout_s: 2, retries: 3, start_period_s: 0 },
        }),
      ).toMatchObject({
        status: 400,
        body: { error: { message: expect.stringMatching(/^healthcheck\.path/) } },
      });
      expect(
        await call("PATCH", S, {
          environment_id: SEED.production,
          expected_version: 2,
          deploy: { replicas: 3 },
        }),
      ).toMatchObject({ status: 409, body: { error: { code: "conflict" } } });
      expect(
        await call("PATCH", S, {
          environment_id: SEED.production,
          expected_version: 3,
          deploy: { replicas: 3 },
        }),
      ).toMatchObject({
        status: 200,
        body: { config: { version: 4, deploy: { replicas: 3, drain_s: 10 } } },
      });
      expect(await call("PATCH", S, { name: "storefront-web" })).toMatchObject({
        status: 200,
        body: { service: { name: "storefront-web" }, config: null },
      });
      expect((await call("PATCH", S, { slug: "api" })).status).toBe(409);
      expect(await call("PATCH", S, { slug: "shared" })).toMatchObject({
        status: 200,
        body: { service: { slug: "shared-4" } },
      });
      expect(await call("PATCH", S, { slug: "web" })).toMatchObject({
        status: 200,
        body: { service: { slug: "web" } },
      });
      expect((await call("PATCH", "/v1/services/svc_nope", { name: "x" })).status).toBe(404);

      as("viewer");
      expect((await call("GET", S)).status).toBe(200);
      expect((await call("GET", `${S}/config?${env}`)).status).toBe(200);
      expect((await call("PATCH", S, { name: "nope" })).status).toBe(403);
      expect((await call("DELETE", S)).status).toBe(403);
      expect(
        (
          await call("POST", `${P}/services`, {
            name: "v",
            source: { type: "image", image: "nginx" },
          })
        ).status,
      ).toBe(403);
      as(null);
      expect((await call("GET", `${P}/services`)).status).toBe(401);
      expect((await call("GET", S)).status).toBe(401);
      expect((await call("GET", `${S}/config?${env}`)).status).toBe(401);
      expect((await call("PATCH", S, { name: "x" })).status).toBe(401);
      expect((await call("DELETE", S)).status).toBe(401);
      expect(
        (
          await call("POST", `${P}/services`, {
            name: "v",
            source: { type: "image", image: "nginx" },
          })
        ).status,
      ).toBe(401);
      as("member");
      expect((await call("DELETE", "/v1/services/svc_nope")).status).toBe(404);
      expect((await call("DELETE", `/v1/services/${id}`)).status).toBe(204);
      expect((await call("GET", `/v1/services/${id}`)).status).toBe(404);
    });
  });

  it.each([
    ["service", `/v1/services/${SEED.web}/variables`],
    ["shared", `/v1/projects/${SEED.project}/variables`],
  ])("%s variables: masked list, put with reference checks, secrets write-only", async (_, V) => {
    await fresh(async () => {
      const env = `?environment_id=${SEED.production}`;
      expect((await call("GET", V)).status).toBe(400);
      expect((await call("GET", `${V}?environment_id=env_nope`)).status).toBe(404);
      const list = await call("GET", `${V}${env}`);
      expect(list.status).toBe(200);
      const variables = (list.body as { variables: { tier: string; value: string | null }[] })
        .variables;
      expect(variables.filter((v) => v.tier === "secret").every((v) => v.value === null)).toBe(
        true,
      );

      expect((await call("PUT", `${V}${env}`, { set: [{ key: "1BAD", value: "x" }] })).status).toBe(
        400,
      );
      expect(
        (await call("PUT", `${V}${env}`, { set: [{ key: "A", value: "x" }], delete: ["A"] }))
          .status,
      ).toBe(400);
      expect(
        await call("PUT", `${V}${env}`, {
          set: [
            { key: "OK", value: "1" },
            { key: "B", value: "${{ bad ref" },
          ],
        }),
      ).toMatchObject({
        status: 400,
        body: {
          error: {
            code: "invalid_reference",
            message: expect.stringMatching(/^B: .*\(at 0-11\)$/),
            details: [{ field: "B", code: "unclosed_reference", start: 0, end: 11 }],
          },
        },
      });
      const put = await call("PUT", `${V}${env}`, {
        set: [
          { key: "TOKEN", value: "t0p", tier: "secret" },
          { key: "PLAIN", value: `\${{shared.REGION}}` },
        ],
        delete: ["NODE_ENV"],
        confirm_write_only: true,
      });
      expect(put.status).toBe(200);
      expect(
        (put.body as { variables: { key: string; value: string | null }[] }).variables,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "TOKEN", value: null, tier: "secret" }),
          expect.objectContaining({ key: "PLAIN", value: `\${{shared.REGION}}` }),
        ]),
      );
      // ADR 0014: secrets are write-only; there is no reveal route to call.
      expect(JSON.stringify(db.audit.at(-1))).not.toContain("t0p");

      as("member");
      expect((await call("PUT", `${V}${env}`, { set: [{ key: "M", value: "1" }] })).status).toBe(
        200,
      );
      as("viewer");
      expect((await call("GET", `${V}${env}`)).status).toBe(200);
      expect((await call("PUT", `${V}${env}`, { set: [] })).status).toBe(403);
      as(null);
      expect((await call("GET", `${V}${env}`)).status).toBe(401);
      expect((await call("PUT", `${V}${env}`, { set: [] })).status).toBe(401);
    });
  });

  it("deployments: page, deploy, detail, rollback, cancel", async () => {
    await fresh(async () => {
      const S = `/v1/services/${SEED.web}`;
      const env = `environment_id=${SEED.production}`;
      expect((await call("GET", `${S}/deployments`)).status).toBe(400);
      expect((await call("GET", `${S}/deployments?${env}&limit=101`)).status).toBe(400);
      const first = await call("GET", `${S}/deployments?${env}&limit=2`);
      const page = first.body as { deployments: { id: string }[]; next_cursor: string | null };
      expect(page.deployments.map((d) => d.id)).toEqual([SEED.webActive, SEED.webFailed]);
      expect(page.next_cursor).toBe(SEED.webFailed);
      expect(await call("GET", `${S}/deployments?${env}&cursor=${SEED.webFailed}`)).toMatchObject({
        body: { deployments: [{ id: SEED.webOld }, { id: SEED.webFirst }], next_cursor: null },
      });

      expect((await call("POST", `${S}/deployments?${env}`, { commit_sha: "abc" })).status).toBe(
        400,
      );
      const created = await call("POST", `${S}/deployments?${env}`, {});
      expect(created).toMatchObject({
        status: 201,
        body: { status: "queued", trigger: "manual", build: { status: "queued" } },
      });
      const image = await call("POST", `/v1/services/${SEED.api}/deployments?${env}`, {});
      expect(image).toMatchObject({
        status: 201,
        body: { build: null, image: "ghcr.io/acme/api:1.4.2" },
      });
      await call("PATCH", `/v1/services/${SEED.api}`, {
        environment_id: SEED.production,
        deploy: { replicas: 0 },
      });
      expect((await call("POST", `/v1/services/${SEED.api}/deployments?${env}`, {})).status).toBe(
        409,
      );

      expect(await call("GET", `/v1/deployments/${SEED.webActive}`)).toMatchObject({
        status: 200,
        body: { events: expect.any(Array), placements: [{ replica: 0 }, { replica: 1 }] },
      });
      expect((await call("GET", "/v1/deployments/dep_nope")).status).toBe(404);

      expect((await call("POST", `/v1/deployments/${SEED.webFailed}/rollback`)).status).toBe(409);
      expect(await call("POST", `/v1/deployments/${SEED.webOld}/rollback`)).toMatchObject({
        status: 201,
        body: { trigger: "rollback", rollback_of: SEED.webOld, build_id: null },
      });
      const createdId = (created.body as { id: string }).id;
      expect(await call("POST", `/v1/deployments/${createdId}/cancel`)).toMatchObject({
        status: 200,
        body: { status: "cancelled" },
      });
      expect((await call("POST", `/v1/deployments/${createdId}/cancel`)).status).toBe(409);
      expect((await call("POST", "/v1/deployments/dep_nope/cancel")).status).toBe(404);
      expect((await call("POST", "/v1/deployments/dep_nope/rollback")).status).toBe(404);

      as("viewer");
      expect((await call("GET", `${S}/deployments?${env}`)).status).toBe(200);
      expect((await call("POST", `${S}/deployments?${env}`, {})).status).toBe(403);
      expect((await call("POST", `/v1/deployments/${SEED.webOld}/rollback`)).status).toBe(403);
      expect((await call("POST", `/v1/deployments/${SEED.workerDeploying}/cancel`)).status).toBe(
        403,
      );
      as(null);
      expect((await call("GET", `${S}/deployments?${env}`)).status).toBe(401);
      expect((await call("POST", `${S}/deployments?${env}`, {})).status).toBe(401);
      expect((await call("GET", `/v1/deployments/${SEED.webActive}`)).status).toBe(401);
      expect((await call("POST", `/v1/deployments/${SEED.webOld}/rollback`)).status).toBe(401);
      expect((await call("POST", `/v1/deployments/${SEED.workerDeploying}/cancel`)).status).toBe(
        401,
      );
    });
  });

  it("logs: newest page first, chronological, with a cursor to older lines", async () => {
    await fresh(async () => {
      const D = `/v1/deployments/${SEED.webActive}/logs`;
      expect((await call("GET", `${D}?limit=0`)).status).toBe(400);
      expect((await call("GET", `${D}?limit=1001`)).status).toBe(400);
      const newest = await call("GET", `${D}?limit=100`);
      const page = newest.body as { lines: { ts: number }[]; next_cursor: string | null };
      expect(page.lines).toHaveLength(100);
      expect(page.lines[0]!.ts).toBeLessThan(page.lines[99]!.ts);
      const older = await call("GET", `${D}?limit=1000&cursor=${page.next_cursor}`);
      const olderPage = older.body as { lines: { ts: number }[]; next_cursor: string | null };
      expect(olderPage.lines).toHaveLength(350);
      expect(olderPage.lines.at(-1)!.ts).toBeLessThan(page.lines[0]!.ts);
      expect(olderPage.next_cursor).toBeNull();
      expect((await call("GET", "/v1/deployments/dep_nope/logs")).status).toBe(404);

      const B = `/v1/builds/${SEED.webBuild}/logs`;
      expect(await call("GET", B)).toMatchObject({ status: 200, body: { next_cursor: null } });
      expect((await call("GET", `${B}?limit=nope`)).status).toBe(400);
      expect((await call("GET", "/v1/builds/bld_nope/logs")).status).toBe(404);
      as("viewer");
      expect((await call("GET", D)).status).toBe(200);
      as(null);
      expect((await call("GET", D)).status).toBe(401);
      expect((await call("GET", B)).status).toBe(401);
      db.memberships = db.memberships.filter((row) => row.user_id !== USERS.viewer.id);
      as("viewer");
      expect((await call("GET", D)).status).toBe(404);
    });
  });

  it("domains", async () => {
    await fresh(async () => {
      const S = `/v1/services/${SEED.web}/domains`;
      expect(await call("GET", S)).toMatchObject({
        status: 200,
        body: {
          domains: [{ type: "generated", hostname: expect.stringMatching(/apps\.example\.com$/) }],
        },
      });
      expect(await call("GET", `${S}?environment_id=env_other`)).toMatchObject({
        body: { domains: [] },
      });
      expect((await call("GET", "/v1/services/svc_nope/domains")).status).toBe(404);
      as(null);
      expect((await call("GET", S)).status).toBe(401);
    });
  });

  it("custom domains: add, check through to active, remove", async () => {
    await fresh(async () => {
      const S = `/v1/services/${SEED.web}/domains`;
      const env = SEED.production;
      const added = await call("POST", S, { environment_id: env, hostname: "Shop.Example.com" });
      expect(added).toMatchObject({
        status: 201,
        body: {
          hostname: "shop.example.com",
          type: "custom",
          status: "pending_dns",
          records: [
            { type: "CNAME", purpose: "routing", state: "missing" },
            { type: "TXT", name: "_roundhouse.shop.example.com", purpose: "ownership" },
          ],
        },
      });
      const id = (added.body as { id: string }).id;
      expect(
        (await call("POST", S, { environment_id: env, hostname: "shop.example.com" })).body,
      ).toMatchObject({ error: { code: "domain_taken" } });
      expect(
        (await call("POST", S, { environment_id: env, hostname: "*.example.com" })).status,
      ).toBe(422);
      expect(
        (await call("POST", S, { environment_id: env, hostname: "x.apps.example.com" })).status,
      ).toBe(422);
      expect((await call("POST", S, { environment_id: env, hostname: "no way" })).status).toBe(400);
      expect(
        (
          await call("POST", `/v1/services/${SEED.worker}/domains`, {
            environment_id: env,
            hostname: "w.example.com",
          })
        ).status,
      ).toBe(409);

      expect((await call("POST", `/v1/domains/${id}/check`)).body).toMatchObject({
        status: "pending_verification",
      });
      expect((await call("POST", `/v1/domains/${id}/check`)).body).toMatchObject({
        status: "active",
        verification_status: "verified",
      });
      expect((await call("GET", `/v1/domains/${id}`)).status).toBe(200);
      expect((await call("POST", "/v1/domains/dom_web/check")).status).toBe(409);
      expect((await call("DELETE", "/v1/domains/dom_web")).status).toBe(409);
      expect(db.audit.map((entry) => entry.action)).toEqual(
        expect.arrayContaining(["domain.added", "domain.verified"]),
      );

      as("viewer");
      expect((await call("GET", `/v1/domains/${id}`)).status).toBe(200);
      expect((await call("DELETE", `/v1/domains/${id}`)).status).toBe(403);
      expect((await call("POST", `/v1/domains/${id}/check`)).status).toBe(403);
      expect(
        (await call("POST", S, { environment_id: env, hostname: "v.example.com" })).status,
      ).toBe(403);
      as("owner");
      expect((await call("DELETE", `/v1/domains/${id}`)).status).toBe(204);
      expect((await call("GET", `/v1/domains/${id}`)).status).toBe(404);
      as(null);
      expect((await call("GET", `/v1/domains/${id}`)).status).toBe(401);
    });
  });

  it("instance settings: owners only", async () => {
    await fresh(async () => {
      expect(await call("GET", "/v1/instance/settings")).toMatchObject({
        status: 200,
        body: { apps_domain: "apps.example.com", tls_mode: "acme" },
      });
      expect((await call("PATCH", "/v1/instance/settings", {})).status).toBe(400);
      expect(
        (await call("PATCH", "/v1/instance/settings", { apps_domain: "Not A Host" })).status,
      ).toBe(400);
      expect((await call("PATCH", "/v1/instance/settings", { tls_mode: "maybe" })).status).toBe(
        400,
      );
      expect(
        await call("PATCH", "/v1/instance/settings", {
          apps_domain: "127.0.0.1.nip.io",
          tls_mode: "internal",
        }),
      ).toMatchObject({
        status: 200,
        body: { apps_domain: "127.0.0.1.nip.io", tls_mode: "internal" },
      });
      expect(await call("PATCH", "/v1/instance/settings", { apps_domain: null })).toMatchObject({
        body: { apps_domain: null, log_retention_days: 7 },
      });
      expect((await call("PATCH", "/v1/instance/settings", { log_retention_days: 0 })).status).toBe(
        400,
      );
      expect(
        (await call("PATCH", "/v1/instance/settings", { log_retention_days: 366 })).status,
      ).toBe(400);
      expect(
        await call("PATCH", "/v1/instance/settings", { log_retention_days: 30 }),
      ).toMatchObject({ status: 200, body: { log_retention_days: 30 } });
      expect(db.audit.at(-1)).toMatchObject({
        action: "instance.settings_updated",
        metadata: { log_retention_days: 30 },
      });
      as("admin");
      expect((await call("GET", "/v1/instance/settings")).status).toBe(403);
      expect((await call("PATCH", "/v1/instance/settings", { tls_mode: "off" })).status).toBe(403);
      as(null);
      expect((await call("GET", "/v1/instance/settings")).status).toBe(401);
      expect((await call("PATCH", "/v1/instance/settings", { tls_mode: "off" })).status).toBe(401);
    });
  });

  it("signing keys: schedule, cancel, complete; instance admins only", async () => {
    await fresh(async () => {
      const KEYS = "/v1/instance/signing-keys";
      expect(await call("GET", KEYS)).toMatchObject({ status: 200, body: { next: null } });
      expect((await call("POST", `${KEYS}/rotate`, { delay_hours: 0 })).status).toBe(400);
      expect((await call("DELETE", `${KEYS}/next`)).status).toBe(404);
      expect((await call("POST", `${KEYS}/complete`, {})).status).toBe(404);
      expect(await call("POST", `${KEYS}/rotate`, {})).toMatchObject({
        status: 200,
        body: { next: { due: false } },
      });
      expect((await call("POST", `${KEYS}/rotate`, {})).status).toBe(409);
      expect((await call("POST", `${KEYS}/complete`, {})).status).toBe(409);
      expect(await call("DELETE", `${KEYS}/next`)).toMatchObject({
        status: 200,
        body: { next: null },
      });
      await call("POST", `${KEYS}/rotate`, { delay_hours: 1 });
      const next = db.signingKeys.next;
      if (next) next.not_before = Date.now() - 1;
      expect((await call("DELETE", `${KEYS}/next`)).status).toBe(409);
      expect((await call("POST", `${KEYS}/complete`, {})).status).toBe(409);
      expect(await call("POST", `${KEYS}/complete`, { force: true })).toMatchObject({
        status: 200,
        body: { next: null, current: { kid: next?.kid } },
      });
      as("admin");
      expect((await call("GET", KEYS)).status).toBe(403);
      expect((await call("POST", `${KEYS}/rotate`, {})).status).toBe(403);
      as(null);
      expect((await call("GET", KEYS)).status).toBe(401);
    });
  });

  it("GitHub App: status, manifest, callback, repositories", async () => {
    await fresh(async () => {
      const status = `/v1/github/status?workspace_id=${WORKSPACE_ID}`;
      expect((await call("GET", "/v1/github/status")).status).toBe(400);
      expect(await call("GET", status)).toMatchObject({
        status: 200,
        body: { configured: true, installations: [{ account_login: "acme" }] },
      });
      expect((await call("GET", "/v1/github/status?workspace_id=ws_other")).status).toBe(404);
      expect(
        (await call("POST", "/v1/github/manifest", { workspace_id: WORKSPACE_ID })).status,
      ).toBe(409);
      const repos = await call("GET", `/v1/github/repositories?workspace_id=${WORKSPACE_ID}`);
      expect((repos.body as { repositories: unknown[] }).repositories).toHaveLength(3);
      expect(
        await call(
          "GET",
          `/v1/github/repositories?workspace_id=${WORKSPACE_ID}&installation_id=ghi_other`,
        ),
      ).toMatchObject({ body: { repositories: [] } });
      expect((await call("GET", "/v1/github/repositories")).status).toBe(400);
      expect((await call("GET", "/v1/github/repositories?workspace_id=ws_other")).status).toBe(404);

      db.deploy.github.app = null;
      expect(
        (
          await call("POST", "/v1/github/manifest", {
            workspace_id: WORKSPACE_ID,
            organization: "-bad",
          })
        ).status,
      ).toBe(400);
      const manifest = await call("POST", "/v1/github/manifest", {
        workspace_id: WORKSPACE_ID,
        organization: "acme",
      });
      expect(manifest).toMatchObject({
        status: 200,
        body: { post_url: expect.stringMatching(/^https:\/\/github\.com\/organizations\/acme\//) },
      });
      const { state } = manifest.body as { state: string };
      expect((await call("GET", "/v1/github/callback")).status).toBe(400);
      expect((await call("GET", "/v1/github/callback?state=nope&code=x")).status).toBe(400);
      const created = await call("GET", `/v1/github/callback?state=${state}&code=abc`);
      expect(created.status).toBe(302);
      expect(db.deploy.github.app).not.toBeNull();
      expect(db.audit.at(-1)).toMatchObject({ action: "github.app_created" });
      db.deploy.github.states.push({
        state: "ins",
        workspace_id: WORKSPACE_ID,
        expires_at: Date.now() + 60_000,
      });
      db.deploy.github.states.push(
        { state: "ins2", workspace_id: WORKSPACE_ID, expires_at: Date.now() + 60_000 },
        { state: "ins3", workspace_id: WORKSPACE_ID, expires_at: Date.now() + 60_000 },
      );
      expect((await call("GET", "/v1/github/callback?state=ins")).status).toBe(400);
      expect(
        (
          await call(
            "GET",
            "/v1/github/callback?state=ins3&installation_id=77&setup_action=install",
          )
        ).status,
      ).toBe(302);
      expect(lastLocation).toBe("/settings/github?error=authorization_required");
      expect(db.audit.at(-1)).toMatchObject({
        action: "github.installation_rejected",
        metadata: { reason: "authorization_required" },
      });
      expect(
        (await call("GET", "/v1/github/callback?state=ins3&installation_id=77&code=ok")).status,
      ).toBe(302);
      expect(lastLocation).toBe("/settings/github?error=link_used");
      expect(db.audit.at(-1)).toMatchObject({ metadata: { reason: "link_used" } });
      db.deploy.github.states.push(
        { state: "ins4", workspace_id: WORKSPACE_ID, expires_at: Date.now() + 60_000 },
        { state: "ins5", workspace_id: WORKSPACE_ID, expires_at: Date.now() + 60_000 },
        { state: "ins6", workspace_id: WORKSPACE_ID, expires_at: Date.now() + 60_000 },
      );
      await call("GET", "/v1/github/callback?state=ins4&installation_id=77&code=denied");
      expect(lastLocation).toBe("/settings/github?error=installation_not_accessible");
      await call("GET", "/v1/github/callback?state=ins5&installation_id=77&code=invalid");
      expect(lastLocation).toBe("/settings/github?error=authorization_failed");
      await call("GET", "/v1/github/callback?state=ins6&installation_id=77&setup_action=request");
      expect(lastLocation).toBe("/settings/github?status=requested");
      expect(
        (await call("GET", "/v1/github/callback?state=ins2&installation_id=77&code=ok")).status,
      ).toBe(302);
      expect(lastLocation).toBe("/settings/github?status=installed");
      expect(db.audit.at(-1)).toMatchObject({ action: "github.installation_added" });

      as("member");
      expect((await call("GET", status)).status).toBe(200);
      expect(
        (await call("GET", `/v1/github/repositories?workspace_id=${WORKSPACE_ID}`)).status,
      ).toBe(200);
      expect((await call("GET", "/v1/github/callback?state=ins&installation_id=78")).status).toBe(
        403,
      );
      as("viewer");
      expect(
        (await call("GET", `/v1/github/repositories?workspace_id=${WORKSPACE_ID}`)).status,
      ).toBe(403);
      expect(
        (await call("POST", "/v1/github/manifest", { workspace_id: WORKSPACE_ID })).status,
      ).toBe(403);
      as(null);
      expect((await call("GET", status)).status).toBe(401);
      expect(
        (await call("POST", "/v1/github/manifest", { workspace_id: WORKSPACE_ID })).status,
      ).toBe(401);
      expect((await call("GET", "/v1/github/callback?state=ins&code=x")).status).toBe(401);
      expect(
        (await call("GET", `/v1/github/repositories?workspace_id=${WORKSPACE_ID}`)).status,
      ).toBe(401);
    });
  });

  it("ADR 0014: GitHub claims and releases, instance admins and audit, re-authentication", async () => {
    await fresh(async () => {
      const claim = await call("POST", "/v1/github/claims", { workspace_id: WORKSPACE_ID });
      expect(claim).toMatchObject({
        status: 200,
        body: { install_url: expect.stringContaining("/installations/new?state=ghc_") },
      });
      const state = new URL((claim.body as { install_url: string }).install_url).searchParams.get(
        "state",
      );
      await call("GET", `/v1/github/callback?state=${state}&installation_id=91&code=not-admin`);
      expect(lastLocation).toBe("/settings/github?error=not_account_admin");

      const release = `/v1/github/installations/${SEED.installation}?workspace_id=${WORKSPACE_ID}`;
      db.sessionStale = true;
      expect(await call("DELETE", release)).toMatchObject({
        status: 403,
        body: { error: { code: "reauth_required", details: [{ code: "session_stale" }] } },
      });
      expect((await call("PATCH", "/v1/instance/settings", { tls_mode: "internal" })).status).toBe(
        403,
      );
      expect((await call("POST", "/v1/auth/reauth", { password: "nope" })).status).toBe(400);
      expect((await call("POST", "/v1/auth/reauth", {})).status).toBe(400);
      expect(await call("POST", "/v1/auth/reauth", { password: PASSWORD })).toMatchObject({
        status: 200,
        body: { fresh_until: expect.any(Number) },
      });
      expect((await call("DELETE", release)).status).toBe(204);
      expect((await call("DELETE", release)).status).toBe(404);

      expect(await call("GET", "/v1/instance/admins")).toMatchObject({
        status: 200,
        body: { admins: [{ user_id: USERS.owner.id }] },
      });
      expect(
        (await call("PUT", `/v1/instance/admins/${USERS.owner.id}`, { instance_admin: false }))
          .status,
      ).toBe(409);
      expect(
        (await call("PUT", "/v1/instance/admins/usr_nobody", { instance_admin: true })).status,
      ).toBe(404);
      expect((await call("PUT", `/v1/instance/admins/${USERS.admin.id}`, {})).status).toBe(400);
      expect(
        await call("PUT", `/v1/instance/admins/${USERS.admin.id}`, { instance_admin: true }),
      ).toMatchObject({ status: 200, body: { user_id: USERS.admin.id } });

      const page = await call("GET", "/v1/instance/audit-logs?limit=2");
      expect(page.status).toBe(200);
      const { entries, next_cursor } = page.body as {
        entries: { workspace_id: string | null; action: string }[];
        next_cursor: string | null;
      };
      expect(entries.map((e) => e.action)).toEqual([
        "instance.admin_granted",
        "auth.reauthenticated",
      ]);
      expect(entries.every((e) => e.workspace_id === null)).toBe(true);
      expect(
        (await call("GET", `/v1/instance/audit-logs?limit=2&cursor=${next_cursor}`)).status,
      ).toBe(200);
      expect(
        await call("GET", "/v1/instance/audit-logs?action=auth.reauthenticated"),
      ).toMatchObject({ body: { entries: [{ action: "auth.reauthenticated" }] } });
      expect((await call("GET", "/v1/instance/audit-logs?action=nope")).status).toBe(400);
      expect(await call("GET", "/v1/instance/audit-logs/verify")).toMatchObject({
        status: 200,
        body: { ok: true, broken_at_seq: null },
      });

      db.deploy.github.app = null;
      expect((await call("POST", "/v1/github/claims", { workspace_id: WORKSPACE_ID })).status).toBe(
        409,
      );
      expect((await call("POST", "/v1/github/claims", {})).status).toBe(400);
      as("member");
      expect((await call("POST", "/v1/github/claims", { workspace_id: WORKSPACE_ID })).status).toBe(
        403,
      );
      expect((await call("DELETE", release)).status).toBe(403);
      as("viewer");
      expect((await call("GET", "/v1/instance/admins")).status).toBe(403);
      expect(
        (await call("PUT", `/v1/instance/admins/${USERS.viewer.id}`, { instance_admin: true }))
          .status,
      ).toBe(403);
      expect((await call("GET", "/v1/instance/audit-logs")).status).toBe(403);
      expect((await call("GET", "/v1/instance/audit-logs/verify")).status).toBe(403);
      as(null);
      expect((await call("POST", "/v1/github/claims", { workspace_id: WORKSPACE_ID })).status).toBe(
        401,
      );
      expect((await call("DELETE", release)).status).toBe(401);
      expect((await call("GET", "/v1/instance/admins")).status).toBe(401);
      expect(
        (await call("PUT", `/v1/instance/admins/${USERS.admin.id}`, { instance_admin: true }))
          .status,
      ).toBe(401);
      expect((await call("GET", "/v1/instance/audit-logs")).status).toBe(401);
      expect((await call("GET", "/v1/instance/audit-logs/verify")).status).toBe(401);
      expect((await call("POST", "/v1/auth/reauth", { password: PASSWORD })).status).toBe(401);
    });
  });

  it("GitHub webhooks: verify the signature, then deploy services tracking the branch", async () => {
    await fresh(async () => {
      const payload = JSON.stringify({
        ref: "refs/heads/main",
        after: "f".repeat(40),
        repository: { clone_url: "https://github.com/acme/storefront.git" },
      });
      const headers = (signature: string) => ({
        "x-github-event": "push",
        "x-github-delivery": "d-1",
        "x-hub-signature-256": signature,
      });
      expect(
        (
          await call("POST", "/v1/webhooks/github", undefined, {
            rawBody: payload,
            headers: { "x-github-event": "push" },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call("POST", "/v1/webhooks/github", undefined, {
            rawBody: payload,
            headers: headers(`sha256=${"0".repeat(64)}`),
          })
        ).status,
      ).toBe(401);
      const signature = `sha256=${await hmac(db.deploy.github.webhookSecret, payload)}`;
      const before = db.deploy.deployments.length;
      as(null);
      expect(
        (
          await call("POST", "/v1/webhooks/github", undefined, {
            rawBody: payload,
            headers: headers(signature),
          })
        ).status,
      ).toBe(202);
      expect(db.deploy.deployments.length).toBe(before + 1);
      expect(db.deploy.deployments.at(-1)).toMatchObject({ trigger: "push", service_id: SEED.web });
    });
  });

  it("realtime: refuses plain HTTP, and its socket messages match the schema", async () => {
    await fresh(async () => {
      const R = `/v1/projects/${SEED.project}/realtime`;
      expect(await call("GET", R)).toMatchObject({
        status: 426,
        body: { error: { code: "upgrade_required" } },
      });
      expect((await call("GET", "/v1/projects/prj_nope/realtime")).status).toBe(426);

      const url = new URL(R, window.location.origin);
      url.protocol = "ws:";
      const socket = new WebSocket(url);
      const received: unknown[] = [];
      socket.onmessage = (event) => received.push(JSON.parse(String(event.data)));
      await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
      socket.send(
        JSON.stringify({
          type: "subscribe",
          topic: { kind: "deployment_logs", deployment_id: SEED.webActive },
        }),
      );
      await expect
        .poll(() => realtimeSubscriptions(SEED.project))
        .toEqual([`deployment_logs:${SEED.webActive}`]);
      await call(
        "POST",
        `/v1/services/${SEED.web}/deployments?environment_id=${SEED.production}`,
        {},
      );
      await call("PATCH", `/v1/services/${SEED.web}`, { name: "web-2" });
      await expect
        .poll(() => received.map((m) => (m as { type: string }).type))
        .toEqual(["presence", "deployment.updated", "service.updated"]);
      socket.close();

      const closeCode = async (path: string) => {
        const target = new URL(path, window.location.origin);
        target.protocol = "ws:";
        const probe = new WebSocket(target);
        return new Promise<number>((resolve) =>
          probe.addEventListener("close", (event) => resolve(event.code), { once: true }),
        );
      };
      expect(await closeCode("/v1/projects/prj_nope/realtime")).toBe(REALTIME_CLOSE_CODES.notFound);
      db.memberships = db.memberships.filter((row) => row.user_id !== USERS.viewer.id);
      as("viewer");
      expect(await closeCode(R)).toBe(REALTIME_CLOSE_CODES.notFound);
      as(null);
      expect(await closeCode(R)).toBe(REALTIME_CLOSE_CODES.unauthorized);
      expect((await call("GET", R)).status).toBe(426);
      for (const message of sentRealtimeMessages) {
        const result = RealtimeServerMessageSchema.safeParse(message);
        if (!result.success)
          failures.push(`realtime ${JSON.stringify(message)}: ${result.error.message}`);
      }
      expect(sentRealtimeMessages.length).toBeGreaterThanOrEqual(3);
    });
  });

  it("summaries: one project in an environment, every project in production", async () => {
    await fresh(async () => {
      const P = `/v1/projects/${SEED.project}/summary`;
      const one = await call("GET", P);
      expect(one).toMatchObject({
        status: 200,
        body: {
          name: "storefront",
          environment: { id: SEED.production },
          services: [
            {
              service: { id: SEED.api },
              config_version: 2,
              domain: { hostname: expect.stringMatching(/^api-production/) },
              latest_deployment: { id: SEED.apiActive, project_id: SEED.project },
            },
            { service: { id: DATA_SEED.database, kind: "database" }, domain: null },
            {
              service: { id: SEED.web },
              config_version: 3,
              source: { type: "git" },
              latest_deployment: { id: SEED.webActive, build: { commit_sha: expect.any(String) } },
            },
            { service: { id: SEED.worker }, domain: null },
          ],
        },
      });
      expect(await call("GET", `${P}?environment_id=${SEED.production}`)).toMatchObject({
        status: 200,
        body: { environment: { id: SEED.production } },
      });
      expect((await call("GET", `${P}?environment_id=env_nope`)).status).toBe(404);
      expect((await call("GET", "/v1/projects/prj_nope/summary")).status).toBe(404);

      const all = await call("GET", `${WS}/projects/summary`);
      const projects = (all.body as { projects: { name: string; services: unknown[] }[] }).projects;
      expect(projects.map((project) => [project.name, project.services.length])).toEqual([
        ["internal-tools", 1],
        ["storefront", 4],
      ]);
      expect((await call("GET", `${OTHER_WS}/projects/summary`)).status).toBe(404);

      db.deploy.environments = db.deploy.environments.filter(
        (row) => row.id !== SEED.toolsProduction,
      );
      expect(await call("GET", `${WS}/projects/summary`)).toMatchObject({
        body: { projects: [{ environment: null, services: [{ latest_deployment: null }] }, {}] },
      });
      expect((await call("GET", `/v1/projects/${SEED.toolsProject}/summary`)).status).toBe(404);

      as("viewer");
      expect((await call("GET", P)).status).toBe(200);
      expect((await call("GET", `${WS}/projects/summary`)).status).toBe(200);
      as(null);
      expect((await call("GET", P)).status).toBe(401);
      expect((await call("GET", `${WS}/projects/summary`)).status).toBe(401);
    });
  });

  it("resolved: plain values as a deployment gets them, secrets only as local keys", async () => {
    await fresh(async () => {
      const R = `/v1/services/${SEED.web}/variables/resolved`;
      const env = `?environment_id=${SEED.production}`;
      expect((await call("GET", R)).status).toBe(400);
      expect((await call("GET", `${R}?environment_id=env_nope`)).status).toBe(404);
      await call("PUT", `/v1/services/${SEED.web}/variables${env}`, {
        set: [{ key: "SESSION_URL", value: `https://x:\${{SESSION_SECRET}}@sessions` }],
      });
      const resolved = await call("GET", `${R}${env}`);
      expect(resolved.status).toBe(200);
      const body = resolved.body as { variables: Record<string, string>; local_keys: string[] };
      expect(Object.keys(body.variables)).toEqual(Object.keys(body.variables).sort());
      expect(body.variables.API_URL).toBe("http://api.production.internal:8080");
      expect(body.variables.REGION).toBe("hel1");
      expect(body.variables.ROUNDHOUSE_DEPLOYMENT_ID).toBe(SEED.webActive);
      expect(body.variables.PORT).toBe("3000");
      expect(body.local_keys).toEqual(["DATABASE_URL", "SESSION_SECRET", "SESSION_URL"]);
      for (const key of body.local_keys) expect(body.variables).not.toHaveProperty(key);
      expect(JSON.stringify(body)).not.toContain("hunter2");
      expect(JSON.stringify(body)).not.toContain("s3cr3t");
      expect(db.audit.at(-1)).toMatchObject({
        action: "variables.resolved",
        metadata: { keys: expect.arrayContaining(["API_URL"]) },
      });
      expect(JSON.stringify(db.audit.at(-1))).not.toContain("hunter2");

      await call("PUT", `/v1/services/${SEED.web}/variables${env}`, {
        set: [{ key: "BROKEN", value: `\${{nowhere.X}}` }],
      });
      expect(await call("GET", `${R}${env}`)).toMatchObject({
        status: 400,
        body: { error: { code: "invalid_reference", details: [{ field: "web.BROKEN" }] } },
      });

      as("viewer");
      expect((await call("GET", `${R}${env}`)).status).toBe(403);
      as(null);
      expect((await call("GET", `${R}${env}`)).status).toBe(401);
    });
  });

  it("API tokens: list, create within the role, revoke idempotently", async () => {
    await fresh(async () => {
      const T = `${WS}/tokens`;
      const list = await call("GET", T);
      expect(list.status).toBe(200);
      const listed = (list.body as { tokens: Record<string, unknown>[] }).tokens;
      expect(listed.map((token) => token.id)).toEqual([
        SEED.ciToken,
        SEED.expiredToken,
        SEED.revokedToken,
      ]);
      expect(JSON.stringify(listed)).not.toContain("mockmock");
      expect((await call("GET", `${OTHER_WS}/tokens`)).status).toBe(404);

      expect((await call("POST", T, { name: "", scopes: ["projects:read"] })).status).toBe(400);
      expect((await call("POST", T, { name: "x", scopes: [], expires_in_days: null })).status).toBe(
        400,
      );
      expect(
        (await call("POST", T, { name: "x", scopes: ["instance:manage"], expires_in_days: 7 }))
          .status,
      ).toBe(400);
      expect(
        (await call("POST", T, { name: "x", scopes: ["projects:read"], expires_in_days: 367 }))
          .status,
      ).toBe(400);
      const created = await call("POST", T, {
        name: "deploy-bot",
        scopes: [...API_TOKEN_PRESETS.deploy],
        expires_in_days: 30,
      });
      expect(created).toMatchObject({
        status: 201,
        body: {
          token: { name: "deploy-bot", revoked_at: null, created_by: { user_id: USERS.owner.id } },
          secret: expect.stringMatching(/^tok_[A-Za-z0-9]{40}$/),
        },
      });
      const { token, secret } = created.body as {
        token: { id: string; prefix: string };
        secret: string;
      };
      expect(secret.startsWith(token.prefix)).toBe(true);
      expect(token.prefix).toHaveLength(8);
      expect(db.audit.at(-1)).toMatchObject({ action: "token.created" });
      expect(JSON.stringify(db.audit.at(-1))).not.toContain(secret);

      expect((await call("DELETE", `${T}/tok_nope`)).status).toBe(404);
      expect((await call("DELETE", `${T}/${token.id}`)).status).toBe(204);
      const audits = db.audit.length;
      expect((await call("DELETE", `${T}/${token.id}`)).status).toBe(204);
      expect(db.audit.length).toBe(audits);

      as("admin");
      expect(
        (await call("POST", T, { name: "a", scopes: ["members:manage"], expires_in_days: null }))
          .status,
      ).toBe(201);
      expect(
        await call("POST", T, { name: "a", scopes: ["workspace:delete"], expires_in_days: null }),
      ).toMatchObject({
        status: 403,
        body: { error: { message: expect.stringContaining("workspace:delete") } },
      });
      as("member");
      expect((await call("GET", T)).status).toBe(403);
      expect(
        (await call("POST", T, { name: "m", scopes: ["projects:read"], expires_in_days: 7 }))
          .status,
      ).toBe(403);
      expect((await call("DELETE", `${T}/${SEED.ciToken}`)).status).toBe(403);
      as(null);
      expect((await call("GET", T)).status).toBe(401);
      expect(
        (await call("POST", T, { name: "n", scopes: ["projects:read"], expires_in_days: 7 }))
          .status,
      ).toBe(401);
      expect((await call("DELETE", `${T}/${SEED.ciToken}`)).status).toBe(401);
    });
  });

  it("cloud providers: connect, offers, provision until joined, disconnect", async () => {
    await fresh(async () => {
      const token = "hcloud-0123456789abcdef";
      const list = await call("GET", `${WS}/integrations`);
      expect(list.status).toBe(200);
      expect(
        (list.body as { integrations: { provider: string; connected: boolean }[] }).integrations,
      ).toEqual([
        expect.objectContaining({ provider: "hetzner", connected: false }),
        expect.objectContaining({ provider: "digitalocean", connected: false }),
        expect.objectContaining({ provider: "vultr", connected: false }),
        expect.objectContaining({ provider: "linode", connected: false }),
      ]);
      expect((await call("GET", `${WS}/integrations/hetzner`)).status).toBe(200);
      expect(await call("GET", `${WS}/providers/hetzner/offers`)).toMatchObject({
        status: 409,
        body: { error: { code: "provider_not_connected" } },
      });

      expect((await call("PUT", `${WS}/integrations/hetzner`, { token: "short" })).status).toBe(
        400,
      );
      expect(
        await call("PUT", `${WS}/integrations/hetzner`, { token: "bad-0123456789abcdef" }),
      ).toMatchObject({ status: 400, body: { error: { code: "provider_token_invalid" } } });
      expect(
        await call("PUT", `${WS}/integrations/hetzner`, { token: "ro-0123456789abcdef" }),
      ).toMatchObject({ status: 409, body: { error: { code: "provider_read_only" } } });
      const connected = await call("PUT", `${WS}/integrations/hetzner`, { token });
      expect(connected).toMatchObject({
        status: 200,
        body: { connected: true, account_label: "demo@example.com", token_last4: "cdef" },
      });
      expect(JSON.stringify(connected.body)).not.toContain(token);

      const offers = await call("GET", `${WS}/providers/hetzner/offers?role=builder`);
      expect(offers.status).toBe(200);
      const { recommendations } = offers.body as { recommendations: { offer_id: string }[] };
      expect(recommendations[0]?.offer_id).toBe("cx22@fsn1");
      expect((await call("GET", `${WS}/providers/hetzner/offers?role=boss`)).status).toBe(400);

      const body = { provider: "hetzner", plan: "cx22", region: "fsn1", name: "web-1" };
      expect((await call("POST", `${WS}/nodes/provision`, { ...body, name: "Web 1" })).status).toBe(
        400,
      );
      expect(
        await call("POST", `${WS}/nodes/provision`, { ...body, provider: "vultr" }),
      ).toMatchObject({ status: 409, body: { error: { code: "provider_not_connected" } } });
      expect(await call("POST", `${WS}/nodes/provision`, { ...body, name: "hel-1" })).toMatchObject(
        { status: 409, body: { error: { code: "conflict" } } },
      );
      const started = await call("POST", `${WS}/nodes/provision`, body);
      expect(started).toMatchObject({ status: 202, body: { status: "queued", name: "web-1" } });
      const id = (started.body as ProvisionBody).id;
      expect((await call("GET", `${WS}/node-provisions`)).body).toMatchObject({
        provisions: [{ id }],
      });
      const runs: ProvisionBody[] = [];
      for (let i = 0; i < 3; i++) {
        runs.push((await call("GET", `${WS}/node-provisions/${id}`)).body as ProvisionBody);
      }
      expect(runs.map((run) => run.status)).toEqual(["creating", "booting", "joined"]);
      const joined = runs[2] as ProvisionBody;
      expect(db.nodes.find((node) => node.id === joined.node_id)).toMatchObject({
        provider: "hetzner",
        provider_server_id: joined.server_id,
      });
      expect((await call("GET", `${WS}/node-provisions/npr_nope`)).status).toBe(404);

      expect(await call("DELETE", `${WS}/integrations/hetzner`)).toMatchObject({
        status: 409,
        body: { error: { code: "conflict" } },
      });
      expect((await call("DELETE", `${WS}/integrations/hetzner?force=true`)).status).toBe(204);
      expect((await call("DELETE", `${WS}/integrations/hetzner`)).status).toBe(404);
      expect(await call("DELETE", `${WS}/nodes/${joined.node_id}`)).toMatchObject({
        status: 409,
        body: { error: { code: "provider_not_connected" } },
      });
      expect((await call("DELETE", `${WS}/nodes/${joined.node_id}?keep_server=true`)).status).toBe(
        204,
      );

      expect((await call("PUT", `${WS}/integrations/vultr`, { token })).status).toBe(200);
      db.nodes.push({
        ...makeNode({
          id: "node_vultr",
          name: "ewr-1",
          provider: "vultr",
          provider_server_id: "v1",
        }),
        workspace_id: WORKSPACE_ID,
      });
      expect((await call("DELETE", `${WS}/nodes/node_vultr`)).status).toBe(204);
      expect(db.audit.some((entry) => entry.action === "node.deprovisioned")).toBe(true);

      const leaking = await call("POST", `${WS}/nodes/provision`, {
        provider: "vultr",
        plan: "vc2-1c-2gb",
        region: "ewr",
        name: "leak-1",
        builder: true,
      });
      const leakingId = (leaking.body as ProvisionBody).id;
      let last: ProvisionBody | undefined;
      for (let i = 0; i < 3; i++) {
        last = (await call("GET", `${WS}/node-provisions/${leakingId}`)).body as ProvisionBody;
      }
      expect(last?.status).toBe("cleanup_failed");

      as("member");
      expect((await call("GET", `${WS}/integrations`)).status).toBe(403);
      expect((await call("GET", `${WS}/integrations/hetzner`)).status).toBe(403);
      expect((await call("PUT", `${WS}/integrations/hetzner`, { token })).status).toBe(403);
      expect((await call("DELETE", `${WS}/integrations/vultr`)).status).toBe(403);
      expect((await call("GET", `${WS}/providers/vultr/offers`)).status).toBe(403);
      expect((await call("POST", `${WS}/nodes/provision`, body)).status).toBe(403);
      expect((await call("GET", `${WS}/node-provisions`)).status).toBe(200);
      expect((await call("GET", `${WS}/node-provisions/${leakingId}`)).status).toBe(200);
      as(null);
      expect((await call("GET", `${WS}/integrations`)).status).toBe(401);
      expect((await call("GET", `${WS}/node-provisions`)).status).toBe(401);
      as("owner");
      expect((await call("GET", `${OTHER_WS}/integrations`)).status).toBe(404);
      expect((await call("GET", `${OTHER_WS}/node-provisions/${leakingId}`)).status).toBe(404);
    });
  });

  it("cloud providers: cancel a run, and estimate the cost of provisioned servers", async () => {
    await fresh(async () => {
      const token = "hz-0123456789abcdef0123456789abcdef";
      expect((await call("PUT", `${WS}/integrations/hetzner`, { token })).status).toBe(200);
      const start = async (name: string) =>
        (
          await call("POST", `${WS}/nodes/provision`, {
            provider: "hetzner",
            plan: "cx22",
            region: "fsn1",
            name,
          })
        ).body as ProvisionBody;
      const cancel = (id: string) => call("POST", `${WS}/node-provisions/${id}/cancel`);

      const queued = await start("web-1");
      expect(await cancel(queued.id)).toMatchObject({
        status: 200,
        body: { status: "cancelled", cancel_requested_at: expect.any(Number) },
      });
      expect((await cancel(queued.id)).status).toBe(200);

      const creating = await start("web-2");
      await call("GET", `${WS}/node-provisions/${creating.id}`);
      expect(await cancel(creating.id)).toMatchObject({
        status: 200,
        body: { status: "creating", cancel_requested_at: expect.any(Number) },
      });
      expect(await call("GET", `${WS}/node-provisions/${creating.id}`)).toMatchObject({
        body: { status: "cancelled", server_id: expect.any(String) },
      });

      const priced = await start("web-3");
      let run: ProvisionBody | undefined;
      for (let i = 0; i < 3; i++) {
        run = (await call("GET", `${WS}/node-provisions/${priced.id}`)).body as ProvisionBody;
      }
      expect(run?.status).toBe("joined");
      expect(await cancel(priced.id)).toMatchObject({
        status: 409,
        body: { error: { message: expect.stringContaining("already joined") } },
      });
      const node = (await call("GET", `${WS}/nodes/${run?.node_id}`)).body as {
        estimated_monthly_cost: unknown;
      };
      expect(node.estimated_monthly_cost).toEqual({ monthly_cents: 451, currency: "EUR" });
      expect((await call("POST", `${WS}/node-provisions/npr_nope/cancel`)).status).toBe(404);
      expect(db.audit.filter((e) => e.action === "node.provision_cancelled")).toHaveLength(2);

      as("member");
      expect((await cancel(priced.id)).status).toBe(403);
      as(null);
      expect((await cancel(priced.id)).status).toBe(401);
    });
  });

  it("templates: gallery, detail, create a project, deploy into one", async () => {
    await fresh(async () => {
      const list = await call("GET", `${WS}/templates`);
      expect(list.status).toBe(200);
      const summaries = (list.body as { templates: { id: string; supported: boolean }[] })
        .templates;
      expect(summaries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "n8n", supported: true }),
          expect.objectContaining({ id: "postgres-app", supported: false }),
        ]),
      );
      const detail = await call("GET", `${WS}/templates/webhook-relay`);
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({
        services: [
          {
            ref: "relay",
            variables: expect.arrayContaining([
              expect.objectContaining({ key: "SIGNING_SECRET", secret: true, value: null }),
              expect.objectContaining({ key: "RELAY_TOKEN", generated: true, value: null }),
            ]),
          },
          expect.anything(),
        ],
      });
      expect((await call("GET", `${WS}/templates/Not_A_Slug`)).status).toBe(400);
      expect((await call("GET", `${WS}/templates/nope`)).status).toBe(404);

      const FROM = `${WS}/projects/from-template`;
      expect((await call("POST", FROM, { inputs: {} })).status).toBe(400);
      expect((await call("POST", FROM, { template_id: "nope" })).status).toBe(404);
      expect(await call("POST", FROM, { template_id: "postgres-app" })).toMatchObject({
        status: 409,
        body: { error: { code: "conflict" } },
      });
      expect(await call("POST", FROM, { template_id: "webhook-relay" })).toMatchObject({
        status: 400,
        body: {
          error: {
            code: "invalid_request",
            details: [
              { field: "inputs.TARGET_URL", code: "required" },
              { field: "inputs.SIGNING_SECRET", code: "required" },
            ],
          },
        },
      });
      const inputs = { TARGET_URL: "http://hooks.internal:9000", SIGNING_SECRET: "s3cret-value" };
      expect(await call("POST", FROM, { template_id: "webhook-relay", inputs })).toMatchObject({
        status: 400,
        body: { error: { code: "confirmation_required" } },
      });
      const created = await call("POST", FROM, {
        template_id: "webhook-relay",
        name: "Hooks",
        inputs,
        confirm_write_only: true,
      });
      expect(created).toMatchObject({
        status: 201,
        body: {
          template: { id: "webhook-relay", version: 2 },
          project: { name: "Hooks", slug: "hooks" },
          environment: { slug: "production" },
          services: [{ slug: "relay" }, { slug: "worker" }],
          deploy_errors: [],
        },
      });
      expect(JSON.stringify(created.body)).not.toContain("s3cret-value");
      const result = created.body as { project: { id: string }; deployments: unknown[] };
      expect(result.deployments).toHaveLength(2);
      expect(db.deploy.variables.find((row) => row.key === "SIGNING_SECRET")?.tier).toBe("secret");
      expect(
        db.audit.filter((row) => row.target_id === result.project.id).map((row) => row.action),
      ).toEqual(["project.created", "template.deployed"]);

      const DEPLOY = `/v1/projects/${SEED.project}/templates/deploy`;
      const into = { template_id: "whoami", environment_id: SEED.production, deploy: false };
      expect((await call("POST", DEPLOY, { template_id: "whoami" })).status).toBe(400);
      const first = await call("POST", DEPLOY, into);
      expect(first).toMatchObject({
        status: 201,
        body: { services: [{ slug: "whoami" }], deployments: [] },
      });
      expect(await call("POST", DEPLOY, into)).toMatchObject({
        status: 201,
        body: { services: [{ slug: "whoami-2" }] },
      });
      expect((await call("POST", DEPLOY, { ...into, environment_id: "env_nope" })).status).toBe(
        404,
      );
      expect((await call("POST", "/v1/projects/prj_nope/templates/deploy", into)).status).toBe(404);
      expect((await call("POST", DEPLOY, { ...into, template_id: "file-browser" })).status).toBe(
        409,
      );

      as("member");
      expect((await call("POST", FROM, { template_id: "whoami" })).status).toBe(403);
      expect((await call("POST", DEPLOY, into)).status).toBe(201);
      as("viewer");
      expect((await call("GET", `${WS}/templates`)).status).toBe(200);
      expect((await call("GET", `${WS}/templates/whoami`)).status).toBe(200);
      expect((await call("POST", FROM, { template_id: "whoami" })).status).toBe(403);
      expect((await call("POST", DEPLOY, into)).status).toBe(403);
      as(null);
      expect((await call("POST", FROM, {})).status).toBe(400);
      expect((await call("GET", `${WS}/templates`)).status).toBe(401);
      expect((await call("GET", `${WS}/templates/whoami`)).status).toBe(401);
      expect((await call("POST", FROM, { template_id: "whoami" })).status).toBe(401);
      expect((await call("POST", DEPLOY, into)).status).toBe(401);
      as("owner");
      expect((await call("GET", `${OTHER_WS}/templates`)).status).toBe(404);
      expect((await call("GET", `${OTHER_WS}/templates/whoami`)).status).toBe(404);
      expect(
        (await call("POST", `${OTHER_WS}/projects/from-template`, { template_id: "whoami" }))
          .status,
      ).toBe(404);
    });
  });

  it("canvas and change sets: stage, review, conflict, resolve, apply, discard", async () => {
    await fresh(async () => {
      const ENV = `/v1/environments/${SEED.production}`;
      const canvas = await call(
        "GET",
        `/v1/projects/${SEED.project}/canvas?environment_id=${SEED.production}`,
      );
      expect(canvas.status).toBe(200);
      expect((await call("GET", `/v1/projects/${SEED.project}/canvas`)).status).toBe(400);
      expect((await call("GET", `/v1/projects/prj_nope/canvas?environment_id=x`)).status).toBe(404);
      const layout = await call("PATCH", `/v1/projects/${SEED.project}/canvas/layout`, {
        positions: { [SEED.api]: { x: 320, y: 0 } },
        expected_version: 0,
      });
      expect(layout).toMatchObject({ status: 200, body: { version: 1 } });
      expect(
        (
          await call("PATCH", `/v1/projects/${SEED.project}/canvas/layout`, {
            positions: {},
            expected_version: 0,
          })
        ).status,
      ).toBe(409);

      expect(await call("GET", `${ENV}/draft`)).toMatchObject({
        status: 200,
        body: { change_set: null },
      });
      const patch = { type: "config.patch", service: SEED.api, patch: { deploy: { replicas: 3 } } };
      const staged = await call("POST", `${ENV}/draft/ops`, { op: patch });
      expect(staged).toMatchObject({
        status: 200,
        body: { is_draft: true, revision: 2, op_count: 1 },
      });
      const set = staged.body as { id: string; revision: number; changes: { id: string }[] };
      expect(
        (await call("POST", `${ENV}/draft/ops`, { op: patch, expected_revision: 1 })).status,
      ).toBe(409);
      expect((await call("POST", `${ENV}/draft/ops`, { op: { type: "nope" } })).status).toBe(400);
      expect(
        await call("POST", `${ENV}/draft/ops`, {
          op: {
            type: "variable.set",
            scope: "service",
            service: SEED.api,
            key: "API_TOKEN",
            value: STAGED_VALUE,
            tier: "secret",
          },
        }),
      ).toMatchObject({ status: 400, body: { error: { code: "confirmation_required" } } });
      const secret = await call("POST", `${ENV}/draft/ops`, {
        op: {
          type: "variable.set",
          scope: "service",
          service: SEED.api,
          key: "API_TOKEN",
          value: STAGED_VALUE,
          tier: "secret",
          confirm_write_only: true,
        },
      });
      expect(secret.status).toBe(200);
      expect(JSON.stringify(secret.body)).not.toContain(STAGED_VALUE);

      expect((await call("GET", `/v1/change-sets/${set.id}`)).status).toBe(200);
      expect((await call("GET", `/v1/change-sets/chs_nope`)).status).toBe(404);
      expect((await call("GET", `${ENV}/change-sets?status=all`)).status).toBe(200);
      const review = await call("GET", `/v1/change-sets/${set.id}/diff`);
      expect(review).toMatchObject({ status: 200, body: { conflicts: [] } });

      const other = await call("POST", `${ENV}/change-sets`, {
        title: "From the API",
        ops: [
          {
            type: "variable.set",
            scope: "service",
            service: SEED.web,
            key: "MODE",
            value: "batch",
          },
        ],
      });
      expect(other).toMatchObject({ status: 201, body: { is_draft: false, op_count: 1 } });
      const otherSet = other.body as { id: string; revision: number; changes: { id: string }[] };
      const extra = await call("POST", `/v1/change-sets/${otherSet.id}/ops`, {
        op: { type: "variable.set", scope: "service", service: SEED.web, key: "LEVEL", value: "2" },
      });
      expect(extra.status).toBe(200);
      const extraSet = extra.body as { revision: number; changes: { id: string }[] };
      expect(
        (
          await call(
            "DELETE",
            `/v1/change-sets/${otherSet.id}/ops/${extraSet.changes[1]!.id}?expected_revision=${extraSet.revision}`,
          )
        ).status,
      ).toBe(200);
      expect((await call("DELETE", `/v1/change-sets/${otherSet.id}/ops/stg_nope`)).status).toBe(
        404,
      );
      expect((await call("POST", `/v1/change-sets/${otherSet.id}/discard`, {})).status).toBe(200);
      expect((await call("POST", `/v1/change-sets/${otherSet.id}/discard`, {})).status).toBe(409);

      // A direct edit to the same pointer makes the staged patch conflict.
      const latest = db.deploy.configs
        .filter((c) => c.service_id === SEED.api && c.environment_id === SEED.production)
        .sort((a, b) => b.version - a.version)[0]!;
      db.deploy.configs.push({
        ...latest,
        id: "cfg_direct",
        version: latest.version + 1,
        deploy: { ...latest.deploy, replicas: 5 },
      });
      const current = (await call("GET", `/v1/change-sets/${set.id}`)).body as {
        revision: number;
        changes: { id: string }[];
      };
      const refused = await call("POST", `/v1/change-sets/${set.id}/apply`, {
        expected_revision: current.revision,
      });
      expect(refused).toMatchObject({
        status: 409,
        body: { error: { code: "change_set_conflict" } },
      });
      expect(
        (await call("POST", `/v1/change-sets/${set.id}/apply`, { expected_revision: 1 })).status,
      ).toBe(409);
      const conflicted = (await call("GET", `/v1/change-sets/${set.id}`)).body as {
        revision: number;
        changes: { id: string }[];
      };
      expect(
        (
          await call("POST", `/v1/change-sets/${set.id}/ops/${conflicted.changes[0]!.id}/resolve`, {
            keep: "mine",
            expected_revision: 1,
          })
        ).status,
      ).toBe(409);
      const resolved = await call(
        "POST",
        `/v1/change-sets/${set.id}/ops/${conflicted.changes[0]!.id}/resolve`,
        {
          keep: "mine",
          expected_revision: conflicted.revision,
        },
      );
      expect(resolved.status).toBe(200);
      const applied = await call("POST", `/v1/change-sets/${set.id}/apply`, {
        expected_revision: (resolved.body as { revision: number }).revision,
      });
      expect(applied).toMatchObject({ status: 200, body: { change_set: { status: "applied" } } });
      expect((applied.body as { deployment_ids: string[] }).deployment_ids.length).toBeGreaterThan(
        0,
      );
      expect(JSON.stringify(applied.body)).not.toContain(STAGED_VALUE);

      as("viewer");
      expect((await call("POST", `${ENV}/draft/ops`, { op: patch })).status).toBe(403);
      as(null);
      expect((await call("GET", `${ENV}/draft`)).status).toBe(401);
    });
  });

  it("canvas: explicit edges, resources on nodes, presence, volume and domain ops", async () => {
    await fresh(async () => {
      const ENV = `/v1/environments/${SEED.production}`;
      const CANVAS = `/v1/projects/${SEED.project}/canvas?environment_id=${SEED.production}`;
      const EDGES = `/v1/projects/${SEED.project}/edges`;
      const url = new URL(`/v1/projects/${SEED.project}/realtime`, window.location.origin);
      url.protocol = "ws:";
      const socket = new WebSocket(url);
      const received: { type: string; users?: { user_id: string; selection: string[] }[] }[] = [];
      socket.onmessage = (event) => received.push(JSON.parse(String(event.data)));
      await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));

      const edge = await call("POST", EDGES, {
        from_service_id: SEED.web,
        to_service_id: SEED.api,
      });
      expect(edge).toMatchObject({
        status: 201,
        body: { project_id: SEED.project, from_service_id: SEED.web, created_by: USERS.owner.id },
      });
      const edgeId = (edge.body as { id: string }).id;
      expect(edgeId).toMatch(/^edg_/);
      expect(db.audit.at(-1)).toMatchObject({ action: "canvas.edge_added" });
      expect(
        (await call("POST", EDGES, { from_service_id: SEED.web, to_service_id: SEED.api })).status,
      ).toBe(409);
      expect(
        (await call("POST", EDGES, { from_service_id: SEED.web, to_service_id: SEED.web })).status,
      ).toBe(400);
      expect(
        (await call("POST", EDGES, { from_service_id: SEED.web, to_service_id: "svc_nope" }))
          .status,
      ).toBe(404);
      expect(
        (
          await call("POST", "/v1/projects/prj_nope/edges", {
            from_service_id: SEED.web,
            to_service_id: SEED.api,
          })
        ).status,
      ).toBe(404);
      const canvas = await call("GET", CANVAS);
      const body = canvas.body as {
        environment_protected: boolean;
        edges: { id: string; kind: string }[];
        nodes: { id: string; database: unknown; volume: unknown; domains: unknown[] }[];
      };
      expect(body.environment_protected).toBe(
        db.deploy.environments.find((e) => e.id === SEED.production)!.protected,
      );
      expect(body.edges).toContainEqual({
        id: edgeId,
        from: SEED.web,
        to: SEED.api,
        kind: "explicit",
        variables: [],
        state: "current",
      });
      expect(body.nodes.find((n) => n.id === DATA_SEED.database)).toMatchObject({
        database: { engine: "postgres", version: "18" },
        volume: { id: DATA_SEED.volume, size_mb: 5120, status: "ready", staged: null },
        domains: [],
      });
      expect(body.nodes.find((n) => n.id === SEED.web)).toMatchObject({
        database: null,
        volume: null,
      });

      as("viewer");
      expect(
        (await call("POST", EDGES, { from_service_id: SEED.api, to_service_id: SEED.web })).status,
      ).toBe(403);
      expect((await call("DELETE", `${EDGES}/${edgeId}`)).status).toBe(403);
      as(null);
      expect((await call("DELETE", `${EDGES}/${edgeId}`)).status).toBe(401);
      as("owner");
      expect((await call("DELETE", `${EDGES}/${edgeId}`)).status).toBe(204);
      expect((await call("DELETE", `${EDGES}/${edgeId}`)).status).toBe(404);
      expect(
        ((await call("GET", CANVAS)).body as { edges: { kind: string }[] }).edges.filter(
          (e) => e.kind === "explicit",
        ),
      ).toEqual([]);

      // NOTE: Like the API, the socket takes only ID-shaped targets; the seeded
      // environment id (`env_store_prod`) isn't one, so this tab reports none.
      socket.send(
        JSON.stringify({
          type: "presence.update",
          environment_id: "env_notanid_",
          selection: [],
          editing: null,
        }),
      );
      socket.send(
        JSON.stringify({
          type: "presence.update",
          environment_id: null,
          selection: [SEED.api, "new:1"],
          editing: { service_id: SEED.api, part: "config" },
        }),
      );
      await expect
        .poll(() =>
          received.some(
            (m) =>
              m.type === "presence" &&
              m.users?.some((u) => u.user_id === USERS.owner.id && u.selection.includes(SEED.api)),
          ),
        )
        .toBe(true);
      expect(received.filter((m) => m.type === "presence")).toHaveLength(2);
      await expect
        .poll(() => received.filter((m) => m.type === "canvas.edges_updated").length)
        .toBe(2);
      socket.close();
      for (const message of received) {
        const result = RealtimeServerMessageSchema.safeParse(message);
        if (!result.success)
          failures.push(`realtime ${JSON.stringify(message)}: ${result.error.message}`);
      }

      const domain = await call("POST", `/v1/services/${SEED.web}/domains`, {
        environment_id: SEED.production,
        hostname: "shop.example.com",
      });
      const domainId = (domain.body as { id: string }).id;
      const stage = (op: Record<string, unknown>) => call("POST", `${ENV}/draft/ops`, { op });
      const added = await stage({
        type: "domain.add",
        service: SEED.web,
        hostname: "Docs.Example.com",
      });
      expect(added.status).toBe(200);
      expect((added.body as { changes: unknown[] }).changes).toContainEqual(
        expect.objectContaining({
          target_key: "domain:docs.example.com",
          diff: [
            {
              path: "/domains/docs.example.com",
              before: null,
              after: { hostname: "docs.example.com" },
            },
          ],
        }),
      );
      expect(
        await stage({ type: "domain.add", service: SEED.web, hostname: "shop.example.com" }),
      ).toMatchObject({ status: 409, body: { error: { code: "domain_taken" } } });
      expect(
        (await stage({ type: "domain.add", service: SEED.web, hostname: "not a host" })).status,
      ).toBe(400);
      expect((await stage({ type: "domain.remove", domain_id: "dom_nope" })).status).toBe(404);
      expect((await stage({ type: "domain.remove", domain_id: domainId })).status).toBe(200);
      const grow = await stage({ type: "volume.set", service: DATA_SEED.database, size_mb: 10240 });
      expect((grow.body as { changes: unknown[] }).changes).toContainEqual(
        expect.objectContaining({
          summary: "set postgres volume to 10240 MiB",
          diff: [{ path: "/volume/size_mb", before: 5120, after: 10240 }],
        }),
      );
      expect(
        (await stage({ type: "volume.set", service: DATA_SEED.database, size_mb: 5120 })).status,
      ).toBe(400);
      expect(
        (await stage({ type: "volume.set", service: SEED.worker, size_mb: 1024 })).status,
      ).toBe(400);
      const created = await stage({
        type: "volume.set",
        service: SEED.worker,
        mount_path: "/data",
        size_mb: 1024,
      });
      expect((created.body as { op_count: number }).op_count).toBe(4);
      const review = await call(
        "GET",
        `/v1/change-sets/${(created.body as { id: string }).id}/diff`,
      );
      expect((review.body as { deploys: unknown[] }).deploys).toContainEqual({
        service: SEED.worker,
        name: "worker",
        reason: "volume",
      });
      // Deleting a volume that is only staged takes the staged one out.
      expect(await stage({ type: "volume.delete", service: SEED.worker })).toMatchObject({
        status: 200,
        body: { op_count: 3 },
      });
      expect((await stage({ type: "volume.delete", service: SEED.worker })).status).toBe(404);
      const staged = (await call("GET", CANVAS)).body as {
        nodes: { id: string; volume: unknown; domains: unknown[]; staged: string | null }[];
      };
      expect(staged.nodes.find((n) => n.id === DATA_SEED.database)).toMatchObject({
        staged: "update",
        volume: { id: DATA_SEED.volume, staged: "resize", staged_size_mb: 10240 },
      });
      expect(staged.nodes.find((n) => n.id === SEED.web)?.domains).toEqual([
        { id: domainId, hostname: "shop.example.com", status: "pending_dns", staged: "remove" },
        { id: null, hostname: "docs.example.com", status: null, staged: "add" },
      ]);

      const draft = (await call("GET", `${ENV}/draft`)).body as {
        change_set: { id: string; revision: number };
      };
      const applied = await call("POST", `/v1/change-sets/${draft.change_set.id}/apply`, {
        expected_revision: draft.change_set.revision,
      });
      expect(applied).toMatchObject({ status: 200, body: { change_set: { status: "applied" } } });
      expect(db.data.volumes.find((v) => v.id === DATA_SEED.volume)?.size_mb).toBe(10240);
      expect(db.deploy.domains.map((d) => d.hostname)).toContain("docs.example.com");
      expect(db.deploy.domains.map((d) => d.hostname)).not.toContain("shop.example.com");
    });
  });

  it("change sets: submit, approve, reject, rebase, and the workspace review queue", async () => {
    await fresh(async () => {
      requireApprovalIn(SEED.production);
      const ENV = `/v1/environments/${SEED.production}`;
      const QUEUE = `${WS}/change-sets`;
      const secret = {
        type: "variable.set",
        scope: "service",
        service: SEED.api,
        key: "UPSTREAM_PASSWORD",
        value: STAGED_VALUE,
        tier: "secret",
        confirm_write_only: true,
      };
      const first = await call("POST", `${ENV}/draft/ops`, { op: secret });
      expect(first.status).toBe(200);
      const id = (first.body as { id: string }).id;
      const SET = `/v1/change-sets/${id}`;
      const revisionOf = async () =>
        ((await call("GET", SET)).body as { revision: number }).revision;

      expect(
        await call("POST", `${SET}/apply`, { expected_revision: await revisionOf() }),
      ).toMatchObject({ status: 403, body: { error: { code: "approval_required" } } });
      expect((await call("GET", `${SET}/diff`)).body).toMatchObject({
        approval: { required: true, approved: false, authors: [USERS.owner.id] },
      });
      expect(
        await call("GET", `/v1/projects/${SEED.project}/canvas?environment_id=${SEED.production}`),
      ).toMatchObject({
        status: 200,
        body: { environment_protected: true, environment_requires_approval: true },
      });

      as("viewer");
      expect((await call("POST", `${SET}/submit`, {})).status).toBe(403);
      as(null);
      expect((await call("POST", `${SET}/submit`, {})).status).toBe(401);
      as("owner");
      expect((await call("POST", `${SET}/submit`, { note: "" })).status).toBe(400);
      expect((await call("POST", "/v1/change-sets/chs_nope/submit", {})).status).toBe(404);
      expect((await call("POST", `${SET}/submit`, { expected_revision: 99 })).status).toBe(409);
      expect((await call("GET", `${QUEUE}?review=pending`)).body).toEqual({ change_sets: [] });
      const submitted = await call("POST", `${SET}/submit`, { note: "Rotates the upstream login" });
      expect(submitted).toMatchObject({
        status: 200,
        body: {
          review_status: "submitted",
          submitted_by: USERS.owner.id,
          review_note: "Rotates the upstream login",
        },
      });
      expect(db.audit.at(-1)).toMatchObject({ action: "change_set.submitted" });
      expect((await call("POST", `${SET}/submit`, {})).body).toMatchObject({
        review_status: "submitted",
        review_note: "Rotates the upstream login",
      });

      expect(await call("GET", `${QUEUE}?review=pending`)).toMatchObject({
        status: 200,
        body: {
          change_sets: [
            {
              id,
              project_name: "storefront",
              environment_name: "production",
              environment_requires_approval: true,
              review_status: "submitted",
            },
          ],
        },
      });
      expect((await call("GET", `${QUEUE}?review=bogus`)).status).toBe(400);
      expect((await call("GET", `${OTHER_WS}/change-sets`)).status).toBe(404);
      as(null);
      expect((await call("GET", QUEUE)).status).toBe(401);

      as("owner");
      const revision = await revisionOf();
      expect(await call("POST", `${SET}/approve`, { expected_revision: revision })).toMatchObject({
        status: 403,
        body: { error: { code: "self_review" } },
      });
      as("member");
      expect(await call("POST", `${SET}/approve`, { expected_revision: revision })).toMatchObject({
        status: 403,
        body: { error: { code: "forbidden" } },
      });
      as("admin");
      expect((await call("POST", `${SET}/approve`, {})).status).toBe(400);
      expect(
        (await call("POST", `${SET}/approve`, { expected_revision: revision + 1 })).status,
      ).toBe(409);
      const approved = await call("POST", `${SET}/approve`, {
        expected_revision: revision,
        note: "Looks right",
      });
      expect(approved).toMatchObject({
        status: 200,
        body: { review_status: "approved", approved_by: USERS.admin.id, revision },
      });
      expect((await call("GET", `${SET}/diff`)).body).toMatchObject({
        approval: { required: true, approved: true, authors: [USERS.owner.id] },
      });
      expect((await call("GET", `${QUEUE}?review=pending`)).body).toEqual({ change_sets: [] });
      expect(
        ((await call("GET", QUEUE)).body as { change_sets: { id: string }[] }).change_sets.map(
          (s) => s.id,
        ),
      ).toEqual([id]);
      expect(await call("POST", `${SET}/apply`, { expected_revision: revision })).toMatchObject({
        status: 403,
        body: { error: { code: "forbidden" } },
      });

      // Any edit voids the decision and asks for another review.
      as("owner");
      const edited = await call("POST", `${SET}/ops`, {
        op: { ...secret, value: STAGED_VALUE_TWO },
      });
      expect(edited).toMatchObject({
        status: 200,
        body: { review_status: "submitted", approved_by: null, approved_at: null },
      });
      as("admin");
      const rejected = await call("POST", `${SET}/reject`, {
        expected_revision: (edited.body as { revision: number }).revision,
        note: "Not this week",
      });
      expect(rejected).toMatchObject({
        status: 200,
        body: {
          review_status: "rejected",
          rejected_by: USERS.admin.id,
          review_note: "Not this week",
        },
      });
      expect(db.audit.at(-1)).toMatchObject({ action: "change_set.rejected" });
      as("owner");
      expect(
        await call("POST", `${SET}/apply`, {
          expected_revision: (rejected.body as { revision: number }).revision,
        }),
      ).toMatchObject({ status: 409, body: { error: { code: "change_set_rejected" } } });
      const resubmitted = await call("POST", `${SET}/submit`, {});
      expect(resubmitted).toMatchObject({
        status: 200,
        body: { review_status: "submitted", rejected_by: null },
      });
      as("admin");
      const again = await call("POST", `${SET}/approve`, {
        expected_revision: (resubmitted.body as { revision: number }).revision,
      });
      expect(again.status).toBe(200);
      as("owner");
      const applied = await call("POST", `${SET}/apply`, {
        expected_revision: (again.body as { revision: number }).revision,
      });
      expect(applied).toMatchObject({
        status: 200,
        body: { change_set: { status: "applied", review_status: "approved" } },
      });
      expect((await call("POST", `${SET}/submit`, {})).status).toBe(409);
      expect((await call("POST", `${SET}/approve`, { expected_revision: 1 })).status).toBe(409);
      expect((await call("POST", `${SET}/reject`, { expected_revision: 1 })).status).toBe(409);
      expect((await call("POST", `${SET}/rebase`, { expected_revision: 1 })).status).toBe(409);
      expect((await call("GET", QUEUE)).body).toEqual({ change_sets: [] });

      // An empty set has nothing to review.
      const empty = await call("POST", `${ENV}/change-sets`, { title: "Nothing yet" });
      const EMPTY = `/v1/change-sets/${(empty.body as { id: string }).id}`;
      expect((await call("POST", `${EMPTY}/submit`, {})).status).toBe(409);
      as("admin");
      expect((await call("POST", `${EMPTY}/reject`, { expected_revision: 1 })).status).toBe(409);
      expect((await call("POST", `${EMPTY}/reject`, {})).status).toBe(400);
      as("member");
      expect((await call("POST", `${EMPTY}/reject`, { expected_revision: 1 })).status).toBe(403);
      as(null);
      expect((await call("POST", `${EMPTY}/approve`, { expected_revision: 1 })).status).toBe(401);

      // Rebase: a disjoint direct edit rebases, an overlapping one conflicts.
      as("owner");
      const other = await call("POST", `${ENV}/change-sets`, {
        ops: [{ type: "config.patch", service: SEED.api, patch: { deploy: { replicas: 3 } } }],
      });
      const OTHER = `/v1/change-sets/${(other.body as { id: string }).id}`;
      const opId = (other.body as { changes: { id: string }[] }).changes[0]!.id;
      expect(await call("POST", `${OTHER}/rebase`, { expected_revision: 1 })).toMatchObject({
        status: 409,
        body: { error: { code: "change_set_changed" } },
      });
      expect(
        await call("POST", `${OTHER}/rebase`, {
          expected_revision: (other.body as { revision: number }).revision,
        }),
      ).toMatchObject({ status: 200, body: { rebased: [], conflicts: [] } });
      expect((await call("POST", `${OTHER}/rebase`, {})).status).toBe(400);
      expect(
        (await call("POST", "/v1/change-sets/chs_nope/rebase", { expected_revision: 1 })).status,
      ).toBe(404);
      await call("POST", `${OTHER}/submit`, {});
      as("admin");
      const approvedOther = await call("POST", `${OTHER}/approve`, {
        expected_revision: ((await call("GET", OTHER)).body as { revision: number }).revision,
      });
      expect(approvedOther.body).toMatchObject({ review_status: "approved" });
      const bump = (deploy: Record<string, unknown>) => {
        const latest = db.deploy.configs
          .filter((c) => c.service_id === SEED.api && c.environment_id === SEED.production)
          .sort((a, b) => b.version - a.version)[0]!;
        db.deploy.configs.push({
          ...latest,
          id: `cfg_direct_${latest.version + 1}`,
          version: latest.version + 1,
          deploy: { ...latest.deploy, ...deploy },
        });
      };
      bump({ drain_s: 45 });
      as("viewer");
      expect((await call("POST", `${OTHER}/rebase`, { expected_revision: 1 })).status).toBe(403);
      as("owner");
      const rebased = await call("POST", `${OTHER}/rebase`, {
        expected_revision: ((await call("GET", OTHER)).body as { revision: number }).revision,
      });
      expect(rebased).toMatchObject({
        status: 200,
        body: { rebased: [opId], conflicts: [], change_set: { review_status: "submitted" } },
      });
      bump({ replicas: 5 });
      const conflicted = await call("POST", `${OTHER}/rebase`, {
        expected_revision: (rebased.body as { change_set: { revision: number } }).change_set
          .revision,
      });
      expect(conflicted).toMatchObject({
        status: 200,
        body: {
          rebased: [],
          conflicts: [{ id: opId, conflict: { paths: ["/deploy/replicas"] } }],
          change_set: { conflicted_count: 1 },
        },
      });
    });
  });

  it("never returns a staged secret value", () => {
    for (const text of responseTexts) {
      expect(text).not.toContain(STAGED_VALUE);
      expect(text).not.toContain(STAGED_VALUE_TWO);
    }
    expect(responseTexts.length).toBeGreaterThan(0);
  });

  it("databases: add one, then read, grow, delete and undelete its volume", async () => {
    await fresh(async () => {
      const add = `/v1/projects/${SEED.project}/databases`;
      const body = { engine: "postgres", environment_id: SEED.production };
      expect((await call("POST", add, { ...body, engine: "oracle" })).status).toBe(400);
      expect((await call("POST", add, { ...body, size_mb: 10 })).status).toBe(400);
      as(null);
      expect((await call("POST", add, body)).status).toBe(401);
      as("viewer");
      expect((await call("POST", add, body)).status).toBe(403);
      as("owner");
      expect((await call("POST", "/v1/projects/prj_nope/databases", body)).status).toBe(404);
      expect((await call("POST", add, { ...body, environment_id: "env_nope" })).status).toBe(404);
      expect((await call("POST", add, { ...body, version: "9" })).status).toBe(404);
      const created = await call("POST", add, { ...body, engine: "redis", size_mb: 1024 });
      expect(created).toMatchObject({
        status: 201,
        body: {
          service: {
            kind: "database",
            slug: "valkey",
            database: { engine: "redis", version: "valkey-9" },
          },
          version: "valkey-9",
          volumes: [{ size_mb: 1024, status: "pending", mount_path: "/data" }],
          variables: expect.arrayContaining([{ key: "REDIS_URL", secret: true }]),
        },
      });
      expect((created.body as { deployment_ids: string[] }).deployment_ids).toHaveLength(1);
      const quiet = await call("POST", add, { ...body, name: "Cache", deploy: false });
      expect(quiet.body).toMatchObject({ service: { slug: "cache" }, deployment_ids: [] });

      const env = `environment_id=${SEED.production}`;
      const volumeUrl = `/v1/services/${DATA_SEED.database}/volume?${env}`;
      expect((await call("GET", volumeUrl)).body).toMatchObject({
        id: DATA_SEED.volume,
        status: "ready",
        quota_mode: "xfs_project",
      });
      expect((await call("GET", `/v1/services/${SEED.web}/volume?${env}`)).status).toBe(404);
      expect((await call("GET", `/v1/services/svc_nope/volume?${env}`)).status).toBe(404);
      const otherEnv = `/v1/services/${DATA_SEED.database}/volume?environment_id=env_nope`;
      expect((await call("GET", otherEnv)).status).toBe(404);

      const volume = `/v1/volumes/${DATA_SEED.volume}`;
      expect((await call("PATCH", volume, { size_mb: 1 })).status).toBe(400);
      expect(await call("PATCH", volume, { size_mb: 4096 })).toMatchObject({
        status: 422,
        body: { error: { code: "volume_shrink_unsupported" } },
      });
      expect((await call("PATCH", "/v1/volumes/vol_nope", { size_mb: 8192 })).status).toBe(404);
      as("viewer");
      expect((await call("PATCH", volume, { size_mb: 8192 })).status).toBe(403);
      expect((await call("DELETE", volume)).status).toBe(403);
      expect((await call("POST", `${volume}/undelete`)).status).toBe(403);
      as("member");
      expect(await call("PATCH", volume, { size_mb: 8192 })).toMatchObject({
        status: 200,
        body: { size_mb: 8192 },
      });
      expect((await call("POST", `${volume}/undelete`)).status).toBe(409);
      expect(await call("DELETE", volume)).toMatchObject({
        status: 409,
        body: { error: { message: expect.stringContaining("still runs") } },
      });
      for (const row of db.deploy.deployments) {
        if (row.service_id === DATA_SEED.database) row.status = "removed";
      }
      expect(await call("DELETE", volume)).toMatchObject({
        status: 200,
        body: { status: "pending_deletion", delete_after: expect.any(Number) },
      });
      expect((await call("GET", volumeUrl)).body).toMatchObject({ status: "pending_deletion" });
      expect((await call("PATCH", volume, { size_mb: 9000 })).status).toBe(409);
      expect((await call("DELETE", volume)).status).toBe(409);
      expect(await call("POST", `${volume}/undelete`)).toMatchObject({
        status: 200,
        body: { status: "ready", delete_after: null },
      });
      expect((await call("POST", "/v1/volumes/vol_nope/undelete")).status).toBe(404);
      expect((await call("DELETE", "/v1/volumes/vol_nope")).status).toBe(404);
      as(null);
      expect((await call("GET", volumeUrl)).status).toBe(401);
      expect((await call("DELETE", volume)).status).toBe(401);
      expect(db.audit.map((row) => row.action)).toEqual(
        expect.arrayContaining(["volume.resized", "volume.deleted", "volume.undeleted"]),
      );
    });
  });

  it("data browser: schema, rows, raw reads, and its refusals", async () => {
    await fresh(async () => {
      const env = `environment_id=${SEED.production}`;
      const schema = `/v1/services/${DATA_SEED.database}/database/schema?${env}`;
      expect(await call("GET", schema)).toMatchObject({
        status: 200,
        body: {
          engine: "postgres",
          version: "18",
          namespaces: {
            ok: true,
            rows: [
              ["audit", "postgres"],
              ["public", "postgres"],
            ],
          },
        },
      });
      const notDb = `/v1/services/${SEED.web}/database/schema?${env}`;
      expect((await call("GET", notDb)).status).toBe(409);
      const query = `/v1/services/${DATA_SEED.database}/database/query`;
      const base = { environment_id: SEED.production };
      const run = (op: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
        call("POST", query, { ...base, op, ...extra });
      expect((await run({ type: "drop" })).status).toBe(400);
      expect((await run({ type: "provision_readonly" })).status).toBe(400);
      expect((await run({ type: "raw", statement: "x", argv: ["x"] })).status).toBe(400);
      expect((await run({ type: "list_tables", namespace: "public" })).body).toMatchObject({
        ok: true,
        rows: [
          ["customers", "table", "240"],
          ["orders", "table", "12"],
        ],
      });
      const offset200 = { type: "rows", namespace: "public", table: "customers", offset: 200 };
      expect((await run(offset200)).body).toMatchObject({
        ok: true,
        row_count: 40,
        truncated: false,
      });
      expect((await run({ type: "rows", table: "customers", offset: 0 })).body).toMatchObject({
        row_count: 100,
        truncated: true,
      });
      expect(
        (await run({ type: "describe", namespace: "public", table: "orders" })).body,
      ).toMatchObject({ ok: true, row_count: 4 });
      expect((await run({ type: "rows", table: "nope", offset: 0 })).body).toMatchObject({
        ok: false,
        error: expect.stringContaining("does not exist"),
      });
      const raw = await run(
        { type: "raw", statement: "SELECT * FROM public.orders" },
        {
          max_rows: 5,
        },
      );
      expect(raw.body).toMatchObject({ ok: true, row_count: 5, truncated: true });
      expect((await run({ type: "raw", statement: "DELETE FROM orders" })).body).toMatchObject({
        ok: false,
        error: "cannot execute DELETE in a read-only transaction",
      });
      expect(db.audit.filter((row) => row.action === "database.query_executed")).toHaveLength(2);
      expect(db.audit.some((row) => row.action === "database.browser_opened")).toBe(true);

      as("member");
      expect((await run({ type: "list_namespaces" }, { mode: "write" })).status).toBe(403);
      as("admin");
      db.data.knobs.reauthRequired = true;
      expect(await run({ type: "list_namespaces" }, { mode: "write" })).toMatchObject({
        status: 403,
        body: { error: { code: "reauth_required" } },
      });
      db.data.knobs.reauthRequired = false;
      as("viewer");
      expect((await call("GET", schema)).status).toBe(403);
      expect((await run({ type: "list_namespaces" })).status).toBe(403);
      as("owner");
      db.data.knobs.offline.add(DATA_SEED.database);
      expect(await call("GET", schema)).toMatchObject({
        status: 503,
        body: { error: { code: "node_offline" } },
      });
      db.data.knobs.offline.clear();
      for (const row of db.deploy.deployments) {
        if (row.service_id === DATA_SEED.database) row.status = "removed";
      }
      expect((await run({ type: "list_namespaces" })).status).toBe(409);
      expect((await call("GET", `/v1/services/svc_nope/database/schema?${env}`)).status).toBe(404);
      expect(
        (await call("POST", query, { environment_id: "env_nope", op: { type: "list_namespaces" } }))
          .status,
      ).toBe(404);
      as(null);
      expect((await call("GET", schema)).status).toBe(401);
      expect((await run({ type: "list_namespaces" })).status).toBe(401);
    });
  });

  it("backups: policy, list, back up now, download, key, delete", async () => {
    await fresh(async () => {
      const env = `environment_id=${SEED.production}`;
      const svc = `/v1/services/${DATA_SEED.database}`;
      expect(await call("GET", `${svc}/backup-policy?${env}`)).toMatchObject({
        status: 200,
        body: {
          enabled: true,
          schedule: "0 3 * * *",
          method: "dump",
          next_runs: [expect.any(Number), expect.any(Number), expect.any(Number)],
        },
      });
      const appPolicy = await call("GET", `/v1/services/${SEED.web}/backup-policy?${env}`);
      expect(appPolicy.body).toMatchObject({
        id: null,
        enabled: false,
        method: "snapshot",
        next_runs: [],
      });
      expect((await call("GET", `${svc}/backup-policy?environment_id=env_nope`)).status).toBe(404);
      const put = (body: Record<string, unknown>, service = svc) =>
        call("PUT", `${service}/backup-policy`, { environment_id: SEED.production, ...body });
      expect((await put({ schedule: "every day" })).status).toBe(400);
      expect((await put({ keep_last: 0 })).status).toBe(400);
      expect((await put({ quiesce: "stop" })).status).toBe(422);
      expect((await put({ enabled: true }, `/v1/services/${SEED.web}`)).status).toBe(409);
      expect(
        await put({ schedule: "30 2 * * 1", keep_last: 14, max_age_days: null }),
      ).toMatchObject({
        status: 200,
        body: { schedule: "30 2 * * 1", keep_last: 14, max_age_days: null },
      });
      const backUp = (service = svc) =>
        call("POST", `${service}/backups`, { environment_id: SEED.production });
      as("viewer");
      expect((await put({ enabled: false })).status).toBe(403);
      expect((await backUp()).status).toBe(403);
      as("owner");

      const list = await call("GET", `${svc}/backups?${env}`);
      const backups = (list.body as { backups: { id: string }[] }).backups;
      expect(backups.map((row) => row.id)).toEqual([
        DATA_SEED.manualBackup,
        DATA_SEED.failedBackup,
        DATA_SEED.scheduledBackup,
        DATA_SEED.oldBackup,
      ]);
      expect((await call("GET", `${svc}/backups?${env}&limit=2`)).body).toMatchObject({
        next_cursor: DATA_SEED.failedBackup,
      });
      const next = `${svc}/backups?${env}&limit=2&cursor=${DATA_SEED.failedBackup}`;
      expect((await call("GET", next)).body).toMatchObject({
        backups: [{ id: DATA_SEED.scheduledBackup }, { id: DATA_SEED.oldBackup }],
        next_cursor: null,
      });
      expect((await call("GET", `${svc}/backups?environment_id=env_nope`)).status).toBe(404);

      const now = await backUp();
      expect(now).toMatchObject({
        status: 202,
        body: { status: "queued", trigger: "manual", pinned: true },
      });
      const id = (now.body as { id: string }).id;
      expect((await call("GET", `/v1/backups/${id}`)).body).toMatchObject({ status: "running" });
      expect((await call("DELETE", `/v1/backups/${id}`)).status).toBe(409);
      expect((await call("GET", `/v1/backups/${id}/download`)).status).toBe(409);
      expect((await call("GET", `/v1/backups/${id}`)).body).toMatchObject({ status: "succeeded" });
      expect((await call("GET", "/v1/backups/bak_nope")).status).toBe(404);
      expect((await backUp(`/v1/services/${SEED.web}`)).status).toBe(409);

      const download = `/v1/backups/${DATA_SEED.manualBackup}/download`;
      const key = `/v1/backups/${DATA_SEED.manualBackup}/decryption-key`;
      expect(await call("GET", download)).toMatchObject({
        status: 200,
        body: { filename: `${DATA_SEED.manualBackup}.rhbk.zst.age` },
      });
      as("member");
      expect((await call("GET", download)).status).toBe(403);
      expect((await call("POST", key)).status).toBe(403);
      as("owner");
      db.data.knobs.reauthRequired = true;
      expect(await call("POST", key)).toMatchObject({
        status: 403,
        body: { error: { code: "reauth_required" } },
      });
      db.data.knobs.reauthRequired = false;
      expect(await call("POST", key)).toMatchObject({
        status: 200,
        body: {
          identity: expect.stringMatching(/^AGE-SECRET-KEY-1/),
          recipient: expect.stringMatching(/^age1/),
        },
      });
      expect((await call("POST", "/v1/backups/bak_nope/decryption-key")).status).toBe(404);

      expect((await call("DELETE", `/v1/backups/${DATA_SEED.oldBackup}`)).status).toBe(204);
      expect((await call("DELETE", `/v1/backups/${DATA_SEED.oldBackup}`)).status).toBe(204);
      expect((await call("DELETE", "/v1/backups/bak_nope")).status).toBe(404);

      db.data.storage = null;
      expect(await backUp()).toMatchObject({
        status: 409,
        body: { error: { code: "backup_storage_not_configured" } },
      });
      expect((await put({ enabled: true })).status).toBe(409);
      expect((await put({ enabled: false })).status).toBe(200);
      expect((await call("GET", download)).status).toBe(409);
      as(null);
      expect((await call("GET", `${svc}/backups?${env}`)).status).toBe(401);
      expect((await call("GET", `${svc}/backup-policy?${env}`)).status).toBe(401);
      expect((await call("GET", `/v1/backups/${DATA_SEED.manualBackup}`)).status).toBe(401);
    });
  });

  it("restores: typed slug, fresh session, in place with a safety backup", async () => {
    await fresh(async () => {
      const restore = (backupId: string, body: Record<string, unknown>) =>
        call("POST", `/v1/backups/${backupId}/restore`, body);
      const inPlace = { mode: "in_place", confirm: DATA_SEED.databaseSlug };
      const good = DATA_SEED.scheduledBackup;
      expect((await restore(good, { mode: "elsewhere", confirm: "x" })).status).toBe(400);
      expect((await restore(good, { ...inPlace, confirm: "web" })).status).toBe(400);
      expect((await restore(DATA_SEED.failedBackup, inPlace)).status).toBe(409);
      expect((await restore("bak_nope", inPlace)).status).toBe(404);
      as("member");
      expect((await restore(good, inPlace)).status).toBe(403);
      as("owner");
      db.data.knobs.reauthRequired = true;
      expect(await restore(good, inPlace)).toMatchObject({
        status: 403,
        body: { error: { code: "reauth_required" } },
      });
      db.data.knobs.reauthRequired = false;
      const started = await restore(good, inPlace);
      expect(started).toMatchObject({
        status: 202,
        body: { mode: "in_place", status: "queued", safety_backup_id: expect.any(String) },
      });
      const restoreId = (started.body as { id: string }).id;
      expect((await restore(good, inPlace)).status).toBe(409);
      expect((await call("DELETE", `/v1/backups/${good}`)).status).toBe(409);
      const read = () => call("GET", `/v1/restores/${restoreId}`);
      expect((await read()).body).toMatchObject({ status: "running" });
      expect((await read()).body).toMatchObject({ status: "succeeded" });
      expect((await call("GET", "/v1/restores/rst_nope")).status).toBe(404);
      as(null);
      expect((await read()).status).toBe(401);
      expect((await restore(good, inPlace)).status).toBe(401);
    });
  });

  it("restores into a new service: default slug, chosen slug, dumps only", async () => {
    await fresh(async () => {
      const restore = (backupId: string, body: Record<string, unknown>) =>
        call("POST", `/v1/backups/${backupId}/restore`, body);
      const copy = { mode: "new_service", confirm: DATA_SEED.databaseSlug };
      const good = DATA_SEED.scheduledBackup;
      expect((await restore(good, { ...copy, slug: "Not A Slug" })).status).toBe(400);
      expect((await restore(good, { ...copy, target_environment_id: "env_nope" })).status).toBe(
        404,
      );
      expect((await restore(DATA_SEED.failedBackup, copy)).status).toBe(409);
      const backup = db.data.backups.find((row) => row.id === good)!;
      backup.method = "snapshot";
      expect(await restore(good, copy)).toMatchObject({
        status: 422,
        body: { error: { code: "restore_mode_unsupported" } },
      });
      backup.method = "dump";
      as("member");
      expect((await restore(good, copy)).status).toBe(403);
      as("owner");
      db.data.knobs.reauthRequired = true;
      expect(await restore(good, copy)).toMatchObject({
        status: 403,
        body: { error: { code: "reauth_required" } },
      });
      db.data.knobs.reauthRequired = false;
      const storage = db.data.storage;
      db.data.storage = null;
      expect((await restore(good, copy)).status).toBe(409);
      db.data.storage = storage;

      const started = await restore(good, copy);
      expect(started).toMatchObject({
        status: 202,
        body: {
          mode: "new_service",
          status: "queued",
          safety_backup_id: null,
          target_environment_id: SEED.production,
        },
      });
      const { id, target_service_id } = started.body as { id: string; target_service_id: string };
      const created = db.deploy.services.find((row) => row.id === target_service_id)!;
      expect(created).toMatchObject({
        kind: "database",
        slug: expect.stringMatching(/^postgres-restore-\d{8}$/),
        database: { engine: "postgres", version: "18" },
      });
      expect(db.data.volumes.some((row) => row.service_id === created.id)).toBe(true);
      const named = await restore(good, { ...copy, slug: "pg-copy" });
      expect(named.status).toBe(202);
      expect(
        db.deploy.services.find(
          (row) => row.id === (named.body as { target_service_id: string }).target_service_id,
        )?.slug,
      ).toBe("pg-copy");
      expect((await call("GET", `/v1/restores/${id}`)).body).toMatchObject({ status: "running" });
      expect((await call("GET", `/v1/restores/${id}`)).body).toMatchObject({
        status: "succeeded",
        target_service_id,
      });
      as(null);
      expect((await restore(good, copy)).status).toBe(401);
    });
  });

  it("volume moves: targets, typed slug, fresh session, phases to done or rolled back", async () => {
    await fresh(async () => {
      db.nodes.push({
        ...makeNode({ id: "node_nbg1", name: "nbg-1", hostname: "nbg-1.example.com" }),
        workspace_id: WORKSPACE_ID,
      });
      const vol = `/v1/volumes/${DATA_SEED.volume}`;
      const targets = await call("GET", `${vol}/migration-targets`);
      expect(targets).toMatchObject({
        status: 200,
        body: { source_node_id: "node_hel1", estimated_downtime_ms: expect.any(Number) },
      });
      expect((targets.body as { targets: unknown[] }).targets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            node_id: "node_hel1",
            eligible: false,
            reason: "It already holds the volume",
          }),
          expect.objectContaining({ node_id: "node_fsn1", eligible: false }),
          expect.objectContaining({ node_id: "node_nbg1", eligible: true, reason: null }),
        ]),
      );
      expect((await call("GET", "/v1/volumes/vol_nope/migration-targets")).status).toBe(404);

      const migrate = (body: Record<string, unknown>) => call("POST", `${vol}/migrate`, body);
      const good = { target_node_id: "node_nbg1", confirm: DATA_SEED.databaseSlug };
      expect((await migrate({ target_node_id: "node_nbg1" })).status).toBe(400);
      expect((await migrate({ ...good, confirm: "web" })).status).toBe(400);
      expect(await migrate({ ...good, target_node_id: "node_fsn1" })).toMatchObject({
        status: 422,
        body: { error: { code: "migration_target_ineligible" } },
      });
      expect((await migrate({ ...good, target_node_id: "node_nope" })).status).toBe(404);
      expect((await call("POST", "/v1/volumes/vol_nope/migrate", good)).status).toBe(404);
      as("viewer");
      expect((await migrate(good)).status).toBe(403);
      as("owner");
      db.data.knobs.reauthRequired = true;
      expect(await migrate(good)).toMatchObject({
        status: 403,
        body: { error: { code: "reauth_required" } },
      });
      db.data.knobs.reauthRequired = false;
      const storage = db.data.storage;
      db.data.storage = null;
      expect((await migrate(good)).status).toBe(409);
      db.data.storage = storage;

      const started = await migrate(good);
      expect(started).toMatchObject({
        status: 202,
        body: {
          status: "queued",
          phase: "queued",
          source_node_id: "node_hel1",
          target_node_id: "node_nbg1",
        },
      });
      const id = (started.body as { id: string }).id;
      const volume = `/v1/services/${DATA_SEED.database}/volume?environment_id=${SEED.production}`;
      expect((await call("GET", volume)).body).toMatchObject({ status: "migrating" });
      expect((await migrate(good)).status).toBe(409);
      const read = async () => (await call("GET", `/v1/volume-migrations/${id}`)).body;
      for (const phase of ["preparing_target", "stopping", "copying_out", "copying_in"]) {
        expect(await read()).toMatchObject({ status: "running", phase });
      }
      expect(await read()).toMatchObject({ phase: "starting", backup_id: expect.any(String) });
      expect(await read()).toMatchObject({
        status: "succeeded",
        phase: "done",
        cleanup_after: expect.any(Number),
      });
      expect((await call("GET", volume)).body).toMatchObject({
        status: "ready",
        node_id: "node_nbg1",
        node_name: "nbg-1",
      });

      db.data.knobs.failMigrations = true;
      const back = await migrate({ ...good, target_node_id: "node_hel1" });
      expect(back.status).toBe(202);
      const backId = (back.body as { id: string }).id;
      const readBack = async () => (await call("GET", `/v1/volume-migrations/${backId}`)).body;
      for (const phase of ["preparing_target", "stopping", "copying_out", "rolling_back"]) {
        expect(await readBack()).toMatchObject({ phase });
      }
      expect(await readBack()).toMatchObject({ status: "failed", error: expect.any(String) });
      expect((await call("GET", volume)).body).toMatchObject({
        status: "ready",
        node_id: "node_nbg1",
      });
      expect((await call("GET", `${vol}/migrations`)).body).toMatchObject({
        migrations: [
          { id: backId, status: "failed" },
          { id, status: "succeeded" },
        ],
      });
      expect((await call("GET", "/v1/volumes/vol_nope/migrations")).status).toBe(404);
      expect((await call("GET", "/v1/volume-migrations/mig_nope")).status).toBe(404);
      as(null);
      expect((await call("GET", `${vol}/migration-targets`)).status).toBe(401);
      expect((await call("GET", `${vol}/migrations`)).status).toBe(401);
      expect((await call("GET", `/v1/volume-migrations/${id}`)).status).toBe(401);
      expect((await migrate(good)).status).toBe(401);
    });
  });

  it("TCP proxies: allowlist checks, acknowledgement, status, fresh session, removal", async () => {
    await fresh(async () => {
      const path = `/v1/services/${DATA_SEED.database}/tcp-proxies`;
      const env = `environment_id=${SEED.production}`;
      const put = (body: Record<string, unknown>, service = path) =>
        call("PUT", service, { environment_id: SEED.production, ...body });
      expect((await call("GET", `${path}?${env}`)).status).toBe(404);
      expect((await call("GET", `${path}?environment_id=env_nope`)).status).toBe(404);
      expect((await put({ allowed_cidrs: [] })).status).toBe(400);
      expect(await put({ allowed_cidrs: ["not-an-address", "10.0.0.1"] })).toMatchObject({
        status: 422,
        body: {
          error: {
            code: "invalid_request",
            details: [{ field: "allowed_cidrs", message: "not-an-address" }],
          },
        },
      });
      expect(await put({ allowed_cidrs: ["0.0.0.0/0"] })).toMatchObject({
        status: 422,
        body: { error: { code: "confirmation_required" } },
      });
      expect(
        (await put({ allowed_cidrs: ["10.0.0.1"] }, `/v1/services/${SEED.api}/tcp-proxies`)).status,
      ).toBe(422);
      as("viewer");
      expect((await put({ allowed_cidrs: ["10.0.0.1"] })).status).toBe(403);
      as("owner");
      db.data.knobs.reauthRequired = true;
      expect(await put({ allowed_cidrs: ["10.0.0.1"] })).toMatchObject({
        status: 403,
        body: { error: { code: "reauth_required" } },
      });
      db.data.knobs.reauthRequired = false;

      const enabled = await put({ allowed_cidrs: ["203.0.113.7", "10.1.2.3/8", "2001:DB8::/48"] });
      expect(enabled).toMatchObject({
        status: 200,
        body: {
          status: "active",
          host: "hel-1.example.com",
          allowed_cidrs: ["203.0.113.7/32", "10.0.0.0/8", "2001:db8::/48"],
          open_to_all: false,
          container_port: 5432,
        },
      });
      const port = (enabled.body as { public_port: number }).public_port;
      expect(await put({ allowed_cidrs: ["::/0"], acknowledge_open: true })).toMatchObject({
        status: 200,
        body: { allowed_cidrs: ["::/0"], open_to_all: true, public_port: port },
      });
      db.data.knobs.tcpProxyUnsupported = true;
      expect((await call("GET", `${path}?${env}`)).body).toMatchObject({ status: "unsupported" });
      expect(await put({ allowed_cidrs: ["10.0.0.1"] })).toMatchObject({
        status: 409,
        body: { error: { code: "tcp_proxy_unsupported" } },
      });
      db.data.knobs.tcpProxyUnsupported = false;
      for (const row of db.deploy.deployments) {
        if (row.service_id === DATA_SEED.database) row.status = "removed";
      }
      expect((await call("GET", `${path}?${env}`)).body).toMatchObject({
        status: "pending",
        host: null,
        node_id: null,
      });

      as("viewer");
      expect((await call("GET", `${path}?${env}`)).status).toBe(200);
      expect((await call("DELETE", `${path}?${env}`)).status).toBe(403);
      as("owner");
      expect((await call("DELETE", `${path}?environment_id=env_nope`)).status).toBe(404);
      expect((await call("DELETE", `${path}?${env}`)).status).toBe(204);
      expect((await call("DELETE", `${path}?${env}`)).status).toBe(404);
      as(null);
      expect((await call("GET", `${path}?${env}`)).status).toBe(401);
      expect((await put({ allowed_cidrs: ["10.0.0.1"] })).status).toBe(401);
      expect((await call("DELETE", `${path}?${env}`)).status).toBe(401);
    });
  });

  it("credential rotations: principals per engine, interrupted then finished", async () => {
    await fresh(async () => {
      const svc = `/v1/services/${DATA_SEED.database}/database`;
      const list = `${svc}/credential-rotations?environment_id=${SEED.production}`;
      const rotate = (body: Record<string, unknown> = {}, path = `${svc}/rotate-credentials`) =>
        call("POST", path, {
          environment_id: SEED.production,
          confirm: DATA_SEED.databaseSlug,
          ...body,
        });
      expect(await call("GET", list)).toMatchObject({ status: 200, body: { rotations: [] } });
      expect(
        (await call("GET", `${svc}/credential-rotations?environment_id=env_nope`)).status,
      ).toBe(404);
      expect((await rotate({ confirm: "web" })).status).toBe(400);
      expect((await rotate({ principals: ["root"] })).status).toBe(400);
      expect((await rotate({ principals: ["app"] })).status).toBe(422);
      expect((await rotate({ environment_id: "env_nope" })).status).toBe(404);
      expect((await rotate({}, "/v1/services/svc_nope/database/rotate-credentials")).status).toBe(
        404,
      );
      expect(
        (await rotate({ confirm: "web" }, `/v1/services/${SEED.web}/database/rotate-credentials`))
          .status,
      ).toBe(409);
      as("member");
      expect((await rotate()).status).toBe(403);
      as("owner");
      db.data.knobs.reauthRequired = true;
      expect(await rotate()).toMatchObject({
        status: 403,
        body: { error: { code: "reauth_required" } },
      });
      db.data.knobs.reauthRequired = false;
      db.data.knobs.offline.add(DATA_SEED.database);
      expect((await rotate()).status).toBe(503);
      db.data.knobs.offline.clear();

      db.data.knobs.interruptRotation = true;
      expect(await rotate()).toMatchObject({
        status: 504,
        body: { error: { code: "query_timeout" } },
      });
      expect((await call("GET", list)).body).toMatchObject({
        rotations: [
          { status: "running", principals: ["readonly", "admin"], applied: ["readonly"] },
        ],
      });
      const finished = await rotate({ principals: ["admin"] });
      expect(finished).toMatchObject({
        status: 200,
        body: {
          status: "succeeded",
          principals: ["readonly", "admin"],
          applied: ["readonly", "admin"],
          change_set_id: expect.any(String),
          error: null,
        },
      });
      expect((finished.body as { deployment_ids: string[] }).deployment_ids.length).toBeGreaterThan(
        0,
      );
      expect((await rotate({ principals: ["admin"] })).body).toMatchObject({
        status: "succeeded",
        principals: ["admin"],
      });
      expect((await call("GET", list)).body).toMatchObject({
        rotations: [{ principals: ["admin"] }, { id: (finished.body as { id: string }).id }],
      });
      for (const row of db.deploy.deployments) {
        if (row.service_id === DATA_SEED.database) row.status = "removed";
      }
      expect((await rotate()).status).toBe(409);
      as(null);
      expect((await rotate()).status).toBe(401);
      expect((await call("GET", list)).status).toBe(401);
    });
  });

  it("backup storage: instance admins only, write-only secret, reachability", async () => {
    await fresh(async () => {
      const storage = "/v1/instance/backup-storage";
      const view = await call("GET", storage);
      expect(view).toMatchObject({
        status: 200,
        body: { configured: true, bucket: "roundhouse-backups", secret_access_key_set: true },
      });
      expect(JSON.stringify(view.body)).not.toContain("mock-secret-access-key");
      const body = {
        endpoint: "https://s3.example.com",
        bucket: "acme-backups",
        access_key_id: "AKIANEW",
      };
      expect((await call("PUT", storage, { ...body, bucket: "Bad_Bucket" })).status).toBe(400);
      const plain = { ...body, endpoint: "http://s3.example.com" };
      expect((await call("PUT", storage, plain)).status).toBe(400);
      expect(await call("PUT", storage, { ...body, bucket: "unreachable-bucket" })).toMatchObject({
        status: 422,
        body: { error: { code: "backup_storage_unreachable" } },
      });
      db.data.knobs.reauthRequired = true;
      expect((await call("PUT", storage, body)).status).toBe(403);
      db.data.knobs.reauthRequired = false;
      expect(await call("PUT", storage, body)).toMatchObject({
        status: 200,
        body: { bucket: "acme-backups", region: "auto", secret_access_key_set: true },
      });
      expect(db.data.storage?.secret_access_key).toBe("mock-secret-access-key");
      db.data.storage = null;
      expect((await call("PUT", storage, body)).status).toBe(400);
      const withSecret = { ...body, secret_access_key: "s3cr3t" };
      expect((await call("PUT", storage, withSecret)).status).toBe(200);
      as("admin");
      expect((await call("GET", storage)).status).toBe(403);
      expect((await call("PUT", storage, body)).status).toBe(403);
      as(null);
      expect((await call("GET", storage)).status).toBe(401);
    });
  });

  it("ADR 0014 access: settings, effective access, teams, grants, protection", async () => {
    await fresh(async () => {
      const settings = `${WS}/access-settings`;
      expect(await call("GET", settings)).toMatchObject({
        status: 200,
        body: { member_default_project_role: "developer", viewer_default_project_role: "viewer" },
      });
      expect((await call("PATCH", settings, {})).status).toBe(400);
      db.sessionStale = true;
      expect(
        await call("PATCH", settings, { member_default_project_role: "viewer" }),
      ).toMatchObject({ status: 403, body: { error: { code: "reauth_required" } } });
      db.sessionStale = false;
      expect(
        await call("PATCH", settings, { member_default_project_role: "deployer" }),
      ).toMatchObject({ status: 200, body: { member_default_project_role: "deployer" } });

      expect(await call("GET", `${WS}/access/me`)).toMatchObject({
        status: 200,
        body: { workspace_role: "owner", instance_admin: true },
      });
      as("member");
      const member = (await call("GET", `${WS}/access/me`)).body as {
        projects: { project_id: string; role: string; actions: string[] }[];
      };
      const store = member.projects.find((p) => p.project_id === SEED.project);
      expect(store?.role).toBe("deployer");
      expect(store?.actions).not.toContain("variables:manage");
      expect((await call("GET", `${OTHER_WS}/access/me`)).status).toBe(404);
      expect((await call("PATCH", settings, { viewer_default_project_role: "none" })).status).toBe(
        403,
      );

      const teams = `${WS}/teams`;
      expect(await call("GET", teams)).toMatchObject({
        status: 200,
        body: { teams: [{ id: ACCESS_SEED.platformTeam, member_count: 2 }] },
      });
      expect((await call("POST", teams, { name: "Ops" })).status).toBe(403);
      as("owner");
      expect((await call("POST", teams, { name: "" })).status).toBe(400);
      expect((await call("POST", teams, { name: "Ops", user_ids: ["usr_nobody"] })).status).toBe(
        400,
      );
      expect((await call("POST", teams, { name: "Platform" })).status).toBe(409);
      const created = await call("POST", teams, {
        name: "Ops",
        description: "On call",
        user_ids: [USERS.viewer.id],
      });
      expect(created).toMatchObject({
        status: 201,
        body: { slug: "ops", member_count: 1, members: [{ user_id: USERS.viewer.id }] },
      });
      const teamId = (created.body as { id: string }).id;
      const team = `/v1/teams/${teamId}`;
      expect((await call("GET", team)).status).toBe(200);
      expect((await call("GET", "/v1/teams/team_nope")).status).toBe(404);
      expect((await call("PATCH", team, {})).status).toBe(400);
      expect((await call("PATCH", team, { slug: "platform" })).status).toBe(409);
      expect(await call("PATCH", team, { name: "Operations" })).toMatchObject({
        status: 200,
        body: { name: "Operations", member_count: 1 },
      });
      expect((await call("PUT", `${team}/members`, { user_ids: ["usr_nobody"] })).status).toBe(400);
      expect(
        await call("PUT", `${team}/members`, { user_ids: [USERS.viewer.id, USERS.member.id] }),
      ).toMatchObject({ status: 200, body: { member_count: 2 } });

      const access = `/v1/projects/${SEED.project}/access`;
      expect(await call("GET", access)).toMatchObject({
        status: 200,
        body: { grants: [], implied: { member: "deployer", viewer: "viewer" } },
      });
      const unknownTeam = { principal: { type: "team", id: "team_nope" }, role: "viewer" };
      expect((await call("PUT", access, unknownTeam)).status).toBe(400);
      expect(
        (await call("PUT", access, { principal: { type: "user" }, role: "viewer" })).status,
      ).toBe(400);
      const granted = await call("PUT", access, {
        principal: { type: "team", id: teamId },
        role: "developer",
      });
      expect(granted).toMatchObject({
        status: 200,
        body: { principal: { type: "team", id: teamId }, principal_name: "Operations" },
      });
      expect(
        await call("PUT", access, { principal: { type: "team", id: teamId }, role: "viewer" }),
      ).toMatchObject({ status: 200, body: { role: "viewer" } });
      const grantId = (granted.body as { id: string }).id;

      const protection = `/v1/environments/${SEED.production}/protection`;
      expect(await call("GET", protection)).toMatchObject({
        status: 200,
        body: { protected: false, rules: { variables: { roles: [] } } },
      });
      expect((await call("GET", "/v1/environments/env_nope/protection")).status).toBe(404);
      expect((await call("PUT", protection, {})).status).toBe(400);
      const badRule = { roles: [], user_ids: [], team_ids: ["team_nope"] };
      expect(
        (await call("PUT", protection, { protected: true, rules: { variables: badRule } })).status,
      ).toBe(400);
      expect(
        await call("PUT", protection, {
          protected: true,
          rules: { variables: { roles: ["developer"], user_ids: [], team_ids: [teamId] } },
        }),
      ).toMatchObject({
        status: 200,
        body: {
          protected: true,
          rules: {
            deploy: { roles: ["developer", "deployer"] },
            variables: { team_ids: [teamId] },
          },
        },
      });
      expect(
        await call("PUT", protection, { protected: true, require_approval: true }),
      ).toMatchObject({ status: 200, body: { protected: true, require_approval: true } });
      expect((await call("GET", protection)).body).toMatchObject({ require_approval: true });
      expect(
        (await call("PUT", protection, { protected: true, require_approval: "yes" })).status,
      ).toBe(400);

      as("member");
      expect((await call("GET", access)).status).toBe(403);
      const selfGrant = { principal: { type: "user", id: USERS.member.id }, role: "developer" };
      expect((await call("PUT", access, selfGrant)).status).toBe(403);
      expect((await call("DELETE", `${access}/${grantId}`)).status).toBe(403);
      expect((await call("PUT", protection, { protected: false })).status).toBe(403);
      expect((await call("GET", protection)).status).toBe(200);
      expect((await call("DELETE", team)).status).toBe(403);
      as("viewer");
      expect((await call("GET", teams)).status).toBe(403);
      expect((await call("GET", team)).status).toBe(403);
      expect((await call("GET", settings)).status).toBe(403);
      db.access.settings[WORKSPACE_ID]!.viewer_default_project_role = "none";
      db.access.grants = [];
      expect((await call("GET", protection)).status).toBe(404);
      expect((await call("GET", access)).status).toBe(404);

      as("owner");
      const regrant = await call("PUT", access, selfGrant);
      const regrantId = (regrant.body as { id: string }).id;
      expect((await call("DELETE", `${access}/pag_nope`)).status).toBe(404);
      db.sessionStale = true;
      expect((await call("DELETE", `${access}/${regrantId}`)).status).toBe(403);
      expect((await call("DELETE", team)).status).toBe(403);
      db.sessionStale = false;
      expect((await call("DELETE", `${access}/${regrantId}`)).status).toBe(204);
      expect((await call("DELETE", team)).status).toBe(204);
      expect(db.access.rules[SEED.production]?.variables.teamIds).toEqual([]);
      expect((await call("DELETE", team)).status).toBe(404);
      expect((await call("PUT", `${team}/members`, { user_ids: [] })).status).toBe(404);
      expect((await call("PATCH", team, { name: "X" })).status).toBe(404);

      as(null);
      const anonymous: [string, string, unknown?][] = [
        ["GET", settings],
        ["PATCH", settings, { member_default_project_role: "viewer" }],
        ["GET", `${WS}/access/me`],
        ["GET", teams],
        ["POST", teams, { name: "Ops" }],
        ["GET", team],
        ["PATCH", team, { name: "X" }],
        ["DELETE", team],
        ["PUT", `${team}/members`, { user_ids: [] }],
        ["GET", access],
        ["PUT", access, selfGrant],
        ["DELETE", `${access}/${regrantId}`],
        ["GET", protection],
        ["PUT", protection, { protected: false }],
      ];
      for (const [method, path, body] of anonymous) {
        expect((await call(method, path, body)).status).toBe(401);
      }
    });
  });

  it("ADR 0014 protection: deploys and variable writes in a protected environment", async () => {
    await fresh(async () => {
      const environment = db.deploy.environments.find((row) => row.id === SEED.production);
      if (environment) environment.protected = true;
      const variables = `/v1/services/${SEED.web}/variables?environment_id=${SEED.production}`;
      const deploy = `/v1/services/${SEED.web}/deployments?environment_id=${SEED.production}`;
      as("member");
      expect(await call("PUT", variables, { set: [{ key: "A", value: "1" }] })).toMatchObject({
        status: 403,
        body: { error: { code: "forbidden" } },
      });
      expect((await call("POST", deploy, {})).status).toBe(201);
      db.access.rules[SEED.production] = {
        deploy: { roles: [], userIds: [], teamIds: [] },
        config: { roles: [], userIds: [], teamIds: [] },
        variables: { roles: [], userIds: [], teamIds: [] },
      };
      expect((await call("POST", deploy, {})).status).toBe(403);
      as("owner");
      expect(
        await call("PUT", variables, { set: [{ key: "API_TOKEN", value: "x", tier: "secret" }] }),
      ).toMatchObject({
        status: 400,
        body: { error: { code: "confirmation_required", details: [{ field: "API_TOKEN" }] } },
      });
      expect(
        await call("PUT", variables, {
          set: [
            { key: "VITE_DB", value: "postgres://app:not-a-real-password@db.example.test/app" },
          ],
        }),
      ).toMatchObject({ status: 400, body: { error: { code: "public_prefix_secret_value" } } });
      expect(
        (
          await call("PUT", variables, {
            set: [{ key: "API_TOKEN", value: "x", tier: "secret" }],
            confirm_write_only: true,
          })
        ).status,
      ).toBe(200);

      // Config writes, deleting a service and cancelling are gated too.
      as("member");
      expect(
        await call("PATCH", `/v1/services/${SEED.web}`, {
          environment_id: SEED.production,
          deploy: { replicas: 3 },
        }),
      ).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
      expect((await call("PATCH", `/v1/services/${SEED.web}`, { name: "web-2" })).status).toBe(200);
      expect((await call("DELETE", `/v1/services/${SEED.worker}`)).status).toBe(403);
      expect((await call("POST", `/v1/deployments/${SEED.workerDeploying}/cancel`)).status).toBe(
        403,
      );
      db.access.rules[SEED.production]!.config.userIds = [USERS.member.id];
      db.access.rules[SEED.production]!.deploy.teamIds = [ACCESS_SEED.platformTeam];
      expect((await call("POST", `/v1/deployments/${SEED.workerDeploying}/cancel`)).status).toBe(
        200,
      );
      expect((await call("DELETE", `/v1/services/${SEED.worker}`)).status).toBe(204);
    });
  });

  it("ADR 0014 project roles: grants raise, defaults lower, no role is a 404", async () => {
    await fresh(async () => {
      const project = `/v1/projects/${SEED.project}`;
      as("viewer");
      expect((await call("PATCH", `/v1/services/${SEED.web}`, { name: "web-2" })).status).toBe(403);
      db.access.grants.push({
        id: "pag_viewer_dev",
        project_id: SEED.project,
        principal_type: "user",
        user_id: USERS.viewer.id,
        team_id: null,
        role: "developer",
        created_by: USERS.owner.id,
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      expect((await call("PATCH", `/v1/services/${SEED.web}`, { name: "web-2" })).status).toBe(200);

      db.access.settings[WORKSPACE_ID] = {
        member_default_project_role: "none",
        viewer_default_project_role: "viewer",
      };
      as("member");
      expect((await call("GET", project)).status).toBe(404);
      expect(await call("GET", `${WS}/projects`)).toMatchObject({
        status: 200,
        body: { projects: [] },
      });
      db.access.settings[WORKSPACE_ID]!.member_default_project_role = "viewer";
      expect((await call("GET", project)).status).toBe(200);
      expect(
        await call(
          "POST",
          `/v1/services/${SEED.web}/deployments?environment_id=${SEED.production}`,
          {},
        ),
      ).toMatchObject({ status: 403, body: { error: { code: "forbidden" } } });
    });
  });

  it("ADR 0014 fresh sessions: member role changes and removals, but not leaving", async () => {
    await fresh(async () => {
      db.sessionStale = true;
      const member = `${WS}/members/mem_member`;
      expect(await call("PATCH", member, { role: "viewer" })).toMatchObject({
        status: 403,
        body: { error: { code: "reauth_required" } },
      });
      expect((await call("DELETE", member)).status).toBe(403);
      as("viewer");
      expect((await call("DELETE", `${WS}/members/mem_viewer`)).status).toBe(204);
      db.sessionStale = false;
    });
  });

  it("produced only responses the API declares", () => {
    expect(failures).toEqual([]);
  });

  it("maps every mock handler to exactly one API route, and exercises all of them", () => {
    const mocked = handlers.map((handler) =>
      routeKey(String(handler.info.method), String(handler.info.path)),
    );
    const api = apiRoutes.map((route) => route.key);
    const mockedApiRoutes = mocked.filter((key) => !BETTER_AUTH_PATHS.has(key.split(" ")[1]!));
    expect([...mockedApiRoutes].sort()).toEqual([...api].sort());
    expect([...exercised].sort()).toEqual([...mocked].sort());
  });

  it("catches drift: a mock body that breaks the schema fails validation", () => {
    const route = apiRoutes.find((candidate) => candidate.key === "GET /v1/workspaces/{}/nodes/{}");
    const schema = route?.config.responses["200"]?.content?.["application/json"]?.schema;
    expect(schema?.safeParse({ ...makeNode(), provider: "server" }).success).toBe(true);
    expect(schema?.safeParse({ ...makeNode(), provider: null }).success).toBe(false);
  });

  it("catches drift in Phase 1 schemas too", () => {
    const route = apiRoutes.find((candidate) => candidate.key === "GET /v1/deployments/{}");
    const schema = route?.config.responses["200"]?.content?.["application/json"]?.schema;
    const deployment = db.deploy.deployments.find((row) => row.id === SEED.webActive);
    const valid = { ...deployment, build: null, events: [], placements: [] };
    expect(schema?.safeParse(valid).success).toBe(true);
    expect(schema?.safeParse({ ...valid, status: "exploded" }).success).toBe(false);
  });
});

async function hmac(secret: string, body: string): Promise<string> {
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

interface ProvisionBody {
  id: string;
  status: string;
  node_id: string | null;
  server_id: string | null;
}

interface JoinTokenBody {
  token: string;
  expires_at: number;
  install_command: string;
}
