/**
 * Change set and canvas schemas that realtime messages also carry (ADR
 * 0006); re-exported from `../schemas`. Request bodies, staged op shapes and
 * full change sets live in `../contracts/changes`.
 *
 * SECURITY: Nothing here can carry a variable value. Staged variables appear
 * as key, tier and fingerprint only.
 *
 * @module
 */
import { z } from "@hono/zod-openapi";
import {
  CHANGE_SET_REVIEW_STATUSES,
  CHANGE_SET_SOURCES,
  CHANGE_SET_STATUSES,
  MAX_PRESENCE_SELECTION,
  PRESENCE_COLORS,
  PRESENCE_EDIT_PARTS,
} from "@roundhouse/shared";

const Millis = z.number().int().openapi({ description: "Unix time in milliseconds" });

/** A change set without its ops: what lists and realtime frames carry. */
export const ChangeSetSummarySchema = z
  .object({
    id: z.string(),
    project_id: z.string(),
    environment_id: z.string(),
    status: z.enum(CHANGE_SET_STATUSES),
    /** The environment's shared dashboard draft. */
    is_draft: z.boolean(),
    source: z.enum(CHANGE_SET_SOURCES),
    title: z.string().nullable(),
    /** Bumped on every change to the set; send it back as `expected_revision`. */
    revision: z.number().int().positive(),
    op_count: z.number().int().nonnegative(),
    conflicted_count: z.number().int().nonnegative(),
    created_by: z.string().nullable(),
    /** The API token that proposed it, for sets staged over MCP or the API. */
    created_by_token: z.string().nullable(),
    /**
     * Where the set is in review. `approved` always covers the current
     * revision: any edit moves an approved or rejected set back to `submitted`.
     */
    review_status: z.enum(CHANGE_SET_REVIEW_STATUSES),
    submitted_by: z.string().nullable(),
    submitted_at: Millis.nullable(),
    approved_by: z.string().nullable(),
    approved_at: Millis.nullable(),
    rejected_by: z.string().nullable(),
    rejected_at: Millis.nullable(),
    /** The latest submitter's or reviewer's note. User-written: show it as text. */
    review_note: z.string().nullable(),
    applied_by: z.string().nullable(),
    applied_at: Millis.nullable(),
    /** Why the last apply stopped, if it did. */
    error: z.object({ code: z.string(), message: z.string() }).nullable(),
    created_at: Millis,
    updated_at: Millis,
  })
  .openapi("ChangeSetSummary");

/** A canvas position, in canvas units. */
export const CanvasPositionSchema = z
  .object({
    x: z.number().int().min(-100_000).max(100_000),
    y: z.number().int().min(-100_000).max(100_000),
  })
  .openapi("CanvasPosition");

/** Where services sit on a project's canvas, by service ID. */
export const CanvasPositionsSchema = z
  .record(z.string().max(128), CanvasPositionSchema)
  .refine((p) => Object.keys(p).length <= 500, { message: "at most 500 positions" })
  .openapi("CanvasPositions");

/** Realtime frame: a change set's ops, status or revision changed. */
export const ChangeSetUpdatedMessageSchema = z.object({
  type: z.literal("change_set.updated"),
  change_set: ChangeSetSummarySchema,
});

/** Realtime frame: a change set was applied and these deployments started. */
export const ChangeSetAppliedMessageSchema = z.object({
  type: z.literal("change_set.applied"),
  change_set_id: z.string(),
  environment_id: z.string(),
  deployment_ids: z.array(z.string()),
});

/** Realtime frame: someone moved services on the canvas. */
export const CanvasLayoutUpdatedMessageSchema = z.object({
  type: z.literal("canvas.layout_updated"),
  positions: CanvasPositionsSchema,
  version: z.number().int().positive(),
  by_user_id: z.string(),
});

/** Realtime frame: someone added or removed a "connects to" edge. */
export const CanvasEdgesUpdatedMessageSchema = z.object({
  type: z.literal("canvas.edges_updated"),
  by_user_id: z.string(),
});

/** Which part of which service a user has open for editing. */
export const PresenceEditingSchema = z
  .object({ service_id: z.string().max(128), part: z.enum(PRESENCE_EDIT_PARTS) })
  .openapi("PresenceEditing");

const PresenceTarget = z
  .string()
  .regex(/^([a-z]{1,8}_[A-Za-z0-9]{1,64}|new:[1-9][0-9]{0,3})$/, "expected a service ID");

/**
 * Browser → server: what this tab is looking at (ADR 0006). Only IDs: the
 * room never relays names or values a client sends.
 */
export const PresenceUpdateMessageSchema = z.object({
  type: z.literal("presence.update"),
  environment_id: PresenceTarget.nullable(),
  selection: z.array(PresenceTarget).max(MAX_PRESENCE_SELECTION),
  editing: z
    .object({ service_id: PresenceTarget, part: z.enum(PRESENCE_EDIT_PARTS) })
    .nullable(),
});

/** A presence colour index; see `presenceColor`. */
export const PresenceColorSchema = z
  .number()
  .int()
  .min(0)
  .max(PRESENCE_COLORS - 1);
