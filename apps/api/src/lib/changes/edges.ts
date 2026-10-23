/**
 * Explicit "connects to" edges of the project canvas (ADR 0006 "Canvas data
 * model"): dependencies no variable reference expresses, drawn by someone.
 * They are display data only and change no networking, so they are not
 * staged; adding and removing one is audited.
 *
 * Services are soft-deleted, so every read joins both ends to live services:
 * an edge to a deleted service simply stops showing.
 *
 * @module
 */
import { type Db, serviceEdges, services } from "@roundhouse/db";
import { MAX_SERVICE_EDGES, newId } from "@roundhouse/shared";
import { alias } from "drizzle-orm/sqlite-core";
import { and, count, eq, isNull } from "drizzle-orm";
import { ApiError, conflict, isUniqueViolation, notFound } from "../errors";

/** A `service_edges` row. */
export type ServiceEdgeRow = typeof serviceEdges.$inferSelect;

const fromService = alias(services, "from_service");
const toService = alias(services, "to_service");

/**
 * A project's edges whose two services are both live.
 *
 * @param db - Database client.
 * @param projectId - The project.
 * @returns The edges, oldest first.
 */
export async function listEdges(db: Db, projectId: string): Promise<ServiceEdgeRow[]> {
  const rows = await db
    .select({ edge: serviceEdges })
    .from(serviceEdges)
    .innerJoin(fromService, eq(fromService.id, serviceEdges.fromServiceId))
    .innerJoin(toService, eq(toService.id, serviceEdges.toServiceId))
    .where(
      and(
        eq(serviceEdges.projectId, projectId),
        isNull(fromService.deletedAt),
        isNull(toService.deletedAt),
      ),
    )
    .orderBy(serviceEdges.id);
  return rows.map((r) => r.edge);
}

/**
 * Connects two live services of a project.
 *
 * @param db - Database client.
 * @param input - Project, both ends, and who draws it.
 * @returns The new edge.
 * @throws {ApiError} 404 for a service outside the project, 409 when it exists or at the limit.
 */
export async function addEdge(
  db: Db,
  input: { projectId: string; from: string; to: string; userId: string },
): Promise<ServiceEdgeRow> {
  if (input.from === input.to) {
    throw new ApiError(400, "invalid_request", "A service can't connect to itself");
  }
  const ends = await db
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.projectId, input.projectId), isNull(services.deletedAt)));
  const live = new Set(ends.map((e) => e.id));
  if (!live.has(input.from) || !live.has(input.to)) throw notFound("Service");
  const [{ n }] = (await db
    .select({ n: count() })
    .from(serviceEdges)
    .where(eq(serviceEdges.projectId, input.projectId))) as [{ n: number }];
  if (n >= MAX_SERVICE_EDGES) {
    throw conflict(`A project holds at most ${MAX_SERVICE_EDGES} connections`);
  }
  try {
    const [row] = await db
      .insert(serviceEdges)
      .values({
        id: newId("serviceEdge"),
        projectId: input.projectId,
        fromServiceId: input.from,
        toServiceId: input.to,
        createdBy: input.userId,
      })
      .returning();
    return row!;
  } catch (err) {
    if (isUniqueViolation(err, "service_edges")) {
      throw conflict("These services are already connected");
    }
    throw err;
  }
}

/**
 * Removes an edge of a project.
 *
 * @param db - Database client.
 * @param projectId - The project.
 * @param edgeId - The edge.
 * @returns The removed edge.
 * @throws {ApiError} 404 when it isn't the project's.
 */
export async function removeEdge(
  db: Db,
  projectId: string,
  edgeId: string,
): Promise<ServiceEdgeRow> {
  const [row] = await db
    .delete(serviceEdges)
    .where(and(eq(serviceEdges.id, edgeId), eq(serviceEdges.projectId, projectId)))
    .returning();
  if (!row) throw notFound("Connection");
  return row;
}

/**
 * @param e - Edge row.
 * @returns The `ServiceEdge` wire shape.
 */
export function toApiEdge(e: ServiceEdgeRow) {
  return {
    id: e.id,
    project_id: e.projectId,
    from_service_id: e.fromServiceId,
    to_service_id: e.toServiceId,
    created_by: e.createdBy,
    created_at: +e.createdAt,
  };
}
