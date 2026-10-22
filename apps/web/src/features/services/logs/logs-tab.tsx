import { Button, copyText, EmptyState, Input, Label, Select, Skeleton, toast } from "@openrail/ui";
import { SegmentedControl, Switch } from "@openrail/ui/controls";
import { useNavigate } from "@tanstack/react-router";
import { ArrowDownToLineIcon, CopyIcon, PauseIcon, ScrollTextIcon, SearchIcon } from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";
import { ErrorState } from "../../../components/error-state";
import { errorMessage } from "../../../lib/api/client";
import type { Deployment } from "../../../lib/api/deploy-types";
import { formatRelativeTime } from "../../../lib/format";
import { useRealtime } from "../../../lib/realtime/provider";
import { useNow } from "../../../lib/use-now";
import { useDeployments } from "../../../queries/deployments";
import { useProjectEnvironment } from "../../projects/use-project-environment";
import { currentDeploymentId, deploymentRef } from "../deployments/deployment-format";
import type { ServicePageProps } from "../service-layout";
import { filterLines, LOG_STREAMS, type LogStream, linesToText } from "./log-buffer";
import { LogViewer } from "./log-viewer";
import { type LogSource, useLogStream } from "./use-log-stream";

/** Props for {@link LogsTab}. */
export interface LogsTabProps extends ServicePageProps {
  /** Deployment from the URL; defaults to the one serving traffic, else the newest. */
  deploymentId?: string;
  /** Build or runtime output from the URL. */
  source?: "build" | "runtime";
}

function defaultSource(deployment: Deployment | undefined): "build" | "runtime" {
  if (!deployment?.build_id) return "runtime";
  return deployment.status === "queued" || deployment.status === "building" ? "build" : "runtime";
}

/**
 * Logs of one deployment: build output or the replicas' runtime output, loaded newest
 * page first and then tailed live over the project's socket. Stream filter, search
 * within loaded lines, timestamps, follow/pause, copy and paging back through history.
 *
 * @param props - Ids, and the deployment and source from the URL.
 * @returns The tab.
 */
export function LogsTab({
  workspaceId,
  projectId,
  serviceId,
  deploymentId,
  source: sourceParam,
}: LogsTabProps) {
  const navigate = useNavigate();
  const { environment, envParam } = useProjectEnvironment(projectId);
  const deployments = useDeployments(serviceId, environment?.id);
  const realtime = useRealtime();
  const now = useNow(30_000);
  const [streams, setStreams] = useState<ReadonlySet<LogStream>>(() => new Set(LOG_STREAMS));
  const [query, setQuery] = useState("");
  const [timestamps, setTimestamps] = useState(true);
  const [follow, setFollow] = useState(true);
  const searchId = useId();
  const timestampsId = useId();
  const deploymentSelectId = useId();

  const rows = useMemo(
    () => deployments.data?.pages.flatMap((page) => page.deployments) ?? [],
    [deployments.data],
  );
  const selected =
    rows.find((entry) => entry.id === deploymentId) ??
    rows.find((entry) => entry.id === currentDeploymentId(rows)) ??
    rows[0];
  const kind =
    sourceParam === "build" && !selected?.build_id
      ? "runtime"
      : (sourceParam ?? defaultSource(selected));
  const logSource: LogSource | null = !selected
    ? null
    : kind === "build" && selected.build_id
      ? { kind: "build", buildId: selected.build_id }
      : { kind: "runtime", deploymentId: selected.id };
  const stream = useLogStream(logSource);
  const visible = useMemo(
    () => filterLines(stream.buffer.lines, { streams, query }),
    [stream.buffer.lines, streams, query],
  );
  const { loadOlder } = stream;
  const onReachTop = useCallback(() => void loadOlder(), [loadOlder]);

  function setSearch(next: { deployment?: string; source?: "build" | "runtime" }) {
    setFollow(true);
    void navigate({
      to: "/w/$workspaceId/p/$projectId/s/$serviceId/logs",
      params: { workspaceId, projectId, serviceId },
      search: {
        env: envParam,
        deployment: next.deployment ?? selected?.id,
        source: next.source ?? (next.deployment ? undefined : kind),
      },
      replace: true,
    });
  }

  function toggleStream(name: LogStream) {
    setStreams((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function copyVisible() {
    const ok = await copyText(linesToText(visible, timestamps));
    toast(
      ok
        ? {
            title: `Copied ${visible.length} ${visible.length === 1 ? "line" : "lines"}`,
            tone: "success",
          }
        : { title: "Could not copy to the clipboard", tone: "error" },
    );
  }

  if (deployments.isPending) return <Skeleton className="h-96 rounded-lg" />;
  if (deployments.isError) {
    return (
      <ErrorState
        message={errorMessage(deployments.error)}
        onRetry={() => void deployments.refetch()}
      />
    );
  }
  if (!selected) {
    return (
      <EmptyState
        icon={<ScrollTextIcon />}
        title="No logs yet"
        description="Logs appear here once the service has been deployed."
        className="py-16"
      />
    );
  }

  const live = realtime?.status === "open";

  return (
    <section aria-label="Logs" className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={deploymentSelectId} className="sr-only">
          Deployment
        </Label>
        <Select
          id={deploymentSelectId}
          value={selected.id}
          onChange={(event) => setSearch({ deployment: event.target.value })}
          className="h-7 w-auto max-w-72 font-mono text-xs"
        >
          {rows.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {deploymentRef(entry)} · {entry.status.replace("_", " ")} ·{" "}
              {formatRelativeTime(entry.created_at, now)}
            </option>
          ))}
        </Select>
        <SegmentedControl<"runtime" | "build">
          label="Log source"
          value={kind}
          onValueChange={(next) => setSearch({ source: next })}
          options={
            selected.build_id
              ? [
                  { value: "runtime", label: "Runtime" },
                  { value: "build", label: "Build" },
                ]
              : [{ value: "runtime", label: "Runtime" }]
          }
        />
        {/* biome-ignore lint/a11y/useSemanticElements: a toolbar of toggle buttons, not a form fieldset */}
        <div role="group" aria-label="Streams" className="flex items-center gap-1">
          {LOG_STREAMS.map((name) => (
            <button
              key={name}
              type="button"
              aria-pressed={streams.has(name)}
              onClick={() => toggleStream(name)}
              className="h-7 rounded-md border border-border-strong px-2 font-mono text-[11px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-accent-text aria-pressed:bg-accent-subtle aria-pressed:text-foreground"
            >
              {name}
            </button>
          ))}
        </div>
        <div className="relative min-w-40 flex-1">
          <SearchIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground"
            aria-hidden="true"
          />
          <Label htmlFor={searchId} className="sr-only">
            Search loaded lines
          </Label>
          <Input
            id={searchId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search loaded lines"
            className="h-7 pl-8 font-mono text-xs"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Switch id={timestampsId} checked={timestamps} onCheckedChange={setTimestamps} />
          <Label htmlFor={timestampsId}>Timestamps</Label>
        </div>
        <Button
          size="sm"
          variant={follow ? "secondary" : "primary"}
          aria-pressed={follow}
          onClick={() => setFollow((value) => !value)}
        >
          {follow ? <PauseIcon /> : <ArrowDownToLineIcon />}
          {follow ? "Pause" : "Follow"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void copyVisible()}
          disabled={visible.length === 0}
        >
          <CopyIcon />
          Copy
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <div className="flex items-center justify-between gap-2 border-b border-border bg-surface px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
          <span className="flex items-center gap-2">
            {stream.buffer.olderCursor ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-[11px]"
                loading={stream.loadingOlder}
                onClick={() => void stream.loadOlder()}
              >
                Load older
              </Button>
            ) : (
              <span>
                {stream.buffer.trimmed
                  ? "Older lines were dropped to keep the viewer fast"
                  : "Beginning of log"}
              </span>
            )}
          </span>
          <span className="flex items-center gap-3" aria-live="polite">
            <span>
              {query || streams.size < LOG_STREAMS.length
                ? `${visible.length} of ${stream.buffer.lines.length} lines`
                : `${stream.buffer.lines.length} lines`}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className={
                  live
                    ? "size-1.5 rounded-full bg-success"
                    : "size-1.5 rounded-full bg-subtle-foreground"
                }
              />
              {live ? (follow ? "live" : "paused") : "not live"}
            </span>
          </span>
        </div>
        {stream.status === "error" ? (
          <div className="p-4">
            <ErrorState message={stream.error ?? "Could not load logs."} onRetry={stream.retry} />
          </div>
        ) : stream.status === "loading" ? (
          <div className="grid gap-1.5 bg-background p-3" aria-busy="true">
            {[0, 1, 2, 3, 4, 5].map((row) => (
              <Skeleton
                key={row}
                className="h-3.5"
                style={{ width: `${40 + ((row * 37) % 50)}%` }}
              />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <p className="bg-background px-4 py-10 text-center text-sm text-muted-foreground">
            {stream.buffer.lines.length === 0
              ? kind === "build"
                ? "No build output yet."
                : "No output yet. New lines appear here as the service writes them."
              : "No loaded lines match."}
          </p>
        ) : (
          <LogViewer
            lines={visible}
            follow={follow}
            onFollowChange={setFollow}
            timestamps={timestamps}
            highlight={query.trim()}
            onReachTop={stream.buffer.olderCursor ? onReachTop : undefined}
            label={`${kind === "build" ? "Build" : "Runtime"} logs of ${deploymentRef(selected)}`}
            className="h-[calc(100dvh-24rem)] min-h-80"
          />
        )}
      </div>
    </section>
  );
}
