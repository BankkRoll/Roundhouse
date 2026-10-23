import { cn } from "@roundhouse/ui";
import {
  type KeyboardEvent,
  type PointerEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { EMPTY, formatTimestamp } from "../../lib/format";
import {
  areaPath,
  formatTimeTick,
  hasSamples,
  linePath,
  nearestIndex,
  niceTicks,
  segments,
  summarize,
  timeTicks,
} from "./scale";
import type { ChartLimit, ChartSeries } from "./series";

/** Props for {@link MetricChart}. */
export interface MetricChartProps {
  title: string;
  series: readonly ChartSeries[];
  /** Range start, unix ms. */
  from: number;
  /** Range end, unix ms. */
  to: number;
  /** Step between points, seconds; bar width for `kind="bars"`. */
  stepS: number;
  /** Formats a value for ticks, the tooltip and the summary. */
  format: (value: number) => string;
  /** Round value ticks in powers of 1024 (bytes). */
  binary?: boolean;
  /** A dashed reference line, such as a configured limit. */
  limit?: ChartLimit | null;
  kind?: "line" | "bars";
  /** Plot height in pixels. */
  height?: number;
  className?: string;
}

const MARGIN = { top: 8, right: 8, bottom: 22, left: 56 } as const;
/** Width used before the container is measured (and in jsdom, which never lays out). */
const DEFAULT_WIDTH = 640;
/**
 * A limit far above the data would flatten every line onto the baseline. Past this
 * multiple of the peak, the limit is named in the legend but left off the plot.
 */
const LIMIT_HEADROOM = 4;

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.clientWidth > 0) setWidth(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next && next > 0) setWidth(Math.round(next));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

function describe(
  title: string,
  series: readonly ChartSeries[],
  format: (v: number) => string,
  limit: ChartLimit | null | undefined,
  empty: boolean,
): string {
  if (empty) return `${title}: no samples in this range.`;
  const parts = series.map((s) => {
    const { avg, max, latest } = summarize(s.points);
    const f = (v: number | null) => (v === null ? EMPTY : format(v));
    const name = series.length > 1 ? `${s.label} ` : "";
    return `${name}average ${f(avg)}, peak ${f(max)}, latest ${f(latest)}`;
  });
  return `${title}: ${parts.join("; ")}.${limit ? ` ${limit.label}.` : ""}`;
}

/**
 * A time-series chart drawn as plain SVG: value and time axes, one line (or bar set) per
 * series with breaks at gaps, an optional dashed limit line, and a hover crosshair with
 * a tooltip. Arrow keys move the crosshair when the chart has focus. A single series is
 * filled down to the baseline; several are lines with a legend, so identity never rests
 * on colour alone. The SVG is `role="img"` with a summary (average, peak, latest) as its
 * name.
 *
 * It fills its container's width (measured with a `ResizeObserver`) and draws with the
 * theme's CSS variables, so it follows light and dark.
 *
 * @param props - Title, series, range, formatter, limit and kind.
 * @returns The chart.
 * @example
 * <MetricChart title="CPU" series={[cpu]} from={from} to={to} stepS={15}
 *   format={formatMillicores} limit={{ value: 500, label: "Limit 500m" }} />
 */
export function MetricChart({
  title,
  series,
  from,
  to,
  stepS,
  format,
  binary = false,
  limit,
  kind = "line",
  height = 168,
  className,
}: MetricChartProps) {
  const { ref, width } = useWidth();
  const titleId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const empty = !hasSamples(series);

  const plotW = Math.max(40, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(40, height - MARGIN.top - MARGIN.bottom);
  const span = Math.max(1, to - from);
  const x = (t: number) => MARGIN.left + ((t - from) / span) * plotW;

  const peak = useMemo(() => {
    let max = 0;
    for (const s of series) for (const [, v] of s.points) if (v !== null && v > max) max = v;
    return max;
  }, [series]);
  const limitOnPlot = Boolean(
    limit && limit.value > 0 && (peak === 0 || limit.value <= peak * LIMIT_HEADROOM),
  );
  const yTicks = niceTicks(Math.max(peak, limitOnPlot && limit ? limit.value : 0), {
    binary,
    count: plotH < 100 ? 2 : 4,
  });
  const yTop = yTicks.at(-1)!;
  const y = (v: number) => MARGIN.top + plotH - (v / yTop) * plotH;
  const baseline = y(0);
  const time = timeTicks(from, to, Math.floor(plotW / 84));

  const times = useMemo(() => {
    const all = new Set<number>();
    for (const s of series) for (const [t] of s.points) all.add(t);
    return [...all].sort((a, b) => a - b);
  }, [series]);
  const hoverT = hover === null ? null : (times[hover] ?? null);

  function onPointerMove(e: PointerEvent<SVGRectElement>) {
    const rect = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
    const scale = rect && rect.width > 0 ? width / rect.width : 1;
    const px = (e.clientX - (rect?.left ?? 0)) * scale;
    const t = from + ((px - MARGIN.left) / plotW) * span;
    const index = nearestIndex(times, t);
    setHover(index < 0 ? null : index);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (times.length === 0) return;
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
    if (e.key === "Escape") {
      setHover(null);
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setHover(e.key === "Home" ? 0 : times.length - 1);
      return;
    }
    const delta = moves[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    setHover((current) =>
      Math.min(
        times.length - 1,
        Math.max(0, (current ?? times.length - 1) + (current === null ? 0 : delta)),
      ),
    );
  }

  const stepPx = (stepS * 1000 * plotW) / span;
  const barW = Math.max(1, stepPx - Math.min(2, stepPx / 3));
  const single = series.length === 1;
  const legend = series.length > 1 || limit;
  const tooltipLeft = hoverT !== null && x(hoverT) > width / 2;
  const summary = describe(title, series, format, limit, empty);

  return (
    <figure className={cn("min-w-0", className)} aria-labelledby={titleId}>
      <figcaption className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id={titleId} className="text-sm font-medium text-foreground">
          {title}
        </h3>
        {legend ? (
          <ul
            className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
            aria-label={`${title} legend`}
          >
            {series.slice(0, 8).map((s) => (
              <li key={s.id} className="flex items-center gap-1.5" title={s.workloadId}>
                <span
                  aria-hidden="true"
                  className="h-0.5 w-3 rounded-full"
                  style={{ background: s.color }}
                />
                <span className={cn(s.workloadId && "font-mono")}>{s.label}</span>
              </li>
            ))}
            {series.length > 8 ? <li>{series.length - 8} more</li> : null}
            {limit ? (
              <li className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="h-0 w-3 border-t border-dashed border-muted-foreground"
                />
                {limit.label}
                {limitOnPlot ? null : <span className="text-subtle-foreground">(off scale)</span>}
              </li>
            ) : null}
          </ul>
        ) : null}
      </figcaption>
      <div
        ref={ref}
        role="slider"
        aria-label={summary}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, times.length - 1)}
        aria-valuenow={hover ?? 0}
        aria-valuetext={hoverT === null ? "No sample selected" : formatTimestamp(hoverT)}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onBlur={() => setHover(null)}
        className="relative rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <svg
          role="img"
          aria-label={summary}
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="block overflow-visible"
        >
          <g className="text-[10px] tabular-nums">
            {yTicks.map((tick) => (
              <g key={tick}>
                <line
                  x1={MARGIN.left}
                  x2={MARGIN.left + plotW}
                  y1={y(tick)}
                  y2={y(tick)}
                  stroke="var(--border)"
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <text
                  x={MARGIN.left - 8}
                  y={y(tick)}
                  dy="0.32em"
                  textAnchor="end"
                  fill="var(--subtle-foreground)"
                >
                  {format(tick)}
                </text>
              </g>
            ))}
            {time.ticks.map((tick) => (
              <text
                key={tick}
                x={x(tick)}
                y={height - 6}
                textAnchor="middle"
                fill="var(--subtle-foreground)"
              >
                {formatTimeTick(tick, time.intervalMs)}
              </text>
            ))}
          </g>
          {empty ? (
            <text
              x={MARGIN.left + plotW / 2}
              y={MARGIN.top + plotH / 2}
              textAnchor="middle"
              dy="0.32em"
              className="text-xs"
              fill="var(--muted-foreground)"
            >
              No samples in this range
            </text>
          ) : null}
          <g>
            {series.map((s) =>
              kind === "bars" ? (
                <g key={s.id} data-series={s.id} fill={s.color}>
                  {s.points.map(([t, v]) =>
                    v === null || v <= 0 ? null : (
                      <rect
                        key={t}
                        x={x(t)}
                        y={y(v)}
                        width={barW}
                        height={Math.max(1, baseline - y(v))}
                        rx={Math.min(2, barW / 2)}
                      />
                    ),
                  )}
                </g>
              ) : (
                <g key={s.id} data-series={s.id}>
                  {segments(s.points, x, y).map((run) =>
                    run.length === 1 ? (
                      <circle
                        key={run[0]!.x}
                        cx={run[0]!.x}
                        cy={run[0]!.y}
                        r={1.75}
                        fill={s.color}
                      />
                    ) : (
                      <g key={run[0]!.x}>
                        {single ? (
                          <path d={areaPath(run, baseline)} fill={s.color} fillOpacity={0.12} />
                        ) : null}
                        <path
                          d={linePath(run)}
                          data-run=""
                          fill="none"
                          stroke={s.color}
                          strokeWidth={single ? 1.75 : 1.5}
                          strokeLinejoin="round"
                          strokeLinecap="round"
                          vectorEffect="non-scaling-stroke"
                        />
                      </g>
                    ),
                  )}
                </g>
              ),
            )}
            {limit && limitOnPlot ? (
              <line
                data-limit=""
                x1={MARGIN.left}
                x2={MARGIN.left + plotW}
                y1={y(limit.value)}
                y2={y(limit.value)}
                stroke="var(--muted-foreground)"
                strokeWidth={1}
                strokeDasharray="4 3"
                shapeRendering="crispEdges"
              />
            ) : null}
            {hoverT !== null ? (
              <g data-crosshair="">
                <line
                  x1={x(hoverT)}
                  x2={x(hoverT)}
                  y1={MARGIN.top}
                  y2={MARGIN.top + plotH}
                  stroke="var(--border-strong)"
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                {kind === "line"
                  ? series.map((s) => {
                      const v = s.points.find(([t]) => t === hoverT)?.[1];
                      return v === null || v === undefined ? null : (
                        <circle
                          key={s.id}
                          cx={x(hoverT)}
                          cy={y(v)}
                          r={3.5}
                          fill={s.color}
                          stroke="var(--background)"
                          strokeWidth={2}
                        />
                      );
                    })
                  : null}
              </g>
            ) : null}
          </g>
          <rect
            x={MARGIN.left}
            y={MARGIN.top}
            width={plotW}
            height={plotH}
            fill="transparent"
            onPointerMove={onPointerMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>
        {hoverT !== null ? (
          <div
            role="tooltip"
            className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-md border border-border-strong bg-surface-raised px-2.5 py-2 text-xs shadow-md"
            style={tooltipLeft ? { right: width - x(hoverT) + 10 } : { left: x(hoverT) + 10 }}
          >
            <p className="mb-1.5 font-mono text-[11px] text-muted-foreground">
              {formatTimestamp(hoverT)}
            </p>
            <ul className="grid gap-1">
              {series.map((s) => {
                const v = s.points.find(([t]) => t === hoverT)?.[1];
                return (
                  <li key={s.id} className="flex items-center justify-between gap-4">
                    <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                      <span
                        aria-hidden="true"
                        className="size-2 shrink-0 rounded-full"
                        style={{ background: s.color }}
                      />
                      <span className={cn("truncate", s.workloadId && "font-mono")}>{s.label}</span>
                    </span>
                    <span className="tabular-nums text-foreground">
                      {v === null || v === undefined ? "no data" : format(v)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </figure>
  );
}
