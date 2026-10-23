/**
 * Checks the Phase 1 route contracts before any handler exists: every route
 * builds a valid OpenAPI operation, declares a coherent policy, and doesn't
 * collide with a live route; request schemas enforce their cross-field rules.
 */
import { OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import { TLS_MODES as PROTOCOL_TLS_MODES } from "@roundhouse/protocol";
import { ACTIONS, AUDIT_ACTIONS, TLS_MODES } from "@roundhouse/shared";
import { describe, expect, it } from "vitest";
import {
  CreateServiceBody,
  DATA_BROWSER_ROUTES,
  DATABASE_ROUTES,
  DatabaseQueryBody,
  PHASE1_ROUTES,
  POLICY_KEY,
  policyOf,
  type RoutePolicy,
  SECURITY_ROUTES,
  UpdateServiceBody,
} from "../src/contracts";
import { app } from "../src/index";
import {
  InstanceSettingsPatchSchema,
  RealtimeClientMessageSchema,
  RealtimeServerMessageSchema,
  ServiceSourceSchema,
  VariablesPutSchema,
} from "../src/schemas";

const routes = Object.entries(PHASE1_ROUTES) as [
  string,
  RouteConfig & { [POLICY_KEY]: RoutePolicy },
][];

function document() {
  const router = new OpenAPIHono();
  for (const [, route] of routes) {
    router.openapi(route, (c) => c.body(null, 204) as never);
  }
  return router.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } });
}

describe("phase 1 contracts", () => {
  it("generates an OpenAPI operation for every route", () => {
    const doc = document();
    const operations = Object.values(doc.paths ?? {}).flatMap((item) =>
      Object.values(item as Record<string, unknown>),
    );
    expect(operations).toHaveLength(routes.length);
    for (const op of operations) {
      expect(op).toHaveProperty(POLICY_KEY);
    }
  });

  it("uses each method and path once", () => {
    const keys = routes.map(([, r]) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is served by the app, policy included, for every route", () => {
    const live = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } });
    for (const [, route] of routes) {
      const item = live.paths?.[route.path] as Record<string, Record<string, unknown>> | undefined;
      const op = item?.[route.method];
      expect(op, `${route.method} ${route.path}`).toBeDefined();
      expect(op?.[POLICY_KEY]).toEqual(policyOf(route));
    }
  });

  it("declares path params for every placeholder", () => {
    for (const [name, route] of routes) {
      const placeholders = [...route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const params = route.request && "params" in route.request ? route.request.params : undefined;
      const declared = params ? Object.keys((params as { shape: object }).shape) : [];
      expect(declared.sort(), name).toEqual(placeholders.sort());
    }
  });

  it("gives every route a valid policy", () => {
    for (const [name, route] of routes) {
      const policy = policyOf(route);
      if (policy.action !== null) expect(ACTIONS, name).toContain(policy.action);
      for (const audit of policy.audit) expect(AUDIT_ACTIONS, name).toContain(audit);
      if (policy.auth === "session") {
        expect(policy.action, name).not.toBeNull();
        expect(route.security, name).toEqual([{ session: [] }, { api_token: [] }]);
      } else if (policy.auth === "session_only") {
        expect(policy.action, name).not.toBeNull();
        expect(route.security, name).toEqual([{ session: [] }]);
      } else {
        expect(policy.action, name).toBeNull();
        expect(route.security, name).toBeUndefined();
      }
    }
  });

  it("only lets mutations, and reads that hand out plain values, write audit entries", () => {
    const auditedReads = ["githubCallback", "resolveServiceVariables"];
    for (const [name, route] of routes) {
      if (route.method === "get" && !auditedReads.includes(name)) {
        expect(policyOf(route).audit, name).toEqual([]);
      }
    }
  });

  it("covers every Phase 1 audit action", () => {
    const used = new Set(
      [...routes, ...Object.values(SECURITY_ROUTES).map((r) => ["", r] as const)].flatMap(
        ([, r]) => policyOf(r as (typeof routes)[number][1]).audit,
      ),
    );
    // Recorded by the deploy workflow when a rollout ends, not by a route.
    const fromWorkflow = ["deployment.succeeded", "deployment.failed"];
    const phase1 = AUDIT_ACTIONS.slice(
      AUDIT_ACTIONS.indexOf("project.created"),
      AUDIT_ACTIONS.indexOf("instance.settings_updated") + 1,
    );
    // Reveal is gone (ADR 0014); the action stays only to label old entries.
    const retired = ["variables.revealed"];
    for (const action of phase1) {
      if (!fromWorkflow.includes(action) && !retired.includes(action)) {
        expect(used, action).toContain(action);
      }
    }
  });
});

describe("ADR 0014 contracts", () => {
  const security = Object.entries(SECURITY_ROUTES) as [
    string,
    RouteConfig & { [POLICY_KEY]: RoutePolicy },
  ][];

  it("builds an OpenAPI operation for every route", () => {
    const router = new OpenAPIHono();
    for (const [, route] of security) router.openapi(route, (c) => c.body(null, 204) as never);
    const doc = router.getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "t", version: "0" },
    });
    const operations = Object.values(doc.paths ?? {}).flatMap((item) =>
      Object.values(item as Record<string, unknown>),
    );
    expect(operations).toHaveLength(security.length);
  });

  it("collides with no Phase 1 route and declares every path param", () => {
    const taken = new Set(routes.map(([, r]) => `${r.method} ${r.path}`));
    for (const [name, route] of security) {
      expect(taken.has(`${route.method} ${route.path}`), name).toBe(false);
      const placeholders = [...route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const params = route.request && "params" in route.request ? route.request.params : undefined;
      const declared = params ? Object.keys((params as { shape: object }).shape) : [];
      expect(declared.sort(), name).toEqual(placeholders.sort());
    }
  });

  it("gives every route a valid policy, and fresh sessions to every access change", () => {
    for (const [name, route] of security) {
      const policy = policyOf(route);
      if (policy.action !== null) expect(ACTIONS, name).toContain(policy.action);
      for (const audit of policy.audit) expect(AUDIT_ACTIONS, name).toContain(audit);
      const changesAccess = policy.action === "access:manage" && route.method !== "get";
      if (changesAccess) expect(policy.reauth, name).toBe(true);
    }
  });

  it("is served by the app, policy included, except what the api-auth stream still owes", () => {
    // TODO(api-auth): serve getSecurityStatus and drop it from this list.
    const pending = ["getSecurityStatus"];
    const live = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } });
    for (const [name, route] of security) {
      if (pending.includes(name)) continue;
      const item = live.paths?.[route.path] as Record<string, Record<string, unknown>> | undefined;
      const op = item?.[route.method];
      expect(op, name).toBeDefined();
      expect(op?.[POLICY_KEY], name).toEqual(policyOf(route));
    }
  });

  it("has no reveal route anywhere", () => {
    const all = [...routes, ...security];
    expect(all.filter(([, r]) => r.path.includes("reveal"))).toEqual([]);
  });
});

describe("phase 1 request schemas", () => {
  it("requires an environment for config changes only", () => {
    expect(UpdateServiceBody.safeParse({ name: "api" }).success).toBe(true);
    expect(UpdateServiceBody.safeParse({ deploy: { replicas: 2 } }).success).toBe(false);
    expect(
      UpdateServiceBody.safeParse({ environment_id: "env_1", deploy: { replicas: 2 } }).success,
    ).toBe(true);
    expect(
      UpdateServiceBody.safeParse({ environment_id: "env_1", healthcheck: null }).success,
    ).toBe(true);
    expect(UpdateServiceBody.safeParse({}).success).toBe(false);
  });

  it("accepts the reserved shared slug, which the handler suffixes", () => {
    const source = { type: "image", image: "nginx:1.27" };
    expect(CreateServiceBody.safeParse({ name: "x", slug: "shared", source }).success).toBe(true);
    expect(CreateServiceBody.safeParse({ name: "x", slug: "Not A Slug", source }).success).toBe(
      false,
    );
  });

  it("keeps instance settings and GitHub App setup session-only", () => {
    const sessionOnly = routes
      .filter(([, r]) => policyOf(r).auth === "session_only")
      .map(([n]) => n)
      .sort();
    expect(sessionOnly).toEqual(
      [
        "createGithubManifest",
        "getInstanceSettings",
        "githubCallback",
        "updateInstanceSettings",
      ].sort(),
    );
  });

  it.each([
    [{ type: "image", image: "nginx:1.27" }, true],
    [{ type: "image", image: "not an image" }, false],
    [{ type: "git", repo_url: "https://github.com/a/b", branch: "main", root_dir: "." }, true],
    [
      { type: "git", repo_url: "https://github.com/a/b", branch: "feat/x", root_dir: "apps/web" },
      true,
    ],
    [{ type: "git", repo_url: "https://u:p@github.com/a/b", branch: "main", root_dir: "." }, false],
    [{ type: "git", repo_url: "https://github.com/a/b", branch: "a..b", root_dir: "." }, false],
    [{ type: "git", repo_url: "https://github.com/a/b", branch: "main/", root_dir: "." }, false],
    [{ type: "git", repo_url: "https://github.com/a/b", branch: "main", root_dir: "../x" }, false],
  ])("validates source %j", (source, ok) => {
    expect(ServiceSourceSchema.safeParse(source).success).toBe(ok);
  });

  it("rejects a key both set and deleted", () => {
    expect(
      VariablesPutSchema.safeParse({ set: [{ key: "A", value: "1" }], delete: ["A"] }).success,
    ).toBe(false);
    expect(VariablesPutSchema.safeParse({ set: [{ key: "A", value: "1" }] }).success).toBe(true);
    expect(VariablesPutSchema.safeParse({ set: [{ key: "1A", value: "1" }] }).success).toBe(false);
  });

  it("validates instance settings updates", () => {
    expect(InstanceSettingsPatchSchema.safeParse({}).success).toBe(false);
    expect(InstanceSettingsPatchSchema.safeParse({ apps_domain: null }).success).toBe(true);
    expect(InstanceSettingsPatchSchema.safeParse({ apps_domain: "Apps.Example.com" }).success).toBe(
      false,
    );
    expect(InstanceSettingsPatchSchema.safeParse({ tls_mode: "internal" }).success).toBe(true);
  });

  it("keeps the shared and protocol TLS modes identical", () => {
    expect([...TLS_MODES]).toEqual([...PROTOCOL_TLS_MODES]);
  });

  it("parses realtime messages in both directions", () => {
    expect(
      RealtimeServerMessageSchema.safeParse({
        type: "log.lines",
        source: { type: "build", service_id: "svc_1", build_id: "bld_1" },
        lines: [{ ts: 1, stream: "stdout", text: "hi" }],
      }).success,
    ).toBe(true);
    expect(RealtimeServerMessageSchema.safeParse({ type: "presence", users: [] }).success).toBe(
      true,
    );
    expect(
      RealtimeClientMessageSchema.safeParse({
        type: "subscribe",
        topic: { kind: "deployment_logs", deployment_id: "dep_1" },
      }).success,
    ).toBe(true);
    expect(RealtimeClientMessageSchema.safeParse({ type: "subscribe" }).success).toBe(false);
  });
});

describe("data browser contracts", () => {
  const data = Object.entries(DATA_BROWSER_ROUTES) as [
    string,
    RouteConfig & { [POLICY_KEY]: RoutePolicy },
  ][];

  it("is served by the app with its policy, and needs data:read", () => {
    const live = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } });
    const taken = new Set(routes.map(([, r]) => `${r.method} ${r.path}`));
    for (const [name, route] of data) {
      expect(taken.has(`${route.method} ${route.path}`), name).toBe(false);
      const op = (live.paths?.[route.path] as Record<string, Record<string, unknown>>)?.[
        route.method
      ];
      expect(op?.[POLICY_KEY], name).toEqual(policyOf(route));
      expect(policyOf(route).action, name).toBe("data:read");
    }
    expect(policyOf(DATA_BROWSER_ROUTES.runDatabaseQuery).audit).toEqual([
      "database.query_executed",
    ]);
    expect(policyOf(DATA_BROWSER_ROUTES.getDatabaseSchema).audit).toEqual([
      "database.browser_opened",
    ]);
  });

  it("refuses provision_readonly and out-of-range limits", () => {
    const ok = { environment_id: "env_1", op: { type: "list_namespaces" } };
    expect(DatabaseQueryBody.safeParse(ok).success).toBe(true);
    expect(DatabaseQueryBody.parse(ok).mode).toBe("read");
    expect(DatabaseQueryBody.safeParse({ ...ok, op: { type: "provision_readonly" } }).success).toBe(
      false,
    );
    expect(DatabaseQueryBody.safeParse({ ...ok, max_rows: 1001 }).success).toBe(false);
    expect(DatabaseQueryBody.safeParse({ ...ok, timeout_ms: 30_001 }).success).toBe(false);
  });
});

describe("database and volume contracts (ADR 0004)", () => {
  it("is served by the app with its policy, audits every mutation, and reads nothing it audits", () => {
    const live = app.getOpenAPI31Document({ openapi: "3.1.0", info: { title: "t", version: "0" } });
    for (const [name, route] of Object.entries(DATABASE_ROUTES)) {
      const op = (live.paths?.[route.path] as Record<string, Record<string, unknown>>)?.[
        route.method
      ];
      expect(op?.[POLICY_KEY], name).toEqual(policyOf(route));
      const { action, audit } = policyOf(route);
      expect(action, name).toBe(route.method === "get" ? "services:read" : "services:manage");
      if (route.method === "get") expect(audit, name).toEqual([]);
      else expect(audit.length, name).toBeGreaterThan(0);
    }
  });
});
