/**
 * Pull request previews (ADR 0007): each project's preview settings, and one
 * row per pull request and project tracking its preview environment.
 *
 * Nothing here holds a secret. The approval columns record who approved
 * which commit of a fork PR; the permission behind it is checked with
 * GitHub at approval time and never cached.
 *
 * @module
 */
import type {
  PreviewCaps,
  PreviewDatabaseSeed,
  PreviewForkPolicy,
  PreviewSameRepoSecrets,
  PreviewStatus,
} from "@roundhouse/shared";
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { id, json, timestamp, timestamps } from "./columns";
import { environments, projects } from "./projects";

/** A project's preview settings. No row means previews are off. */
export const previewSettings = sqliteTable("preview_settings", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  /** The environment previews copy their config and variables from. */
  baseEnvironmentId: text("base_environment_id")
    .notNull()
    .references((): AnySQLiteColumn => environments.id, { onDelete: "cascade" }),
  /** Service IDs built at the PR's head; `null` means every git service of the base environment. */
  services: json<string[]>("services"),
  /** Hours without activity before a preview is torn down, 1..720. */
  ttlHours: integer("ttl_hours").notNull().default(72),
  /** Previews `creating` or `active` at once, 1..50. */
  maxActive: integer("max_active").notNull().default(5),
  caps: json<PreviewCaps>("caps").notNull(),
  skipDrafts: integer("skip_drafts", { mode: "boolean" }).notNull().default(true),
  sameRepoSecrets: text("same_repo_secrets")
    .$type<PreviewSameRepoSecrets>()
    .notNull()
    .default("copy"),
  forkPolicy: text("fork_policy").$type<PreviewForkPolicy>().notNull().default("disabled"),
  approvalLabel: text("approval_label").notNull().default("roundhouse:preview"),
  databaseSeed: text("database_seed").$type<PreviewDatabaseSeed>().notNull().default("empty"),
  /** Merged into every preview service's `placement.node_selector`. */
  nodeSelector: json<Record<string, string>>("node_selector").notNull().default({}),
  /**
   * Builder nodes that may build fork PRs. Required for fork previews;
   * such nodes never build the project's other environments.
   */
  buildNodeSelector: json<Record<string, string>>("build_node_selector").notNull().default({}),
  /** Whether to keep a comment with the preview's links on the PR. */
  comment: integer("comment", { mode: "boolean" }).notNull().default(true),
  ...timestamps,
});

/** One pull request's preview of one project. */
export const previewEnvironments = sqliteTable(
  "preview_environments",
  {
    /** `prv_…`. */
    id: id(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The live environment; `null` while gated, queued, or after teardown. */
    environmentId: text("environment_id").references((): AnySQLiteColumn => environments.id, {
      onDelete: "set null",
    }),
    /** Base repository, `owner/repo`. */
    repoFullName: text("repo_full_name").notNull(),
    prNumber: integer("pr_number").notNull(),
    /** Our `ghi_…` installation the PR was delivered through. */
    installationRef: text("installation_ref").notNull(),
    headRef: text("head_ref").notNull(),
    headSha: text("head_sha").notNull(),
    /** `null` when the fork was deleted. */
    headRepoFullName: text("head_repo_full_name"),
    isFork: integer("is_fork", { mode: "boolean" }).notNull(),
    /** Whether the environment got placeholders instead of secrets. Sticky. */
    withheld: integer("withheld", { mode: "boolean" }).notNull().default(false),
    title: text("title").notNull().default(""),
    authorLogin: text("author_login").notNull(),
    authorAssociation: text("author_association").notNull(),
    draft: integer("draft", { mode: "boolean" }).notNull().default(false),
    status: text("status").$type<PreviewStatus>().notNull(),
    /** The fork head SHA someone with write access approved. */
    approvedSha: text("approved_sha"),
    approvedByLogin: text("approved_by_login"),
    githubCommentId: integer("github_comment_id"),
    /** `pull_request.updated_at` of the last applied event; older events are dropped. */
    lastEventAt: timestamp("last_event_at").notNull(),
    lastActivityAt: timestamp("last_activity_at").notNull(),
    expiresAt: timestamp("expires_at"),
    closedAt: timestamp("closed_at"),
    /** Why creating failed; never a variable value or build output. */
    error: text("error"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("preview_environments_pr_uq").on(t.projectId, t.repoFullName, t.prNumber),
    index("preview_environments_expiry_idx").on(t.expiresAt).where(sql`status = 'active'`),
    index("preview_environments_status_idx").on(t.projectId, t.status),
  ],
);
