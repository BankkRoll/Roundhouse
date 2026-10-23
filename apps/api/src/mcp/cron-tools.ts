/**
 * Read-only MCP tool for cron services (ADR 0010): `list_cron_runs`.
 *
 * It checks the same action as `GET /v1/services/{serviceId}/cron-runs`
 * (`services:read`) through the same scope loader. Run now, cancel and
 * pause stay with the dashboard, the CLI and the REST API.
 *
 * @module
 */
import { cronRuns, environments } from "@roundhouse/db";
import { type Action, type ApiTokenScope, CRON_RUN_STATUSES } from "@roundhouse/shared";
import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";
import type { AppContext } from "../context";
import { listCronRuns, policyOf } from "../contracts";
import { toApiCronRun } from "../lib/cron/runs";
import { notFound } from "../lib/errors";
import { environmentOf, serviceScope } from "../lib/scope";
import type { McpTool } from "./tools";

const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

const scopeOf = (route: Parameters<typeof policyOf>[0]): ApiTokenScope =>
  policyOf(route).action as Exclude<Action, "instance:manage" | "workspaces:create">;

async function environmentFor(c: AppContext, projectId: string, environmentId?: string) {
  if (environmentId) return environmentOf(c, projectId, environmentId);
  const [row] = await c
    .get("db")
    .select()
    .from(environments)
    .where(and(eq(environments.projectId, projectId), eq(environments.kind, "production")))
    .limit(1);
  if (!row) throw notFound("Environment");
  return row;
}

const listCronRunsTool: McpTool = {
  name: "list_cron_runs",
  title: "List cron runs",
  description:
    "Lists a cron service's runs in one environment, newest slot first: status (succeeded, " +
    "failed, timed_out, missed, skipped, …), trigger, slot time, start and finish, exit code and " +
    "error. Pass next_cursor back as cursor for older runs; read a run's output with " +
    "GET /v1/cron-runs/{runId}/logs.",
  input: z.object({
    service_id: z.string().min(1).max(128).describe("Service ID"),
    environment_id: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Environment ID (from get_project). Defaults to the project's production one."),
    status: z.enum(CRON_RUN_STATUSES).optional().describe("Only runs with this status."),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z
      .string()
      .regex(/^crn_[0-9A-Za-z]{1,64}$/, "expected a next_cursor from a previous call")
      .optional(),
  }),
  scopes: [scopeOf(listCronRuns)],
  annotations: READ,
  async run({ c }, raw) {
    const input = raw as {
      service_id: string;
      environment_id?: string;
      status?: (typeof CRON_RUN_STATUSES)[number];
      limit: number;
      cursor?: string;
    };
    const { project } = await serviceScope(c, input.service_id, policyOf(listCronRuns).action!);
    const environment = await environmentFor(c, project.id, input.environment_id);
    const rows = await c
      .get("db")
      .select()
      .from(cronRuns)
      .where(
        and(
          eq(cronRuns.serviceId, input.service_id),
          eq(cronRuns.environmentId, environment.id),
          ...(input.status ? [eq(cronRuns.status, input.status)] : []),
          ...(input.cursor ? [lt(cronRuns.id, input.cursor)] : []),
        ),
      )
      .orderBy(desc(cronRuns.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    return {
      environment_id: environment.id,
      runs: page.map((r) => toApiCronRun(r, project.id)),
      next_cursor: rows.length > input.limit ? page[page.length - 1]!.id : null,
    };
  },
};

/** The cron tools, in `tools/list` order. */
export const CRON_TOOLS: readonly McpTool[] = [listCronRunsTool];
