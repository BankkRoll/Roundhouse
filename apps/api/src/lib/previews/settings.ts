/**
 * A project's preview settings (ADR 0007, "Settings"): reading them with
 * their defaults, and validating and storing a change.
 *
 * @module
 */
import { type Db, environments, previewSettings } from "@roundhouse/db";
import {
  DEFAULT_PREVIEW_APPROVAL_LABEL,
  DEFAULT_PREVIEW_CAPS,
  PREVIEW_LIMITS,
} from "@roundhouse/shared";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import type { PreviewSettingsInputSchema, PreviewSettingsSchema } from "../../contracts/previews";
import { ApiError } from "../errors";
import { previewGitServices, pullRequestEventsSeen } from "./events";

/** A stored settings row. */
export type PreviewSettingsRow = typeof previewSettings.$inferSelect;

/** A validated settings write. */
export type PreviewSettingsInput = z.output<typeof PreviewSettingsInputSchema>;

/**
 * A project's settings row.
 *
 * @param db - Database client.
 * @param projectId - The project.
 * @returns The row, or `undefined` when previews were never configured.
 */
export async function loadPreviewSettings(
  db: Db,
  projectId: string,
): Promise<PreviewSettingsRow | undefined> {
  const [row] = await db
    .select()
    .from(previewSettings)
    .where(eq(previewSettings.projectId, projectId))
    .limit(1);
  return row;
}

/**
 * The API shape of a project's settings, or of the defaults (previews off,
 * based on production) while it has none.
 *
 * @param db - Database client.
 * @param projectId - The project.
 * @param row - Its stored settings, if any.
 * @returns The `PreviewSettings` wire shape.
 */
export async function toApiPreviewSettings(
  db: Db,
  projectId: string,
  row: PreviewSettingsRow | undefined,
): Promise<z.infer<typeof PreviewSettingsSchema>> {
  const seen = await pullRequestEventsSeen(db);
  if (row) {
    return {
      project_id: projectId,
      configured: true,
      enabled: row.enabled,
      base_environment_id: row.baseEnvironmentId,
      services: row.services ?? null,
      ttl_hours: row.ttlHours,
      max_active: row.maxActive,
      caps: row.caps,
      skip_drafts: row.skipDrafts,
      same_repo_secrets: row.sameRepoSecrets,
      fork_policy: row.forkPolicy,
      approval_label: row.approvalLabel,
      database_seed: row.databaseSeed,
      node_selector: row.nodeSelector,
      build_node_selector: row.buildNodeSelector,
      comment: row.comment,
      pull_request_events_seen: seen,
      updated_at: +row.updatedAt,
    };
  }
  const [production] = await db
    .select({ id: environments.id })
    .from(environments)
    .where(and(eq(environments.projectId, projectId), eq(environments.kind, "production")))
    .limit(1);
  return {
    project_id: projectId,
    configured: false,
    enabled: false,
    base_environment_id: production?.id ?? null,
    services: null,
    ttl_hours: PREVIEW_LIMITS.ttlHours.default,
    max_active: PREVIEW_LIMITS.maxActive.default,
    caps: DEFAULT_PREVIEW_CAPS,
    skip_drafts: true,
    same_repo_secrets: "copy",
    fork_policy: "disabled",
    approval_label: DEFAULT_PREVIEW_APPROVAL_LABEL,
    database_seed: "empty",
    node_selector: {},
    build_node_selector: {},
    comment: true,
    pull_request_events_seen: seen,
    updated_at: null,
  };
}

/**
 * Validates and stores a project's settings.
 *
 * Refuses (400):
 * - a base environment outside the project, retired, or itself a preview;
 * - `services` naming anything but git services of the base environment;
 * - `fork_policy: "approval"` without `build_node_selector`
 *   (`build_node_selector_required`): fork code must build on builder nodes
 *   of its own (ADR 0014 section 14).
 *
 * @param db - Database client.
 * @param projectId - The project.
 * @param input - The validated body.
 * @returns The stored row.
 * @throws {ApiError} 400 as above.
 */
export async function savePreviewSettings(
  db: Db,
  projectId: string,
  input: PreviewSettingsInput,
): Promise<PreviewSettingsRow> {
  const [base] = await db
    .select()
    .from(environments)
    .where(
      and(eq(environments.id, input.base_environment_id), eq(environments.projectId, projectId)),
    )
    .limit(1);
  if (!base || base.retiredAt) {
    throw new ApiError(400, "invalid_request", "base_environment_id: no such environment", [
      { field: "base_environment_id", code: "not_found", message: "No such environment" },
    ]);
  }
  if (base.kind === "preview") {
    throw new ApiError(
      400,
      "invalid_request",
      "base_environment_id: a preview environment can't be the base of previews",
      [
        {
          field: "base_environment_id",
          code: "invalid",
          message: "Pick a non-preview environment",
        },
      ],
    );
  }
  const services = input.services === null ? null : [...new Set(input.services)].sort();
  if (services) {
    const git = new Set(
      (await previewGitServices(db, projectId, base.id, null)).map((t) => t.serviceId),
    );
    const unknown = services.filter((id) => !git.has(id));
    if (unknown.length) {
      throw new ApiError(
        400,
        "invalid_request",
        `services: ${unknown.join(", ")} ${unknown.length === 1 ? "is not a git service" : "are not git services"} of the base environment`,
        unknown.map((id) => ({
          field: "services",
          code: "invalid",
          message: `${id} is not a git service of the base environment`,
        })),
      );
    }
  }
  if (input.fork_policy === "approval" && !Object.keys(input.build_node_selector).length) {
    throw new ApiError(
      400,
      "build_node_selector_required",
      "build_node_selector: fork previews run untrusted code, so they need builder nodes of their own; label a dedicated builder node and select it here",
      [
        {
          field: "build_node_selector",
          code: "build_node_selector_required",
          message: "Required while fork_policy is approval",
        },
      ],
    );
  }
  const values = {
    enabled: input.enabled,
    baseEnvironmentId: base.id,
    services,
    ttlHours: input.ttl_hours,
    maxActive: input.max_active,
    caps: input.caps,
    skipDrafts: input.skip_drafts,
    sameRepoSecrets: input.same_repo_secrets,
    forkPolicy: input.fork_policy,
    approvalLabel: input.approval_label,
    databaseSeed: input.database_seed,
    nodeSelector: input.node_selector,
    buildNodeSelector: input.build_node_selector,
    comment: input.comment,
  };
  const [row] = await db
    .insert(previewSettings)
    .values({ projectId, ...values })
    .onConflictDoUpdate({
      target: previewSettings.projectId,
      set: { ...values, updatedAt: new Date() },
    })
    .returning();
  return row!;
}
