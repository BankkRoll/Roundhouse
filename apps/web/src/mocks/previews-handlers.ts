/**
 * MSW handlers for the pull request preview routes (`PREVIEW_ROUTES` in
 * `apps/api/src/contracts/previews.ts`) against the in-memory {@link db}.
 * `contract.test.ts` validates every response against the API's schemas.
 *
 * Requests are validated with the routes' own zod schemas first (400), then the API's
 * order: 401 without a session, 404 for a missing row or no project role, 403 when the
 * project role lacks the route's action, then 409 (approving a head that moved on or a
 * preview that needs no approval, redeploying one that isn't active).
 *
 * There is no webhook or builder: previews only change through these routes, or when a
 * test edits `db.previews`.
 *
 * @module
 */
import { type Action, isProjectAction } from "@roundhouse/shared";
import { HttpResponse, http } from "msw";
import { PREVIEW_ROUTES, policyOf } from "../../../api/src/contracts";
import type { Preview, PreviewSettings, PreviewSettingsBody } from "../lib/api/previews-client";
import { accessFor } from "./access-resolve";
import {
  apiError,
  currentUser,
  invalid,
  notFound,
  recordAudit,
  requireWorkspace,
  unauthorized,
} from "./common";
import { db } from "./db";
import { defaultPreviewSettings } from "./previews-db";

type RouteName = keyof typeof PREVIEW_ROUTES;

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
  const spec = (PREVIEW_ROUTES[name] as { request?: RouteRequest }).request ?? {};
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

const actionOf = (name: RouteName) => policyOf(PREVIEW_ROUTES[name]).action as Action;

function mswPath(name: RouteName): string {
  return `*${PREVIEW_ROUTES[name].path.replace(/\{([^}]+)\}/g, ":$1")}`;
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

function previewAccess(previewId: string, action: Action) {
  const preview = db.previews.previews.find((row) => row.id === previewId);
  if (!preview && !currentUser()) return { ok: false as const, response: unauthorized() };
  const granted = projectAccess(preview?.project_id, "Preview", action);
  return granted.ok ? { ...granted, preview: preview! } : granted;
}

// -----------------------------------------------------------------------------
// Shaping
// -----------------------------------------------------------------------------

function settingsOf(projectId: string): PreviewSettings {
  return {
    ...(db.previews.settings[projectId] ?? defaultPreviewSettings()),
    project_id: projectId,
    pull_request_events_seen: db.previews.pullRequestEventsSeen,
  };
}

const ENDED: readonly Preview["status"][] = ["closed", "expired"];

function audit(
  granted: { workspaceId: string; userId: string },
  action: Parameters<typeof recordAudit>[0]["action"],
  preview: Preview,
) {
  recordAudit({
    workspaceId: granted.workspaceId,
    actorType: "user",
    actorId: granted.userId,
    action,
    targetType: "preview",
    targetId: preview.id,
    metadata: { pr_number: preview.pr_number, repo: preview.repo_full_name },
  });
}

/** Checks the API's rules zod can't express: environments, services and the fork builder. */
function settingsProblem(projectId: string, body: PreviewSettingsBody): string | null {
  const base = db.deploy.environments.find(
    (row) => row.id === body.base_environment_id && row.project_id === projectId,
  );
  if (!base) return "base_environment_id: no such environment in this project";
  if (base.kind === "preview") return "base_environment_id: a preview can't be the base";
  const services = new Set(
    db.deploy.services
      .filter((row) => row.project_id === projectId && !row.deleted)
      .map((row) => row.id),
  );
  if (body.services?.some((id) => !services.has(id))) {
    return "services: no such service in this project";
  }
  if (body.fork_policy === "approval" && Object.keys(body.build_node_selector ?? {}).length === 0) {
    return "build_node_selector: approving fork PRs needs a dedicated builder";
  }
  return null;
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

/** Every preview route. */
export const previewHandlers = [
  http.get(mswPath("getPreviewSettings"), async ({ request, params }) => {
    const input = await validate("getPreviewSettings", request, params);
    if (!input.ok) return input.response;
    const projectId = input.params.projectId!;
    const granted = projectAccess(projectId, "Project", actionOf("getPreviewSettings"));
    if (!granted.ok) return granted.response;
    return HttpResponse.json(settingsOf(projectId));
  }),

  http.put(mswPath("putPreviewSettings"), async ({ request, params }) => {
    const input = await validate<PreviewSettingsBody>("putPreviewSettings", request, params);
    if (!input.ok) return input.response;
    const projectId = input.params.projectId!;
    const granted = projectAccess(projectId, "Project", actionOf("putPreviewSettings"));
    if (!granted.ok) return granted.response;
    const problem = settingsProblem(projectId, input.body);
    if (problem) return invalid(problem);
    const body = input.body as Required<PreviewSettingsBody>;
    db.previews.settings[projectId] = {
      ...defaultPreviewSettings(),
      ...body,
      configured: true,
      updated_at: Date.now(),
    };
    recordAudit({
      workspaceId: granted.workspaceId,
      actorType: "user",
      actorId: granted.userId,
      action: "preview.settings_updated",
      targetType: "project",
      targetId: projectId,
    });
    return HttpResponse.json(settingsOf(projectId));
  }),

  http.get(mswPath("listPreviews"), async ({ request, params }) => {
    const input = await validate("listPreviews", request, params);
    if (!input.ok) return input.response;
    const projectId = input.params.projectId!;
    const granted = projectAccess(projectId, "Project", actionOf("listPreviews"));
    if (!granted.ok) return granted.response;
    const previews = db.previews.previews
      .filter(
        (row) =>
          row.project_id === projectId &&
          (input.query.status === "all" || !ENDED.includes(row.status)),
      )
      .sort((a, b) => b.last_activity_at - a.last_activity_at);
    return HttpResponse.json({ previews });
  }),

  http.get(mswPath("getPreview"), async ({ request, params }) => {
    const input = await validate("getPreview", request, params);
    if (!input.ok) return input.response;
    const found = previewAccess(input.params.previewId!, actionOf("getPreview"));
    if (!found.ok) return found.response;
    return HttpResponse.json(found.preview);
  }),

  http.post(mswPath("approvePreview"), async ({ request, params }) => {
    const input = await validate<{ head_sha: string }>("approvePreview", request, params);
    if (!input.ok) return input.response;
    const found = previewAccess(input.params.previewId!, actionOf("approvePreview"));
    if (!found.ok) return found.response;
    const preview = found.preview;
    if (preview.status !== "pending_approval") {
      return apiError(409, "conflict", "This preview doesn't need an approval");
    }
    if (preview.head_sha !== input.body.head_sha) {
      return apiError(
        409,
        "head_moved",
        "The pull request has new commits since you looked; review the new head",
      );
    }
    Object.assign(preview, {
      status: "creating",
      approved_sha: preview.head_sha,
      updated_at: Date.now(),
    } satisfies Partial<Preview>);
    audit(found, "preview.approved", preview);
    return HttpResponse.json(preview);
  }),

  http.post(mswPath("redeployPreview"), async ({ request, params }) => {
    const input = await validate("redeployPreview", request, params);
    if (!input.ok) return input.response;
    const found = previewAccess(input.params.previewId!, actionOf("redeployPreview"));
    if (!found.ok) return found.response;
    const preview = found.preview;
    if (preview.status !== "active") {
      return apiError(409, "conflict", "Only an active preview can be redeployed");
    }
    preview.services = preview.services.map((service) => ({ ...service, status: "queued" }));
    preview.updated_at = Date.now();
    audit(found, "deployment.created", preview);
    return HttpResponse.json(preview);
  }),

  http.delete(mswPath("deletePreview"), async ({ request, params }) => {
    const input = await validate("deletePreview", request, params);
    if (!input.ok) return input.response;
    const found = previewAccess(input.params.previewId!, actionOf("deletePreview"));
    if (!found.ok) return found.response;
    const preview = found.preview;
    if (preview.environment_id) {
      const environmentId = preview.environment_id;
      db.deploy.environments = db.deploy.environments.filter((row) => row.id !== environmentId);
    }
    const now = Date.now();
    Object.assign(preview, {
      status: ENDED.includes(preview.status) ? preview.status : "closed",
      environment_id: null,
      environment_slug: null,
      services: [],
      expires_at: null,
      closed_at: preview.closed_at ?? now,
      updated_at: now,
    } satisfies Partial<Preview>);
    audit(found, "preview.deleted", preview);
    return HttpResponse.json(preview);
  }),
];
