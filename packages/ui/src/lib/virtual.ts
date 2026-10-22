/**
 * Windowing for long fixed-height lists (log viewers): only the rows in view, plus a
 * little overscan, are mounted, so 50k lines scroll like 50.
 *
 * Fixed row heights keep the math exact and O(1) per scroll event; callers that need
 * wrapping should render a horizontally scrollable row instead.
 *
 * @module
 */
import { type RefObject, useCallback, useLayoutEffect, useState } from "react";

/** Input to {@link computeVirtualWindow}. */
export interface VirtualWindowInput {
  /** Total number of rows. */
  count: number;
  /** Height of every row in px. */
  rowHeight: number;
  /** Scroll offset of the viewport in px. */
  scrollTop: number;
  /** Visible height of the viewport in px. */
  viewportHeight: number;
  /** Extra rows rendered above and below the viewport. Defaults to 8. */
  overscan?: number;
}

/** Rows to render and where to put them. */
export interface VirtualWindow {
  /** First rendered row index (inclusive). */
  start: number;
  /** Last rendered row index (exclusive). */
  end: number;
  /** Offset of row `start` from the top of the list, in px. */
  offsetTop: number;
  /** Height of the whole list, in px. */
  totalHeight: number;
}

/**
 * Computes which rows of a fixed-height list intersect the viewport.
 *
 * @param input - Row count, row height and viewport geometry.
 * @returns The half-open row range `[start, end)` and layout offsets.
 * @example
 * computeVirtualWindow({ count: 10_000, rowHeight: 20, scrollTop: 2000, viewportHeight: 400 });
 * // { start: 92, end: 128, offsetTop: 1840, totalHeight: 200000 }
 */
export function computeVirtualWindow({
  count,
  rowHeight,
  scrollTop,
  viewportHeight,
  overscan = 8,
}: VirtualWindowInput): VirtualWindow {
  const safeCount = Math.max(0, Math.floor(count));
  const height = rowHeight > 0 ? rowHeight : 1;
  const totalHeight = safeCount * height;
  const top = Math.min(Math.max(0, scrollTop), Math.max(0, totalHeight - viewportHeight));
  const first = Math.floor(top / height);
  const last = Math.ceil((top + Math.max(0, viewportHeight)) / height);
  const start = Math.max(0, first - overscan);
  const end = Math.min(safeCount, last + overscan);
  return { start, end: Math.max(start, end), offsetTop: start * height, totalHeight };
}

/** Options for {@link useVirtualWindow}. */
export interface UseVirtualWindowOptions {
  /** Total number of rows. */
  count: number;
  /** Height of every row in px. */
  rowHeight: number;
  /** Extra rows above and below the viewport. */
  overscan?: number;
  /**
   * Viewport height to assume before the element can be measured (and in environments
   * without layout, such as tests). Defaults to 600.
   */
  fallbackHeight?: number;
}

/**
 * Tracks a scroll container and returns the rows to render.
 *
 * @param ref - The scrollable element.
 * @param options - Row count, height and overscan.
 * @returns The current window and a function to re-read the scroll position, for
 *   callers that change `scrollTop` themselves.
 */
export function useVirtualWindow(
  ref: RefObject<HTMLElement | null>,
  { count, rowHeight, overscan, fallbackHeight = 600 }: UseVirtualWindowOptions,
): { window: VirtualWindow; sync: () => void } {
  const [geometry, setGeometry] = useState({ scrollTop: 0, viewportHeight: fallbackHeight });

  const sync = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    const viewportHeight = element.clientHeight || fallbackHeight;
    const scrollTop = element.scrollTop;
    setGeometry((previous) =>
      previous.scrollTop === scrollTop && previous.viewportHeight === viewportHeight
        ? previous
        : { scrollTop, viewportHeight },
    );
  }, [ref, fallbackHeight]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    sync();
    element.addEventListener("scroll", sync, { passive: true });
    // COMPAT: ResizeObserver is missing in jsdom; the fallback height covers tests.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", sync);
      observer?.disconnect();
    };
  }, [ref, sync]);

  return {
    window: computeVirtualWindow({ count, rowHeight, overscan, ...geometry }),
    sync,
  };
}
