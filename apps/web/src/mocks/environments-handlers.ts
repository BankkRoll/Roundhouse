/**
 * MSW handlers for the environment lifecycle routes (`ENVIRONMENT_ROUTES` in
 * `apps/api/src/contracts/environments.ts`) against the in-memory {@link db}: the diff
 * (the mock compares variables by value, the API by fingerprint; neither returns a value),
 * promotion as an open change set of plain variable writes, and deletion. Creating and
 * cloning are in `./deploy-handlers`.
 *
 * @module
 */
import { type Action, isProjectAction } from "@roundhouse/shared";
import { HttpResponse, http } from "msw";
import { ENVIRONMENT_ROUTES, policyOf } from "../../../api/src/contracts";
import type { EnvironmentDiff } from "../lib/api/environments-client";
import { accessFor } from "./access-resolve";
import { type DbChangeSet, toChangeSet } from "./changes-db";
import {
  apiError,
  currentUser,
  invalid,
  notFound,
  recordAudit,
  requireFreshSession,
  requireWorkspace,
  unauthorized,
} from "./common";
import { db, nextId } from "./db";

type RouteName = keyof typeof ENVIRONMENT_ROUTES;

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
  body?: { content: { "application/json": { schema: Schema } } };
}

type Validated<B> =
  | { ok: true; params: Record<string, string>; query: Record<string, unknown>; body: B }
  | { ok: false; response: Response };

function issueResponse(issues: ZodIssue[]): Response {
  const issue = issues[0];
  const where = issue?.path.length ? `${issue.path.map(String).join(".")}: ` : "";
  return invalid(`${where}${issue?.message ?? "invalid"}`);
}

/** Validates params, query, then the JSON body, as `@hono/zod-openapi` does. */
async function validate<B = Record<string, never>>(
  name: RouteName,
  request: Request,
  params: Record<string, string | readonly string[] | undefined>,
): Promise<Validated<B>> {
  const spec = (ENVIRONMENT_ROUTES[name] as { request?: RouteRequest }).request ?? {};
  const parsed: unknown[] = [];
  for (const [schema, value] of [
    [spec.params, params],
    [spec.query, Object.fromEntries(new URL(request.url).searchParams)],
  ] as const) {
    if (!schema) {
      parsed.push(value);
      continue;
    }
    const result = schema.safeParse(value);
    if (!result.success) return { ok: false, response: issueResponse(result.error.issues) };
    parsed.push(result.data);
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
    params: parsed[0] as Record<string, string>,
    query: parsed[1] as Record<string, unknown>,
    body: body as B,
  };
}

const actionOf = (name: RouteName) => policyOf(ENVIRONMENT_ROUTES[name]).action as Action;

function mswPath(name: RouteName): string {
  return `*${ENVIRONMENT_ROUTES[name].path.replace(/\{([^}]+)\}/g, ":$1")}`;
}

// -----------------------------------------------------------------------------
// Access
// -----------------------------------------------------------------------------

type Granted =
  | { ok: true; workspaceId: string; userId: string }
  | { ok: false; response: Response };

/** Resolves the project's workspace and checks the caller's project role, in the API's order. */
function projectAccess(projectId: string | undefined, what: string, action: Action): Granted {
  if (!currentUser()) return { ok: false, response: unauthorized() };
  const project = db.deploy.projects.find((row) => row.id === projectId && !row.deleted);
  if (!project) return { ok: false, response: notFound(what) };
  const guard = requireWorkspace(project.workspace_id, "workspace:read");
  // NOTE: Non-members get the same 404 as a missing row, so ids can't be probed.
  if (!guard.ok) return { ok: false, response: notFound(what) };
  if (isProjectAction(action)) {
    const decision = accessFor(project.workspace_id, guard.user).check(action, {
      projectId: project.id,
    });
    if (decision.reason === "no_project_access") return { ok: false, response: notFound(what) };
    if (!decision.allowed) {
      return {
        ok: false,
        response: apiError(
          403,
          "forbidden",
          `Your project role (${decision.projectRole ?? "none"}) cannot perform ${action}`,
        ),
      };
    }
  }
  return { ok: true, workspaceId: project.workspace_id, userId: guard.user.id };
}

function environmentAccess(environmentId: string | undefined, action: Action) {
  const environment = db.deploy.environments.find((row) => row.id === environmentId);
  if (!environment && !currentUser()) return { ok: false as const, response: unauthorized() };
  const granted = projectAccess(environment?.project_id, "Environment", action);
  return granted.ok ? { ...granted, environment: environment! } : granted;
}

type Comparison = EnvironmentDiff["shared_variables"][number];

function compare(
  base: { key: string; value: string; tier: string }[],
  target: { key: string; value: string; tier: string }[],
): Comparison[] {
  const keys = [...new Set([...base, ...target].map((v) => v.key))].sort();
  return keys.map((key) => {
    const b = base.find((v) => v.key === key);
    const t = target.find((v) => v.key === key);
    const change: Comparison["change"] = !b
      ? "added"
      : !t
        ? "removed"
        : b.value === t.value && b.tier === t.tier
          ? "same"
          : "changed";
    return { key, change, secret: b?.tier === "secret" || t?.tier === "secret" };
  });
}

/** Environment lifecycle handlers. */
export const environmentHandlers = [
  http.get(mswPath("diffEnvironments"), async ({ request, params }) => {
    const input = await validate("diffEnvironments", request, params);
    if (!input.ok) return input.response;
    const granted = projectAccess(input.params.projectId, "Project", actionOf("diffEnvironments"));
    if (!granted.ok) return granted.response;
    const projectId = input.params.projectId!;
    const envOf = (id: unknown) =>
      db.deploy.environments.find((row) => row.id === id && row.project_id === projectId);
    const base = envOf(input.query.base);
    const target = envOf(input.query.target);
    if (!base || !target) return notFound("Environment");
    const vars = (envId: string, scope: string, owner: string) =>
      db.deploy.variables.filter(
        (v) => v.environment_id === envId && v.scope === scope && v.owner_id === owner,
      );
    const config = (serviceId: string, envId: string) =>
      db.deploy.configs
        .filter((c) => c.service_id === serviceId && c.environment_id === envId)
        .sort((a, b) => b.version - a.version)[0];
    const services: EnvironmentDiff["services"] = db.deploy.services
      .filter((s) => s.project_id === projectId && !s.deleted)
      .flatMap((s) => {
        const b = config(s.id, base.id);
        const t = config(s.id, target.id);
        if (!b && !t) return [];
        const paths: EnvironmentDiff["services"][number]["config"] = [];
        if (b && t) {
          for (const part of ["deploy", "resources", "build", "source", "healthcheck"] as const) {
            if (JSON.stringify(b[part]) !== JSON.stringify(t[part])) {
              paths.push({ path: `/${part}`, before: null, after: null });
            }
          }
        }
        const presence: EnvironmentDiff["services"][number]["presence"] =
          b && t ? "both" : b ? "only_base" : "only_target";
        return [
          {
            service_id: s.id,
            slug: s.slug,
            presence,
            config: paths,
            variables: compare(vars(base.id, "service", s.id), vars(target.id, "service", s.id)),
            image: { base: null, target: null },
          },
        ];
      });
    const diff: EnvironmentDiff = {
      base_environment_id: base.id,
      target_environment_id: target.id,
      services,
      shared_variables: compare(
        vars(base.id, "shared", projectId),
        vars(target.id, "shared", projectId),
      ),
    };
    return HttpResponse.json(diff);
  }),

  http.post(mswPath("promoteEnvironment"), async ({ request, params }) => {
    const input = await validate<{ from_environment_id: string }>(
      "promoteEnvironment",
      request,
      params,
    );
    if (!input.ok) return input.response;
    const granted = environmentAccess(input.params.environmentId, actionOf("promoteEnvironment"));
    if (!granted.ok) return granted.response;
    const target = granted.environment;
    const from = db.deploy.environments.find(
      (row) => row.id === input.body.from_environment_id && row.project_id === target.project_id,
    );
    if (!from) return notFound("Environment");
    if (from.id === target.id) {
      return invalid("from_environment_id: promote from another environment");
    }
    const now = Date.now();
    const differs = db.deploy.variables
      .filter((v) => v.environment_id === from.id && v.tier !== "secret")
      .filter(
        (v) =>
          !db.deploy.variables.some(
            (t) =>
              t.environment_id === target.id &&
              t.scope === v.scope &&
              t.owner_id === v.owner_id &&
              t.key === v.key &&
              t.value === v.value,
          ),
      );
    if (!differs.length) {
      return apiError(409, "conflict", `Nothing differs between ${from.name} and ${target.name}`);
    }
    const set: DbChangeSet = {
      id: nextId("chs"),
      project_id: target.project_id,
      environment_id: target.id,
      status: "open",
      is_draft: false,
      source: "promote",
      title: `Promote ${from.name} to ${target.name}`,
      revision: differs.length,
      created_by: granted.userId,
      created_by_token: null,
      applied_by: null,
      applied_at: null,
      error: null,
      created_at: now,
      updated_at: now,
      changes: differs.map((v, i) => ({
        id: nextId("stg"),
        seq: i + 1,
        target_key: `var:${v.scope === "shared" ? "shared" : v.owner_id}:${v.key}`,
        op: {
          type: "variable.set",
          scope: v.scope,
          ...(v.scope === "service" ? { service: v.owner_id } : {}),
          key: v.key,
          tier: v.tier,
          confirm_write_only: true,
          acknowledge_public: false,
          fingerprint: "00000000",
          staged_tier: v.tier,
        },
        summary: `set ${v.key}`,
        diff: [],
        status: "pending",
        conflict: null,
        created_by: granted.userId,
        created_at: now,
        updated_at: now,
        value: v.value,
        base_version: null,
      })),
    };
    db.changes.sets.push(set);
    recordAudit({
      workspaceId: granted.workspaceId,
      actorType: "user",
      actorId: granted.userId,
      action: "environment.promote_proposed",
      targetType: "environment",
      targetId: target.id,
      metadata: { environment: target.slug, from_environment_id: from.id, change_set_id: set.id },
    });
    return HttpResponse.json(toChangeSet(set), { status: 201 });
  }),

  http.delete(mswPath("deleteEnvironment"), async ({ request, params }) => {
    const input = await validate("deleteEnvironment", request, params);
    if (!input.ok) return input.response;
    if (!currentUser()) return unauthorized();
    const stale = requireFreshSession();
    if (stale) return stale;
    const granted = environmentAccess(input.params.environmentId, actionOf("deleteEnvironment"));
    if (!granted.ok) return granted.response;
    const environment = granted.environment;
    if (environment.kind === "production") {
      return apiError(409, "conflict", "A production environment can never be deleted");
    }
    if (input.query.confirm !== environment.slug) {
      return invalid("confirm must equal the slug of the environment");
    }
    db.deploy.environments = db.deploy.environments.filter((row) => row.id !== environment.id);
    recordAudit({
      workspaceId: granted.workspaceId,
      actorType: "user",
      actorId: granted.userId,
      action: "environment.deleted",
      targetType: "environment",
      targetId: environment.id,
      metadata: { environment: environment.slug },
    });
    return new HttpResponse(null, { status: 204 });
  }),
];
