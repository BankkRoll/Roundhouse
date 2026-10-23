import { cn } from "@roundhouse/ui";
import { AnsiText, useVirtualWindow } from "@roundhouse/ui/controls";
import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { formatLogTime } from "../../../lib/format";
import type { LogLine } from "./log-buffer";

/** Height of one log row in px. Rows never wrap, so the window math stays exact. */
export const LOG_ROW_HEIGHT = 20;

/** Distance from the bottom, in px, still treated as "at the bottom". */
const STICKY_THRESHOLD = LOG_ROW_HEIGHT * 2;

const STREAM_MARK: Record<LogLine["stream"], string> = {
  stdout: "border-transparent",
  stderr: "border-danger/70 bg-danger/5",
  system: "border-info/60 text-info",
};

const LogRow = memo(function LogRow({
  line,
  top,
  timestamps,
  highlight,
}: {
  line: LogLine;
  top: number;
  timestamps: boolean;
  highlight: string;
}) {
  return (
    <div
      data-log-row=""
      data-stream={line.stream}
      className={cn(
        "absolute left-0 flex min-w-full items-center gap-3 border-l-2 pr-4 pl-2 whitespace-pre hover:bg-muted/40",
        STREAM_MARK[line.stream],
      )}
      style={{ top, height: LOG_ROW_HEIGHT }}
    >
      {timestamps ? (
        <time
          dateTime={new Date(line.ts).toISOString()}
          className="shrink-0 text-subtle-foreground select-none"
        >
          {formatLogTime(line.ts)}
        </time>
      ) : null}
      <span className="text-foreground">
        <AnsiText text={line.text} highlight={highlight} />
      </span>
    </div>
  );
});

/** Props for {@link LogViewer}. */
export interface LogViewerProps {
  lines: readonly LogLine[];
  /** Keep the newest line in view as lines arrive. */
  follow: boolean;
  /** Called when scrolling pauses following (scrolled up) or resumes it (back at bottom). */
  onFollowChange: (follow: boolean) => void;
  timestamps: boolean;
  /** Search text to highlight. */
  highlight?: string;
  /** Called when the user scrolls to the very top, to load older lines. */
  onReachTop?: () => void;
  /** Accessible name. */
  label: string;
  className?: string;
}

/**
 * Virtualized log output: only the rows in view (plus overscan) are in the DOM, so tens
 * of thousands of lines scroll smoothly. Keeps the newest line in view while following,
 * pauses when the user scrolls up, and keeps the visible lines still when older ones are
 * prepended.
 *
 * @param props - Lines, follow state and display options.
 * @returns The viewer.
 */
export function LogViewer({
  lines,
  follow,
  onFollowChange,
  timestamps,
  highlight = "",
  onReachTop,
  label,
  className,
}: LogViewerProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const { window: view, sync } = useVirtualWindow(scroller, {
    count: lines.length,
    rowHeight: LOG_ROW_HEIGHT,
    overscan: 12,
  });
  const previous = useRef<{ firstId: number | undefined; length: number }>({
    firstId: undefined,
    length: 0,
  });
  const programmatic = useRef(false);

  // NOTE: Older pages are prepended; shift the scroll offset by their height so the
  // lines the user is reading stay where they are.
  useLayoutEffect(() => {
    const element = scroller.current;
    const before = previous.current;
    previous.current = { firstId: lines[0]?.id, length: lines.length };
    if (!element || before.firstId === undefined || follow) return;
    const index = lines.findIndex((line) => line.id === before.firstId);
    // Only a prepend adds exactly as many lines as the old first line moved down.
    if (index > 0 && lines.length - before.length === index) {
      programmatic.current = true;
      element.scrollTop += index * LOG_ROW_HEIGHT;
      sync();
    }
  }, [lines, follow, sync]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !follow || lines.length === 0) return;
    programmatic.current = true;
    element.scrollTop = element.scrollHeight;
    sync();
  }, [lines, follow, sync]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    function onScroll() {
      if (!element) return;
      if (programmatic.current) {
        programmatic.current = false;
        return;
      }
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      const atBottom = distance <= STICKY_THRESHOLD;
      if (atBottom !== follow) onFollowChange(atBottom);
      if (element.scrollTop === 0) onReachTop?.();
    }
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, [follow, onFollowChange, onReachTop]);

  const rows = [];
  for (let index = view.start; index < view.end; index++) {
    const line = lines[index];
    if (!line) continue;
    rows.push(
      <LogRow
        key={line.id}
        line={line}
        top={index * LOG_ROW_HEIGHT}
        timestamps={timestamps}
        highlight={highlight}
      />,
    );
  }

  return (
    <div
      ref={scroller}
      role="log"
      aria-label={label}
      aria-live="off"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the log must be keyboard-scrollable
      tabIndex={0}
      data-rendered-rows={rows.length}
      className={cn(
        "relative overflow-auto bg-background font-mono text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        className,
      )}
    >
      <div className="relative" style={{ height: view.totalHeight }}>
        {rows}
      </div>
    </div>
  );
}
