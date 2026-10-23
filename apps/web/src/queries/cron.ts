/**
 * Cron service queries (ADR 0010): schedule state, the runs list, run now, cancel,
 * pause and resume, and how `cron_run.updated` frames update the cache.
 *
 * @module
 */
import { type CronRunStatus, isTerminalCronRunStatus } from "@roundhouse/shared";
import {
  type InfiniteData,
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type CronRun, type CronRunPage, type CronState, cronApi } from "../lib/api/cron-client";

/** Runs fetched per page. */
export const CRON_RUNS_PAGE_SIZE = 25;

/** How often active runs are refetched, in case realtime updates are missed. */
export const CRON_RUN_POLL_MS = 10_000;

/** Query keys of cron services; the service ones sit under the service key. */
export const cronKeys = {
  state: (serviceId: string, environmentId: string) =>
    ["services", serviceId, "cron", environmentId] as const,
  /** Every runs list of a service in an environment, whatever the filter. */
  runsAll: (serviceId: string, environmentId: string) =>
    ["services", serviceId, "cron-runs", environmentId] as const,
  runs: (serviceId: string, environmentId: string, status: CronRunStatus | null) =>
    ["services", serviceId, "cron-runs", environmentId, status ?? "all"] as const,
  run: (runId: string) => ["cron-runs", runId] as const,
};

/**
 * Writes a run into every cached runs list of its service (replacing it, or prepending
 * it to the unfiltered list and to a list filtered by its status) and into its own query.
 * Copies newer than `run` (by `updated_at`) are kept.
 *
 * @param queryClient - Shared query client.
 * @param run - The run as the API last reported it.
 */
export function upsertCronRun(queryClient: QueryClient, run: CronRun): void {
  const entries = queryClient.getQueriesData<InfiniteData<CronRunPage, string | null>>({
    queryKey: cronKeys.runsAll(run.service_id, run.environment_id),
  });
  for (const [key, data] of entries) {
    if (!data) continue;
    const filter = key[4];
    let found = false;
    const pages = data.pages.map((page) => ({
      ...page,
      runs: page.runs.flatMap((entry) => {
        if (entry.id !== run.id) return [entry];
        found = true;
        if (entry.updated_at > run.updated_at) return [entry];
        return filter === "all" || filter === run.status ? [run] : [];
      }),
    }));
    if (!found && pages[0] && (filter === "all" || filter === run.status)) {
      pages[0] = { ...pages[0], runs: [run, ...pages[0].runs] };
    }
    queryClient.setQueryData(key, { ...data, pages });
  }
  queryClient.setQueryData<CronRun>(cronKeys.run(run.id), (cached: CronRun | undefined) =>
    cached && cached.updated_at > run.updated_at ? cached : run,
  );
}

/**
 * Applies a `cron_run.updated` frame: the run goes into the cached lists, and the
 * schedule state (next slot, last slot) is refetched since a new slot moved it.
 *
 * @param queryClient - Shared query client.
 * @param run - The run in the frame.
 */
export function applyCronRunUpdate(queryClient: QueryClient, run: CronRun): void {
  upsertCronRun(queryClient, run);
  void queryClient.invalidateQueries({
    queryKey: cronKeys.state(run.service_id, run.environment_id),
  });
}

/**
 * A cron service's schedule state in an environment.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id; the query waits while it is unknown.
 * @param enabled - Skip for services that aren't cron jobs.
 * @returns The state query.
 */
export function useCronState(serviceId: string, environmentId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: cronKeys.state(serviceId, environmentId ?? ""),
    queryFn: ({ signal }) => cronApi.getState(serviceId, environmentId!, signal),
    enabled: enabled && Boolean(environmentId),
  });
}

/**
 * A cron service's runs, newest slot first, with cursor paging. Polls while the newest
 * page holds a run that hasn't ended.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id; the query waits while it is unknown.
 * @param status - Only runs with this status, or `null` for all.
 * @returns An infinite query; `fetchNextPage` loads older runs.
 */
export function useCronRuns(
  serviceId: string,
  environmentId: string | undefined,
  status: CronRunStatus | null = null,
) {
  return useInfiniteQuery({
    queryKey: cronKeys.runs(serviceId, environmentId ?? "", status),
    queryFn: ({ pageParam, signal }) =>
      cronApi.listRuns(
        serviceId,
        environmentId ?? "",
        {
          limit: CRON_RUNS_PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
          ...(status ? { status } : {}),
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
    enabled: Boolean(environmentId),
    refetchInterval: (query) =>
      query.state.data?.pages[0]?.runs.some((run) => !isTerminalCronRunStatus(run.status))
        ? CRON_RUN_POLL_MS
        : false,
  });
}

/**
 * One run, polled until it ends.
 *
 * @param runId - Run id, or `null` for none.
 * @returns The run query.
 */
export function useCronRun(runId: string | null) {
  return useQuery({
    queryKey: cronKeys.run(runId ?? ""),
    queryFn: ({ signal }) => cronApi.getRun(runId!, signal),
    enabled: runId !== null,
    refetchInterval: (query) =>
      query.state.data && !isTerminalCronRunStatus(query.state.data.status)
        ? CRON_RUN_POLL_MS
        : false,
  });
}

/**
 * Runs a cron service now. Without `force` a run in progress is a 409
 * `run_in_progress`; with it the running one is cancelled first.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id.
 * @returns A mutation taking `{ force }`.
 */
export function useTriggerCronRun(serviceId: string, environmentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ force }: { force?: boolean } = {}) =>
      cronApi.trigger(serviceId, { environment_id: environmentId, ...(force ? { force } : {}) }),
    onSuccess: (run) => upsertCronRun(queryClient, run),
  });
}

/**
 * Cancels a queued or running run.
 *
 * @returns A mutation taking the run id.
 */
export function useCancelCronRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => cronApi.cancel(runId),
    onSuccess: (run) => upsertCronRun(queryClient, run),
  });
}

/**
 * Pauses or resumes a cron service's schedule and caches the new state.
 *
 * @param serviceId - Service id.
 * @param environmentId - Environment id.
 * @returns A mutation taking `true` to pause, `false` to resume.
 */
export function useSetCronPaused(serviceId: string, environmentId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (paused: boolean) =>
      paused ? cronApi.pause(serviceId, environmentId) : cronApi.resume(serviceId, environmentId),
    onSuccess: (state: CronState) =>
      queryClient.setQueryData(cronKeys.state(serviceId, environmentId), state),
  });
}
