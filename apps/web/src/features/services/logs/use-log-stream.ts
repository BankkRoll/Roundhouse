import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../../../lib/api/client";
import { deployApi } from "../../../lib/api/deploy-client";
import type { LogPage, RealtimeTopic } from "../../../lib/api/deploy-types";
import { useLogSubscription } from "../../../lib/realtime/provider";
import {
  EMPTY_BUFFER,
  type LogBuffer,
  withLiveLines,
  withNewestPage,
  withOlderPage,
} from "./log-buffer";

/** Lines requested per page (the API allows up to 1000). */
export const LOG_PAGE_SIZE = 500;

/** Which log to stream. */
export type LogSource =
  | { kind: "runtime"; deploymentId: string }
  | { kind: "build"; buildId: string };

/** State and controls returned by {@link useLogStream}. */
export interface LogStream {
  buffer: LogBuffer;
  status: "loading" | "ready" | "error";
  error: string | null;
  loadingOlder: boolean;
  /** Loads the page before the oldest loaded line. */
  loadOlder: () => Promise<void>;
  retry: () => void;
}

function fetchPage(
  source: LogSource,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<LogPage> {
  const page = { cursor, limit: LOG_PAGE_SIZE };
  return source.kind === "runtime"
    ? deployApi.getDeploymentLogs(source.deploymentId, page, signal)
    : deployApi.getBuildLogs(source.buildId, page, signal);
}

/**
 * Streams a deployment's runtime logs or a build's logs: the newest page over HTTP, then
 * live lines over the project's realtime socket (subscribed for exactly this topic),
 * with older pages on demand.
 *
 * @param source - Deployment or build to follow, or `null` for nothing.
 * @returns The buffer, load state and paging controls.
 */
export function useLogStream(source: LogSource | null): LogStream {
  const [buffer, setBuffer] = useState<LogBuffer>(EMPTY_BUFFER);
  const [status, setStatus] = useState<LogStream["status"]>("loading");
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const deploymentId = source?.kind === "runtime" ? source.deploymentId : undefined;
  const buildId = source?.kind === "build" ? source.buildId : undefined;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const bufferRef = useRef(buffer);
  bufferRef.current = buffer;

  const topic = useMemo<RealtimeTopic | null>(() => {
    if (deploymentId) return { kind: "deployment_logs", deployment_id: deploymentId };
    if (buildId) return { kind: "build_logs", build_id: buildId };
    return null;
  }, [deploymentId, buildId]);

  useLogSubscription(topic, (message) =>
    setBuffer((current) => withLiveLines(current, message.lines)),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is a retry counter; changing it refetches the same source
  useEffect(() => {
    setBuffer(EMPTY_BUFFER);
    setError(null);
    const current: LogSource | null = deploymentId
      ? { kind: "runtime", deploymentId }
      : buildId
        ? { kind: "build", buildId }
        : null;
    if (!current) return;
    setStatus("loading");
    const controller = new AbortController();
    fetchPage(current, null, controller.signal).then(
      (page) => {
        setBuffer((early) => withNewestPage(early, page.lines, page.next_cursor));
        setStatus("ready");
      },
      (cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(cause));
        setStatus("error");
      },
    );
    return () => controller.abort();
  }, [deploymentId, buildId, attempt]);

  const loadOlder = useCallback(async () => {
    const current = sourceRef.current;
    const cursor = bufferRef.current.olderCursor;
    if (!current || !cursor) return;
    setLoadingOlder(true);
    try {
      const page = await fetchPage(current, cursor);
      setBuffer((latest) =>
        latest.olderCursor === cursor
          ? withOlderPage(latest, page.lines, page.next_cursor)
          : latest,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoadingOlder(false);
    }
  }, []);

  return {
    buffer,
    status: source ? status : "ready",
    error,
    loadingOlder,
    loadOlder,
    retry: () => setAttempt((count) => count + 1),
  };
}
