/**
 * Typed endpoint functions and wire types for cron services (ADR 0010): schedule
 * preview, schedule state, runs, run logs, run now, cancel, pause and resume.
 *
 * Types come from the API's route contracts (`apps/api/src/contracts/cron.ts`).
 *
 * @module
 */
import type { CronRunStatus } from "@roundhouse/shared";
import type {
  BodyOf,
  CronState,
  LogPage,
  listCronRuns,
  previewCronSchedule,
  ResponseOf,
  triggerCronRun,
} from "../../../../api/src/contracts";
import type { ApiCronRun } from "../../../../api/src/schemas";
import { request } from "./client";

export type { CronState };

/** A run of a cron service, or a record of missed slots. */
export type CronRun = ApiCronRun;
/** A page of runs, newest slot first. */
export type CronRunPage = ResponseOf<typeof listCronRuns, 200>;
/** Paging and filter of the runs list. */
export interface CronRunListQuery {
  cursor?: string;
  limit?: number;
  status?: CronRunStatus;
}
/** The next slots of a schedule, or why it doesn't parse. */
export type CronPreview = ResponseOf<typeof previewCronSchedule, 200>;
/** `POST /v1/services/{serviceId}/cron-runs` body. */
export type TriggerCronRunBody = BodyOf<typeof triggerCronRun>;

const seg = encodeURIComponent;

/** Cron endpoints. */
export const cronApi = {
  /**
   * Previews a schedule's next slots on the server.
   *
   * @param projectId - Project the caller can read.
   * @param schedule - Expression or macro.
   * @param timezone - IANA zone.
   * @param signal - Abort signal.
   * @returns The slots, or the parse error with its span.
   */
  preview: (projectId: string, schedule: string, timezone: string, signal?: AbortSignal) =>
    request<CronPreview>("GET", `/v1/projects/${seg(projectId)}/cron/preview`, {
      query: { schedule, timezone },
      signal,
    }),
  /**
   * Reads a cron service's schedule state in an environment.
   *
   * @param serviceId - Service id.
   * @param environmentId - Environment id.
   * @param signal - Abort signal.
   * @returns Paused, next slot and the armed deployment's schedule.
   */
  getState: (serviceId: string, environmentId: string, signal?: AbortSignal) =>
    request<CronState>("GET", `/v1/services/${seg(serviceId)}/cron`, {
      query: { environment_id: environmentId },
      signal,
    }),
  /**
   * Lists a cron service's runs, newest slot first.
   *
   * @param serviceId - Service id.
   * @param environmentId - Environment id.
   * @param query - Cursor, page size and status filter.
   * @param signal - Abort signal.
   * @returns A page of runs.
   */
  listRuns: (
    serviceId: string,
    environmentId: string,
    query: CronRunListQuery = {},
    signal?: AbortSignal,
  ) =>
    request<CronRunPage>("GET", `/v1/services/${seg(serviceId)}/cron-runs`, {
      query: { environment_id: environmentId, ...query },
      signal,
    }),
  /**
   * Runs the armed deployment now. 409 `run_in_progress` unless `force`.
   *
   * @param serviceId - Service id.
   * @param body - Environment and `force`.
   * @returns The queued run.
   */
  trigger: (serviceId: string, body: TriggerCronRunBody) =>
    request<CronRun>("POST", `/v1/services/${seg(serviceId)}/cron-runs`, { body }),
  /**
   * Reads one run.
   *
   * @param runId - Run id.
   * @param signal - Abort signal.
   * @returns The run.
   */
  getRun: (runId: string, signal?: AbortSignal) =>
    request<CronRun>("GET", `/v1/cron-runs/${seg(runId)}`, { signal }),
  /**
   * Reads one page of a run's output, newest page first.
   *
   * @param runId - Run id.
   * @param page - Cursor from the previous page and page size.
   * @param signal - Abort signal.
   * @returns Lines in chronological order and the cursor to older ones.
   */
  getRunLogs: (
    runId: string,
    page: { cursor?: string | null; limit?: number } = {},
    signal?: AbortSignal,
  ) =>
    request<LogPage>("GET", `/v1/cron-runs/${seg(runId)}/logs`, {
      query: { cursor: page.cursor ?? undefined, limit: page.limit },
      signal,
    }),
  /**
   * Cancels a queued or running run.
   *
   * @param runId - Run id.
   * @returns The run as it stands after the request.
   */
  cancel: (runId: string) => request<CronRun>("POST", `/v1/cron-runs/${seg(runId)}/cancel`),
  /**
   * Stops scheduling runs until resumed.
   *
   * @param serviceId - Service id.
   * @param environmentId - Environment id.
   * @returns The new schedule state.
   */
  pause: (serviceId: string, environmentId: string) =>
    request<CronState>("POST", `/v1/services/${seg(serviceId)}/cron/pause`, {
      body: { environment_id: environmentId },
    }),
  /**
   * Resumes scheduling from the next future slot.
   *
   * @param serviceId - Service id.
   * @param environmentId - Environment id.
   * @returns The new schedule state.
   */
  resume: (serviceId: string, environmentId: string) =>
    request<CronState>("POST", `/v1/services/${seg(serviceId)}/cron/resume`, {
      body: { environment_id: environmentId },
    }),
};
