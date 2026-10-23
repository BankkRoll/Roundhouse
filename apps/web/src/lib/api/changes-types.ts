/**
 * Wire types for the project canvas and staged change routes (ADR 0006), derived from
 * the API's route definitions (`apps/api/src/contracts/changes.ts`) so the dashboard
 * cannot drift from them.
 *
 * Type-only: nothing from the API source reaches the bundle.
 *
 * @module
 */
import type {
  applyChangeSet,
  BodyOf,
  ChangeSet,
  ChangeSetReview,
  ChangeSetSummary,
  getCanvas,
  ResponseOf,
  StagedChange,
  StagedOpInput,
  updateCanvasLayout,
} from "../../../../api/src/contracts";

export type { ChangeSet, ChangeSetReview, ChangeSetSummary, StagedChange, StagedOpInput };

/** What the canvas draws for one environment. */
export type Canvas = ResponseOf<typeof getCanvas, 200>;
/** A service on the canvas, live or staged for creation. */
export type CanvasNode = Canvas["nodes"][number];
/** A reference edge between two services. */
export type CanvasEdge = Canvas["edges"][number];
/** Positions by service id. */
export type CanvasPositions = Canvas["positions"];
/** `PATCH /v1/projects/{projectId}/canvas/layout` body. */
export type UpdateCanvasLayoutBody = BodyOf<typeof updateCanvasLayout>;
/** A stored canvas layout. */
export type CanvasLayout = ResponseOf<typeof updateCanvasLayout, 200>;
/** `POST /v1/change-sets/{changeSetId}/apply` body. */
export type ApplyChangeSetBody = BodyOf<typeof applyChangeSet>;
/** What applying a change set started. */
export type AppliedChangeSet = ResponseOf<typeof applyChangeSet, 200>;
/** One changed value of a staged change. */
export type DiffEntry = StagedChange["diff"][number];
