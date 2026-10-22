/**
 * Contract test: every response the MSW mocks produce must be one the real API declares.
 *
 * The API's routers (`apps/api/src/routes/*.ts`) are imported from source and their
 * OpenAPI registries read for each route's statuses and zod response schemas, the same
 * schemas that generate `/v1/openapi.json`. Each scenario below drives a mock handler
 * into a success or error case, and every response is checked for:
 *
 * 1. a matching API route (method + path),
 * 2. a status that route declares,
 * 3. a body that passes the route's zod schema for that status.
 *
 * The test also requires a one-to-one mapping between mock handlers and API routes, and
 * that every handler was exercised. Changing a schema or a mock without the other fails.
 */
import { JOIN_TOKEN_TTL_MS, type Role } from "@openrail/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const ROUTE_MODULES = ["setup", "workspaces", "invites", "nodes", "audit"] as const;

async function loadApiRoutes(): Promise<ApiRoute[]> {
  const modules = await Promise.all(
    // NOTE: A variable specifier keeps the web typecheck from following the import into
    // Worker-only code (D1 and Durable Object bindings) that it has no types for.
    ROUTE_MODULES.map(
      (name) =>
        import(/* @vite-ignore */ `@openrail/api-source/routes/${name}.ts`) as Promise<
          Record<string, unknown>
        >,
    ),
  );
  const routes: ApiRoute[] = [];
  for (const module of modules) {
    for (const router of Object.values(module)) {
      const registry = (
        router as { openAPIRegistry?: { definitions: { type: string; route?: RouteConfig }[] } }
      ).openAPIRegistry;
      for (const definition of registry?.definitions ?? []) {
        if (definition.type !== "route" || !definition.route) continue;
        const { method, path } = definition.route;
        routes.push({
          key: routeKey(method, path),
          pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, "[^/]+")}$`),
          config: definition.route,
        });
      }
    }
  }
  return routes;
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
async function call(method: string, path: string, body?: unknown): Promise<Call> {
  const url = new URL(path, window.location.origin);
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
      as("member");
      expect(await call("POST", "/v1/workspaces", { name: "Lab" })).toMatchObject({
        status: 403,
        body: { error: { code: "forbidden" } },
      });

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
});

interface JoinTokenBody {
  token: string;
  expires_at: number;
  install_command: string;
}
