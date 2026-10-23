/**
 * Resolves the workspace that owns a project, service, deployment or build
 * and checks the caller's access there (with the project, and the
 * environment when known, in scope), so every nested route gets the same
 * RBAC and the same 404 for rows in workspaces the caller can't see.
 *
 * @module
 */
import { builds, deployments, environments, projects, services, workspaces } from "@roundhouse/db";
import type { Action } from "@roundhouse/shared";
import { and, eq, isNull } from "drizzle-orm";
import { type AppContext, requireWorkspace, WORKSPACE_NOT_FOUND } from "../context";
import { ApiError, notFound } from "./errors";

type EnvironmentRow = typeof environments.$inferSelect;

/** The caller's membership in the resource's workspace, with their identity and audit actor. */
export type Caller = Awaited<ReturnType<typeof requireWorkspace>>;

/**
 * Checks `action` in `workspaceId`, reporting a non-member as "`what` not
 * found" so the message doesn't reveal that the resource exists elsewhere.
 */
async function authorize(
  c: AppContext,
  workspaceId: string,
  action: Action,
  what: string,
  scope: { projectId: string; environmentId?: string },
): Promise<Caller> {
  try {
    return await requireWorkspace(c, workspaceId, action, scope);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404 && err.message === WORKSPACE_NOT_FOUND) {
      throw notFound(what);
    }
    throw err;
  }
}

/**
 * Loads a live project and authorizes the caller.
 *
 * @param c - Request context.
 * @param projectId - From the route.
 * @param action - RBAC action of the route.
 * @param environmentId - Environment the action targets, so its protection applies.
 * @returns The project and the caller's membership.
 * @throws {ApiError} 404 when missing, deleted, or in a workspace the caller isn't in.
 */
export async function projectScope(
  c: AppContext,
  projectId: string,
  action: Action,
  environmentId?: string,
) {
  const [row] = await c
    .get("db")
    .select({ project: projects })
    .from(projects)
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(
      and(eq(projects.id, projectId), isNull(projects.deletedAt), isNull(workspaces.deletedAt)),
    )
    .limit(1);
  if (!row) throw notFound("Project");
  const caller = await authorize(c, row.project.workspaceId, action, "Project", {
    projectId,
    ...(environmentId !== undefined ? { environmentId } : {}),
  });
  return { project: row.project, caller };
}

/**
 * Loads a live service with its live project and authorizes the caller.
 *
 * @param c - Request context.
 * @param serviceId - From the route.
 * @param action - RBAC action of the route.
 * @param environmentId - Environment the action targets, so its protection applies.
 * @returns The service, its project, and the caller's membership.
 */
export async function serviceScope(
  c: AppContext,
  serviceId: string,
  action: Action,
  environmentId?: string,
) {
  const [row] = await c
    .get("db")
    .select({ service: services, project: projects })
    .from(services)
    .innerJoin(projects, eq(projects.id, services.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(
      and(
        eq(services.id, serviceId),
        isNull(services.deletedAt),
        isNull(projects.deletedAt),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Service");
  const caller = await authorize(c, row.project.workspaceId, action, "Service", {
    projectId: row.project.id,
    ...(environmentId !== undefined ? { environmentId } : {}),
  });
  return { service: row.service, project: row.project, caller };
}

/**
 * Loads a deployment of a live service and authorizes the caller.
 *
 * @param c - Request context.
 * @param deploymentId - From the route.
 * @param action - RBAC action of the route.
 * @returns The deployment, its service and project, and the caller's membership.
 */
export async function deploymentScope(c: AppContext, deploymentId: string, action: Action) {
  const [row] = await c
    .get("db")
    .select({ deployment: deployments, service: services, project: projects })
    .from(deployments)
    .innerJoin(services, eq(services.id, deployments.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(
      and(
        eq(deployments.id, deploymentId),
        isNull(services.deletedAt),
        isNull(projects.deletedAt),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Deployment");
  const caller = await authorize(c, row.project.workspaceId, action, "Deployment", {
    projectId: row.project.id,
    environmentId: row.deployment.environmentId,
  });
  return { deployment: row.deployment, service: row.service, project: row.project, caller };
}

/**
 * Loads a build of a live service and authorizes the caller.
 *
 * @param c - Request context.
 * @param buildId - From the route.
 * @param action - RBAC action of the route.
 * @returns The build, its service and project, and the caller's membership.
 */
export async function buildScope(c: AppContext, buildId: string, action: Action) {
  const [row] = await c
    .get("db")
    .select({ build: builds, service: services, project: projects })
    .from(builds)
    .innerJoin(services, eq(services.id, builds.serviceId))
    .innerJoin(projects, eq(projects.id, services.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(
      and(
        eq(builds.id, buildId),
        isNull(services.deletedAt),
        isNull(projects.deletedAt),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw notFound("Build");
  const caller = await authorize(c, row.project.workspaceId, action, "Build", {
    projectId: row.project.id,
  });
  return { build: row.build, service: row.service, project: row.project, caller };
}

/**
 * Loads an environment of `projectId`. IDs from another project are 404s.
 *
 * @param c - Request context.
 * @param projectId - Project the environment must belong to.
 * @param environmentId - From the query or body.
 * @returns The environment row.
 */
export async function environmentOf(
  c: AppContext,
  projectId: string,
  environmentId: string,
): Promise<EnvironmentRow> {
  const [row] = await c
    .get("db")
    .select()
    .from(environments)
    .where(and(eq(environments.id, environmentId), eq(environments.projectId, projectId)))
    .limit(1);
  if (!row) throw notFound("Environment");
  return row;
}
