import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api/client";
import type { AuditLogEntry } from "../lib/api/types";
import { queryKeys } from "./keys";

/** Rows fetched per audit log page. */
export const AUDIT_PAGE_SIZE = 50;

/**
 * Reads the audit log with cursor pagination.
 *
 * @param workspaceId - Workspace id.
 * @param enabled - Skip when the caller cannot read the audit log.
 * @returns An infinite query; call `fetchNextPage` to load older entries.
 */
export function useAuditLog(workspaceId: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: [...queryKeys.audit(workspaceId), "pages"],
    queryFn: ({ pageParam, signal }) =>
      api.listAuditLogs(workspaceId, { cursor: pageParam, limit: AUDIT_PAGE_SIZE }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    enabled,
  });
}

/**
 * Reads the newest audit entries for the home activity feed.
 *
 * @param workspaceId - Workspace id.
 * @param limit - Entries to show.
 * @param enabled - Skip when the caller cannot read the audit log.
 * @returns A query whose data is the newest entries.
 */
export function useRecentActivity(workspaceId: string, limit = 8, enabled = true) {
  return useQuery({
    queryKey: [...queryKeys.audit(workspaceId), "recent", limit],
    queryFn: ({ signal }) => api.listAuditLogs(workspaceId, { limit }, signal),
    select: (page) => page.items,
    refetchInterval: 30_000,
    enabled,
  });
}

/** Days of deploy history the home page draws. */
export const DEPLOY_HISTORY_DAYS = 7;

/** Deploys started on one calendar day, from the audit log. */
export interface DeployDay {
  /** Local midnight of the day, unix ms. */
  start: number;
  /** `deployment.created` entries that day. */
  deploys: number;
  /** `deployment.failed` entries that day. */
  failed: number;
}

/** What {@link useDeployHistory} returns once loaded. */
export interface DeployHistory {
  /** Oldest day first; the last entry is today. */
  days: DeployDay[];
  /** Sum of `deploys` over the window. */
  total: number;
  /** Time of the newest deploy in the window, or `null`. */
  lastAt: number | null;
  /** `true` when the page cap was hit before the window's start, so counts are a floor. */
  partial: boolean;
}

/** The audit API's largest page; a few pages cover a week for a busy workspace. */
const HISTORY_PAGE_SIZE = 200;
const HISTORY_MAX_PAGES = 5;

/**
 * Buckets audit entries into per-day deploy counts.
 *
 * @param entries - Audit entries, any order.
 * @param now - The current time.
 * @param partial - Whether the entries stop short of the window's start.
 * @returns The history, today last.
 */
export function bucketDeploys(
  entries: readonly AuditLogEntry[],
  now: number,
  partial = false,
): DeployHistory {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days: DeployDay[] = [];
  for (let offset = DEPLOY_HISTORY_DAYS - 1; offset >= 0; offset--) {
    const start = new Date(today);
    start.setDate(today.getDate() - offset);
    days.push({ start: start.getTime(), deploys: 0, failed: 0 });
  }
  let lastAt: number | null = null;
  for (const entry of entries) {
    if (entry.action !== "deployment.created" && entry.action !== "deployment.failed") continue;
    const day = days.findLast((candidate) => candidate.start <= entry.created_at);
    if (!day || entry.created_at > now) continue;
    if (entry.action === "deployment.failed") {
      day.failed += 1;
      continue;
    }
    day.deploys += 1;
    lastAt = Math.max(lastAt ?? 0, entry.created_at);
  }
  return { days, total: days.reduce((sum, day) => sum + day.deploys, 0), lastAt, partial };
}

/**
 * Deploys per day over the last week, counted from the audit log's
 * `deployment.created` entries: one request for most workspaces, and never one per
 * service. Readable only by roles with `audit:read`.
 *
 * @param workspaceId - Workspace id.
 * @param enabled - Skip when the caller cannot read the audit log.
 * @returns A query whose data is the bucketed history.
 */
export function useDeployHistory(workspaceId: string, enabled = true) {
  return useQuery({
    queryKey: [...queryKeys.audit(workspaceId), "deploy-history"],
    queryFn: async ({ signal }) => {
      const now = Date.now();
      const since = now - DEPLOY_HISTORY_DAYS * 24 * 60 * 60 * 1000;
      const entries: AuditLogEntry[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
        const result = await api.listAuditLogs(
          workspaceId,
          { cursor, limit: HISTORY_PAGE_SIZE },
          signal,
        );
        entries.push(...result.items);
        cursor = result.next_cursor;
        const oldest = result.items.at(-1)?.created_at ?? 0;
        if (!cursor || oldest < since) return bucketDeploys(entries, now);
      }
      return bucketDeploys(entries, now, true);
    },
    refetchInterval: 60_000,
    enabled,
  });
}
