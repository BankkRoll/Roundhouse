/**
 * Publishing to a project's `ProjectRoom`, the Durable Object that fans
 * updates out to the dashboard's realtime sockets. Publishing is best-effort:
 * the database is the source of truth and the dashboard refetches on
 * reconnect, so a lost message must never fail the operation that sent it.
 * Writers that change who may see a project also ask its room to re-check
 * open sockets ({@link revalidateProjects}), which also re-checks the
 * project's open web shells (`./shell`).
 *
 * @module
 */
import { type Db, projects } from "@roundhouse/db";
import { and, eq, isNull } from "drizzle-orm";
import type { RevalidateFilter } from "../durable/project-room";
import type { RealtimeServerMessage } from "../schemas";
import type { ApiDeploymentWithoutProject } from "./serialize";
import { revalidateShellSessions, type ShellEnv } from "./shell";

/**
 * A message as callers hand it to {@link publish}: a deployment may come
 * without `project_id`, which the room's project fills in.
 */
export type PublishedMessage =
  | Exclude<RealtimeServerMessage, { type: "deployment.updated" }>
  | {
      type: "deployment.updated";
      deployment: ApiDeploymentWithoutProject & { project_id?: string };
    };

/** The bindings publishing needs. */
interface RoomEnv {
  PROJECT_ROOM: DurableObjectNamespace<import("../durable/project-room").ProjectRoom>;
}

/**
 * Returns the room of a project.
 *
 * @param env - Worker bindings.
 * @param projectId - The project.
 * @returns A stub for its `ProjectRoom`.
 */
export function projectRoom(env: RoomEnv, projectId: string) {
  return env.PROJECT_ROOM.get(env.PROJECT_ROOM.idFromName(projectId));
}

/**
 * Sends a message to every socket of a project (log lines only reach
 * subscribers; see `ProjectRoom`).
 *
 * @param env - Worker bindings.
 * @param projectId - The project.
 * @param message - Message to fan out.
 */
export async function publish(
  env: RoomEnv,
  projectId: string,
  message: PublishedMessage,
): Promise<void> {
  const complete: RealtimeServerMessage =
    message.type === "deployment.updated"
      ? { ...message, deployment: { ...message.deployment, project_id: projectId } }
      : message;
  try {
    await projectRoom(env, projectId).broadcast(complete);
  } catch (err) {
    console.warn("realtime publish failed", err);
  }
}

/**
 * Asks the rooms of `projectIds` to re-check their sockets now (ADR 0014
 * "Realtime"), and the nodes running the projects' open web shells to
 * re-check those (ADR 0014 §15), after a change to who may see them has
 * committed. Best effort like {@link publish}: the periodic re-checks still
 * bound a missed call to a minute.
 *
 * @param env - Worker bindings.
 * @param projectIds - Projects whose rooms and shells to re-check.
 * @param filter - Only these users' or tokens' sockets; every socket when omitted.
 * @returns Sockets closed across the rooms (shells not counted).
 */
export async function revalidateProjects(
  env: RoomEnv & ShellEnv,
  projectIds: readonly string[],
  filter: RevalidateFilter = {},
): Promise<number> {
  const results = await Promise.allSettled(
    projectIds.map((id) => projectRoom(env, id).revalidate(filter)),
  );
  let closed = 0;
  for (const r of results) {
    if (r.status === "fulfilled") closed += r.value;
    else console.warn("realtime revalidate failed", r.reason);
  }
  await revalidateShellSessions(env, { ...filter, projectIds });
  return closed;
}

/**
 * {@link revalidateProjects} for every live project of a workspace, for
 * changes that reach all of them (membership, roles, teams, access settings,
 * tokens).
 *
 * @param db - Database client.
 * @param env - Worker bindings.
 * @param workspaceId - The workspace.
 * @param filter - Only these users' or tokens' sockets; every socket when omitted.
 * @returns Sockets closed across the rooms.
 */
export async function revalidateWorkspace(
  db: Db,
  env: RoomEnv & ShellEnv,
  workspaceId: string,
  filter: RevalidateFilter = {},
): Promise<number> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)));
  return revalidateProjects(
    env,
    rows.map((r) => r.id),
    filter,
  );
}
