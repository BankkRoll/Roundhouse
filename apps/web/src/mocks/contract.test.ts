/**
 * Contract test: every response the MSW mocks produce must be one the real API declares.
 *
 * Two sources define the API's routes, and both are read from the API source:
 * - the mounted routers (`apps/api/src/routes/*.ts`), through their OpenAPI registries;
 * - `PHASE1_ROUTES` in `apps/api/src/contracts.ts`, the deploy pipeline's route
 *   definitions. They are checked directly, so the Phase 1 mocks are held to the
 *   contract before (and regardless of whether) their API handlers are mounted.
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
import { PHASE1_ROUTES } from "../../../api/src/contracts";
import { RealtimeServerMessageSchema } from "../../../api/src/schemas";
import {
  db,
  INVITE_TOKEN,
  MASTER_KEY,
  makeNode,
  resetDb,
  seedFreshInstall,
  signInAs,
  USERS,
  WORKSPACE_ID,
} from "./db";
import { SEED } from "./deploy-db";
import { realtimeSubscriptions, sentRealtimeMessages } from "./deploy-handlers";
import { handlers } from "./handlers";

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
  "variables",
  "deployments",
  "github",
  "instance",
  "realtime",
  "tokens",
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
  for (const route of Object.values(PHASE1_ROUTES)) add(route as unknown as RouteConfig);
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
const BETTER_AUTH_PATHS = new Set(["/api/auth/sign-in/email", "/api/auth/sign-out"]);

let apiRoutes: ApiRoute[] = [];
/** `Location` of the last response `call` received, for redirects. */
let lastLocation: string | null = null;
const exercised = new Set<string>();
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
        body: { name: "Acme Robotics", slug: "acme" },
      });
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

  it("invites: preview and accept", async () => {
    await fresh(async () => {
      as(null);
      expect((await call("GET", `/v1/invites/${INVITE_TOKEN}`)).status).toBe(200);
      expect((await call("GET", "/v1/invites/inv_nope")).status).toBe(404);
      expect(
        (await call("POST", `/v1/invites/${INVITE_TOKEN}/accept`, { name: "Erin" })).status,
      ).toBe(400);
      expect(
        (await call("POST", "/v1/invites/inv_nope/accept", { name: "E", password: "x".repeat(12) }))
          .status,
      ).toBe(404);
      as("viewer");
      expect(await call("POST", `/v1/invites/${INVITE_TOKEN}/accept`, {})).toMatchObject({
        status: 403,
        body: { error: { code: "email_mismatch" } },
      });
      as(null);
      const seeded = db.invites[0];
      if (seeded) seeded.email = USERS.member.email;
      expect(
        await call("POST", `/v1/invites/${INVITE_TOKEN}/accept`, {
          name: "Cara",
          password: "a-long-enough-password",
        }),
      ).toMatchObject({ status: 409, body: { error: { code: "account_exists" } } });
      if (seeded) seeded.email = "erin@example.com";
      expect(
        (
          await call("POST", `/v1/invites/${INVITE_TOKEN}/accept`, {
            name: "Erin",
            password: "a-long-enough-password",
          })
        ).status,
      ).toBe(200);
      expect(db.invites[0]?.accepted_at).toEqual(expect.any(Number));
      expect((await call("GET", `/v1/invites/${INVITE_TOKEN}`)).status).toBe(404);
      expect((await call("POST", `/v1/invites/${INVITE_TOKEN}/accept`, {})).status).toBe(404);
    });

    await fresh(async () => {
      const seeded = db.invites[0];
      if (seeded) seeded.expires_at = Date.now() - 1;
      expect((await call("GET", `/v1/invites/${INVITE_TOKEN}`)).status).toBe(404);
      if (seeded) {
        seeded.expires_at = Date.now() + 60_000;
        seeded.email = USERS.viewer.email;
      }
      db.memberships = db.memberships.filter((row) => row.user_id !== USERS.viewer.id);
      as("viewer");
      expect((await call("POST", `/v1/invites/${INVITE_TOKEN}/accept`, {})).status).toBe(200);
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
        ["storefront", 3],
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

interface JoinTokenBody {
  token: string;
  expires_at: number;
  install_command: string;
}
