/**
 * Read-only MCP tool for pull request previews (ADR 0007): `list_previews`.
 *
 * It checks the same action as `GET /v1/projects/{projectId}/previews`
 * (`projects:read`) through the same scope loader and returns the same
 * shape. Approving a fork PR, redeploying and tearing a preview down stay
 * with the dashboard, the CLI and the REST API: approving runs outside code,
 * which a person decides.
 *
 * @module
 */
import { previewEnvironments } from "@roundhouse/db";
import { type Action, type ApiTokenScope, ENDED_PREVIEW_STATUSES } from "@roundhouse/shared";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { z } from "zod";
import { listPreviews, policyOf } from "../contracts";
import { toApiPreview } from "../lib/previews/view";
import { projectScope } from "../lib/scope";
import type { McpTool } from "./tools";

const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

const listPreviewsTool: McpTool = {
  name: "list_previews",
  title: "List pull request previews",
  description:
    "Lists a project's pull request previews, newest activity first: PR number, title, author, " +
    "whether it comes from a fork, whether secrets were withheld, status (pending_approval, " +
    "fork_disabled, queued_limit, creating, active, failed, expired, closed), head commit, " +
    "expiry, and each service's URL and latest deployment status. Open previews by default.",
  input: z.object({
    project_id: z.string().min(1).max(128).describe("Project ID (from list_projects)"),
    include_closed: z.boolean().default(false).describe("Also list closed and expired previews."),
  }),
  scopes: [
    policyOf(listPreviews).action as Exclude<
      Action,
      "instance:manage" | "workspaces:create"
    > as ApiTokenScope,
  ],
  annotations: READ,
  async run({ c }, raw) {
    const input = raw as { project_id: string; include_closed: boolean };
    await projectScope(c, input.project_id, policyOf(listPreviews).action!);
    const db = c.get("db");
    const rows = await db
      .select()
      .from(previewEnvironments)
      .where(
        and(
          eq(previewEnvironments.projectId, input.project_id),
          input.include_closed
            ? undefined
            : notInArray(previewEnvironments.status, [...ENDED_PREVIEW_STATUSES]),
        ),
      )
      .orderBy(desc(previewEnvironments.lastActivityAt))
      .limit(100);
    const previews = [];
    for (const r of rows) previews.push(await toApiPreview(db, r));
    return { previews };
  },
};

/** The preview tools, in `tools/list` order. */
export const PREVIEW_TOOLS: readonly McpTool[] = [listPreviewsTool];
