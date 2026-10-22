/**
 * Checks the Phase 1 route contracts before any handler exists: every route
 * builds a valid OpenAPI operation, declares a coherent policy, and doesn't
 * collide with a live route; request schemas enforce their cross-field rules.
 */
import { OpenAPIHono, type RouteConfig } from "@hono/zod-openapi";
import { TLS_MODES as PROTOCOL_TLS_MODES } from "@openrail/protocol";
import { ACTIONS, AUDIT_ACTIONS, TLS_MODES } from "@openrail/shared";
import { describe, expect, it } from "vitest";
import {
  CreateServiceBody,
  PHASE1_ROUTES,
  POLICY_KEY,
  policyOf,
  type RoutePolicy,
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
        expect(route.security, name).toEqual([{ session: [] }]);
      } else {
        expect(policy.action, name).toBeNull();
        expect(route.security, name).toBeUndefined();
      }
    }
  });

  it("only lets mutations write audit entries", () => {
    for (const [name, route] of routes) {
      if (route.method === "get" && name !== "githubCallback") {
        expect(policyOf(route).audit, name).toEqual([]);
      }
    }
  });

  it("covers every Phase 1 audit action", () => {
    const used = new Set(routes.flatMap(([, r]) => policyOf(r).audit));
    // Recorded by the deploy workflow when a rollout ends, not by a route.
    const fromWorkflow = ["deployment.succeeded", "deployment.failed"];
    const phase1 = AUDIT_ACTIONS.slice(AUDIT_ACTIONS.indexOf("project.created"));
    for (const action of phase1) {
      if (!fromWorkflow.includes(action)) expect(used, action).toContain(action);
    }
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

  it("reserves the shared namespace for service slugs", () => {
    const source = { type: "image", image: "nginx:1.27" };
    expect(CreateServiceBody.safeParse({ name: "x", slug: "shared", source }).success).toBe(false);
    expect(CreateServiceBody.safeParse({ name: "x", slug: "web", source }).success).toBe(true);
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
