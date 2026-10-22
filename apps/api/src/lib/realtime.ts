/**
 * Publishing to a project's `ProjectRoom`, the Durable Object that fans
 * updates out to the dashboard's realtime sockets. Publishing is best-effort:
 * the database is the source of truth and the dashboard refetches on
 * reconnect, so a lost message must never fail the operation that sent it.
 *
 * @module
 */
import type { RealtimeServerMessage } from "../schemas";

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
  message: RealtimeServerMessage,
): Promise<void> {
  try {
    await projectRoom(env, projectId).broadcast(message);
  } catch (err) {
    console.warn("realtime publish failed", err);
  }
}
