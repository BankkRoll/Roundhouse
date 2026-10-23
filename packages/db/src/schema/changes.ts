/**
 * Staged changes and the project canvas (ADR 0006): change sets, the ops
 * staged in them, and each project's canvas layout.
 *
 * @module
 */
import type {
  ChangeSetSource,
  ChangeSetStatus,
  DiffEntry,
  StagedChangeStatus,
  StagedOp,
} from "@roundhouse/shared";
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./auth";
import { id, json, timestamp, timestamps } from "./columns";
import { environments, projects, type SealedValue } from "./projects";
import { apiTokens } from "./workspaces";

/** Why an apply stopped, stored on the set so the review panel can show it. */
export interface ChangeSetError {
  code: string;
  message: string;
  details?: unknown;
}

/** What an op was staged against, checked again at apply time. */
export interface StagedBase {
  /** `config.patch`: the latest config version when staged; `null` for a new service. */
  config_version?: number | null;
  /** `variable.*`: the variable's version when staged; `null` when it didn't exist. */
  variable_version?: number | null;
  /** `service.update`: the fields it changes, as they were when staged. */
  service?: { name?: string; slug?: string; icon?: string | null };
}

/** Why an op can't apply as staged. */
export interface StagedConflict {
  /** What changed underneath it, value-free (`{ tier, fingerprint }` for variables). */
  theirs: unknown;
  /** Pointers both sides changed, for config patches. */
  paths?: string[];
  base_version: number | null;
  current_version: number | null;
  /** The target no longer exists. */
  deleted?: boolean;
}

/** A reviewable batch of operations against one environment. */
export const changeSets = sqliteTable(
  "change_sets",
  {
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environmentId: text("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    status: text("status").$type<ChangeSetStatus>().notNull().default("open"),
    /** The environment's shared dashboard draft; at most one is open per environment. */
    isDraft: integer("is_draft", { mode: "boolean" }).notNull().default(false),
    source: text("source").$type<ChangeSetSource>().notNull(),
    /** Template ID, source environment, or the token that proposed it. */
    sourceRef: text("source_ref"),
    title: text("title"),
    /** Bumped on every op change, so an apply runs exactly what was reviewed. */
    revision: integer("revision").notNull().default(1),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdByToken: text("created_by_token").references(() => apiTokens.id, {
      onDelete: "set null",
    }),
    approvedBy: text("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at"),
    appliedBy: text("applied_by").references(() => users.id, { onDelete: "set null" }),
    appliedAt: timestamp("applied_at"),
    error: json<ChangeSetError>("error"),
    ...timestamps,
  },
  (t) => [
    // NOTE: `applying` counts too, so a failed apply can always return its
    // draft to `open` without colliding with a draft created meanwhile.
    uniqueIndex("change_sets_draft_uq")
      .on(t.environmentId)
      .where(sql`status IN ('open', 'applying') AND is_draft = 1`),
    index("change_sets_env_status_idx").on(t.environmentId, t.status, t.id),
    index("change_sets_project_idx").on(t.projectId, t.id),
  ],
);

/** One operation of a change set, with the diff shown in review. */
export const stagedChanges = sqliteTable(
  "staged_changes",
  {
    id: id(),
    changeSetId: text("change_set_id")
      .notNull()
      .references(() => changeSets.id, { onDelete: "cascade" }),
    /** Apply order. */
    seq: integer("seq").notNull(),
    /** Coalescing key (`targetKeyOf`); unique per set. */
    targetKey: text("target_key").notNull(),
    op: json<StagedOp>("op").notNull(),
    /**
     * The value of a `variable.set`, sealed under the project DEK with AAD
     * `staged-variable:<change_set>:<staged_change>:<scope>:<service|->:<key>`.
     * Never returned; unsealed only to apply it.
     */
    valueSealed: json<SealedValue>("value_sealed"),
    base: json<StagedBase>("base").notNull(),
    /** Value-free diff computed when staged. */
    diff: json<DiffEntry[]>("diff").notNull(),
    status: text("status").$type<StagedChangeStatus>().notNull().default("pending"),
    conflict: json<StagedConflict>("conflict"),
    /** Set once applied: e.g. `{ "service_id": "svc_…" }` for a `service.create`. */
    result: json<Record<string, unknown>>("result"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("staged_changes_target_uq").on(t.changeSetId, t.targetKey),
    index("staged_changes_set_seq_idx").on(t.changeSetId, t.seq),
  ],
);

/**
 * Where each service sits on a project's canvas. Per project, not per
 * environment, so a service is in the same place everywhere. Cosmetic, so
 * neither staged nor audited.
 */
export const canvasLayouts = sqliteTable("canvas_layouts", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  positions: json<Record<string, { x: number; y: number }>>("positions").notNull(),
  version: integer("version").notNull().default(1),
  ...timestamps,
});
