/**
 * The copies a recovery left on lost servers (ADR 0004), as a row of the volume section:
 * each server's copy, its size, and where its cleanup stands, in words.
 *
 * @module
 */
import { Badge, SettingsRow } from "@roundhouse/ui";
import type { AbandonedCopy } from "../../lib/api/data-client";
import { formatBytes, formatRelativeTime, formatTimestamp, formatUntil } from "../../lib/format";
import { useAbandonedCopies } from "../../queries/databases";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

/** Each cleanup state's label and tone. */
export const COPY_STATE: Record<AbandonedCopy["state"], { label: string; tone: Tone }> = {
  waiting_for_server: { label: "Waiting for server", tone: "warning" },
  scheduled: { label: "Waiting for grace period", tone: "neutral" },
  kept: { label: "Kept", tone: "warning" },
  deleting: { label: "Cleanup requested", tone: "info" },
  deleted: { label: "Deleted", tone: "success" },
};

/**
 * What is happening to a copy, in a sentence: the API's reason when it is waiting or
 * kept, otherwise when it goes or went.
 *
 * @param copy - The copy.
 * @param now - Current unix ms.
 * @returns The sentence.
 */
export function describeCopy(copy: AbandonedCopy, now = Date.now()): string {
  const server = copy.node_name ?? "its server";
  switch (copy.state) {
    case "waiting_for_server":
      return copy.message ?? `${server} is offline; the copy is deleted once it is back.`;
    case "kept":
      return copy.message ?? "Kept for now.";
    case "scheduled":
      return copy.delete_after !== null && copy.delete_after > now
        ? `Deleted ${formatUntil(copy.delete_after, now)}, once the grace period ends (${formatTimestamp(copy.delete_after)}).`
        : "Deleted at the next check: the grace period has ended.";
    case "deleting":
      return `Delete sent to ${server} ${formatRelativeTime(copy.delete_sent_at, now)}; waiting for it to confirm. It is sent again if it doesn't.`;
    case "deleted":
      return copy.message ?? `Removed from ${server} ${formatRelativeTime(copy.cleaned_at, now)}.`;
  }
}

/** Props for {@link AbandonedCopiesRow}. */
export interface AbandonedCopiesRowProps {
  serviceId: string;
  environmentId: string;
}

/**
 * The abandoned copies of a service's volume, newest first, or nothing when there are
 * none. Read-only: cleanup runs on its own once a copy's server is back, the grace period
 * has ended, and the volume that replaced it holds the restored data.
 *
 * @param props - Service and environment.
 * @returns The row, or `null`.
 */
export function AbandonedCopiesRow({ serviceId, environmentId }: AbandonedCopiesRowProps) {
  const copies = useAbandonedCopies(serviceId, environmentId);
  const rows = copies.data?.copies ?? [];
  if (rows.length === 0) return null;
  const now = Date.now();
  return (
    <SettingsRow
      label="Copies left on lost servers"
      description="A recovery leaves the old copy where it was. Each one is deleted once its server is back, the grace period has ended and the new volume holds the restored data."
      control="wide"
    >
      <ul aria-label="Abandoned copies" className="grid gap-2">
        {rows.map((copy) => {
          const state = COPY_STATE[copy.state];
          return (
            <li
              key={copy.volume_id}
              className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-baseline gap-x-2 text-foreground">
                  <span className="font-medium">{copy.node_name ?? "Removed server"}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {copy.used_bytes === null
                      ? `${Math.round((copy.size_mb / 1024) * 100) / 100} GiB`
                      : formatBytes(copy.used_bytes)}
                    {copy.abandoned_at === null
                      ? ""
                      : `, left ${formatRelativeTime(copy.abandoned_at, now)}`}
                  </span>
                </p>
                <p className="text-[13px] leading-snug text-muted-foreground">
                  {describeCopy(copy, now)}
                </p>
              </div>
              <Badge tone={state.tone} className="justify-self-start sm:justify-self-end">
                {state.label}
              </Badge>
            </li>
          );
        })}
      </ul>
    </SettingsRow>
  );
}
