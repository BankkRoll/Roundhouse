import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../lib/api/client";
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
