import { Button, cn, StatusDot, statusMeta } from "@roundhouse/ui";
import { BoxIcon, DatabaseIcon, MaximizeIcon, MinusIcon, PlusIcon, TimerIcon } from "lucide-react";
import {
  type KeyboardEvent,
  memo,
  type PointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Canvas, CanvasEdge, CanvasNode } from "../../lib/api/changes-types";
import type { ServiceView } from "../projects/service-list";
import {
  autoLayout,
  edgePath,
  fitView,
  keyMove,
  NODE_HEIGHT,
  NODE_WIDTH,
  type Point,
  type Viewport,
  zoomAt,
} from "./layout";

/** Props for {@link ProjectCanvas}. */
export interface ProjectCanvasProps {
  canvas: Canvas;
  /** Live state per service id (status, config version), from the project summary. */
  views: ReadonlyMap<string, ServiceView>;
  selectedId: string | null;
  /** A node was activated (click or Enter). */
  onOpen: (id: string) => void;
  /** Escape on the canvas. */
  onClearSelection: () => void;
  /** A node was dropped or moved with the keyboard; persist it. */
  onMove?: (id: string, position: Point) => void;
  className?: string;
}

const KIND_ICONS = { app: BoxIcon, database: DatabaseIcon, cron: TimerIcon } as const;

/** Pixels a pointer must travel before a press on a node becomes a drag. */
const DRAG_THRESHOLD = 4;

function nodeLabel(node: CanvasNode, view: ServiceView | undefined): string {
  const status = view?.latest ? statusMeta(view.latest.status, "deployment").label : "not deployed";
  const staged =
    node.staged === "create"
      ? "staged for creation"
      : node.staged === "delete"
        ? "staged for deletion"
        : node.staged_ops
          ? `${node.staged_ops} staged change${node.staged_ops === 1 ? "" : "s"}`
          : null;
  return [node.name, `${node.kind} service`, node.staged === "create" ? null : status, staged]
    .filter(Boolean)
    .join(", ");
}

interface NodeProps {
  node: CanvasNode;
  view: ServiceView | undefined;
  position: Point;
  selected: boolean;
  movable: boolean;
  onPointerDown: (id: string, event: PointerEvent<HTMLButtonElement>) => void;
  onKeyDown: (id: string, event: KeyboardEvent<HTMLButtonElement>) => void;
  onClick: (id: string) => void;
}

const ServiceNode = memo(function ServiceNode({
  node,
  view,
  position,
  selected,
  movable,
  onPointerDown,
  onKeyDown,
  onClick,
}: NodeProps) {
  const Icon = KIND_ICONS[node.kind] ?? BoxIcon;
  const status = view?.latest?.status;
  return (
    <button
      type="button"
      data-node-id={node.id}
      aria-label={nodeLabel(node, view)}
      aria-pressed={selected}
      onPointerDown={(e) => onPointerDown(node.id, e)}
      onKeyDown={(e) => onKeyDown(node.id, e)}
      onClick={() => onClick(node.id)}
      style={{
        transform: `translate(${position.x}px, ${position.y}px)`,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      }}
      className={cn(
        "absolute top-0 left-0 flex flex-col justify-between rounded-md border bg-surface px-3 py-2.5 text-left shadow-sm outline-none transition-[border-color,box-shadow] select-none",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        movable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
        selected ? "border-accent shadow-accent/20" : "border-border-strong hover:border-input",
        node.staged === "create" && "border-dashed border-accent/70",
        node.staged === "delete" && "border-dashed border-danger/70 opacity-70",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span
          className={cn(
            "truncate text-sm font-semibold text-foreground",
            node.staged === "delete" && "line-through",
          )}
        >
          {node.name}
        </span>
        {node.staged_ops > 0 ? (
          <span
            aria-hidden="true"
            className="ml-auto inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-sm bg-accent-subtle px-1 font-mono text-[10px] text-accent-text"
          >
            {node.staged === "create" ? "new" : node.staged_ops}
          </span>
        ) : null}
      </span>
      <span
        className="flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground"
        aria-hidden="true"
      >
        <span className="truncate font-mono">{node.slug}</span>
        {node.staged === "create" ? (
          <span className="shrink-0 text-accent-text">staged</span>
        ) : status ? (
          <span className="flex shrink-0 items-center gap-1.5">
            <StatusDot status={status} kind="deployment" />
            {statusMeta(status, "deployment").label}
          </span>
        ) : (
          <span className="shrink-0">not deployed</span>
        )}
      </span>
    </button>
  );
});

const ServiceEdge = memo(function ServiceEdge({
  edge,
  from,
  to,
}: {
  edge: CanvasEdge;
  from: Point;
  to: Point;
}) {
  const { d } = edgePath(from, to);
  return (
    <path
      d={d}
      fill="none"
      markerEnd={`url(#canvas-arrow-${edge.state})`}
      strokeWidth={1.5}
      strokeDasharray={edge.state === "current" ? undefined : "5 4"}
      className={cn(
        edge.state === "removed"
          ? "stroke-danger/60"
          : edge.state === "staged"
            ? "stroke-accent"
            : edge.kind === "private_network"
              ? "stroke-info/70"
              : "stroke-border-strong",
      )}
    >
      <title>
        {`${edge.state === "staged" ? "Staged: " : edge.state === "removed" ? "Removed by staged changes: " : ""}${edge.variables.join(", ")}`}
      </title>
    </path>
  );
});

/**
 * The project as a graph: services as nodes, `${{service.VAR}}` references and private
 * network use as edges (dashed while staged). Pan by dragging the background or with the
 * arrow keys on the canvas, zoom with the wheel, `+`/`-` or the toolbar, `0` to fit.
 * Every node is a focusable button: Tab between them, Enter opens one, arrow keys move
 * the focused node (Shift for larger steps), Escape clears the selection. Status is
 * always spelled out next to its colour.
 *
 * Hand-rolled SVG and absolutely positioned buttons rather than a graph library: a
 * project has tens of services, and this keeps every node a native, labelled control.
 *
 * @param props - The canvas, live service state, selection and handlers.
 * @returns The canvas.
 */
export function ProjectCanvas({
  canvas,
  views,
  selectedId,
  onOpen,
  onClearSelection,
  onMove,
  className,
}: ProjectCanvasProps) {
  const surface = useRef<HTMLDivElement>(null);
  const [local, setLocal] = useState<Record<string, Point>>({});
  const [view, setView] = useState<Viewport | null>(null);
  const drag = useRef<{
    id: string | null;
    start: Point;
    origin: Point;
    moved: boolean;
    pointer: number;
  } | null>(null);

  const positions = useMemo(
    () =>
      autoLayout(
        canvas.nodes.map((n) => n.id),
        canvas.edges.filter((e) => e.state !== "removed"),
        { ...canvas.positions, ...local },
      ),
    [canvas.nodes, canvas.edges, canvas.positions, local],
  );

  const fitAll = useCallback(() => {
    const el = surface.current;
    if (!el) return;
    setView(fitView(Object.values(positions), { width: el.clientWidth, height: el.clientHeight }));
  }, [positions]);

  useLayoutEffect(() => {
    if (view === null) fitAll();
  }, [view, fitAll]);

  // Wheel zoom needs a non-passive listener so the page doesn't scroll underneath.
  useEffect(() => {
    const el = surface.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      setView((v) =>
        zoomAt(v ?? { x: 0, y: 0, zoom: 1 }, Math.exp(-e.deltaY * 0.0015), {
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
        }),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (factor: number) => {
    const el = surface.current;
    setView((v) =>
      zoomAt(v ?? { x: 0, y: 0, zoom: 1 }, factor, {
        x: (el?.clientWidth ?? 0) / 2,
        y: (el?.clientHeight ?? 0) / 2,
      }),
    );
  };

  const onNodePointerDown = useCallback(
    (id: string, e: PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      drag.current = {
        id,
        start: { x: e.clientX, y: e.clientY },
        origin: positions[id] ?? { x: 0, y: 0 },
        moved: false,
        pointer: e.pointerId,
      };
    },
    [positions],
  );

  const onSurfacePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !view) return;
    drag.current = {
      id: null,
      start: { x: e.clientX, y: e.clientY },
      origin: { x: view.x, y: view.y },
      moved: false,
      pointer: e.pointerId,
    };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId || !view) return;
    const dx = e.clientX - d.start.x;
    const dy = e.clientY - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!d.moved) {
      d.moved = true;
      surface.current?.setPointerCapture?.(e.pointerId);
    }
    if (d.id === null) {
      setView({ ...view, x: d.origin.x + dx, y: d.origin.y + dy });
    } else if (onMove) {
      const id = d.id;
      setLocal((l) => ({
        ...l,
        [id]: {
          x: Math.round(d.origin.x + dx / view.zoom),
          y: Math.round(d.origin.y + dy / view.zoom),
        },
      }));
    }
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    if (d.moved && d.id && onMove) {
      const p = local[d.id] ?? positions[d.id];
      if (p) onMove(d.id, p);
    }
    // NOTE: Left in place until the click that follows, so a drag doesn't also open the node.
    if (!d.moved) drag.current = null;
  };

  const onNodeClick = useCallback(
    (id: string) => {
      const d = drag.current;
      drag.current = null;
      if (d?.moved) return;
      onOpen(id);
    },
    [onOpen],
  );

  const onNodeKeyDown = useCallback(
    (id: string, e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === "Escape") {
        onClearSelection();
        return;
      }
      if (!onMove) return;
      const current = positions[id];
      const next = current ? keyMove(current, e.key, e.shiftKey) : null;
      if (!next) return;
      e.preventDefault();
      e.stopPropagation();
      setLocal((l) => ({ ...l, [id]: next }));
      onMove(id, next);
    },
    [onMove, onClearSelection, positions],
  );

  const onSurfaceKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) {
      if (e.key === "Escape") onClearSelection();
      return;
    }
    const pan: Record<string, Point> = {
      ArrowLeft: { x: 40, y: 0 },
      ArrowRight: { x: -40, y: 0 },
      ArrowUp: { x: 0, y: 40 },
      ArrowDown: { x: 0, y: -40 },
    };
    if (pan[e.key] && view) {
      e.preventDefault();
      setView({ ...view, x: view.x + pan[e.key]!.x, y: view.y + pan[e.key]!.y });
    } else if (e.key === "+" || e.key === "=") zoomBy(1.2);
    else if (e.key === "-") zoomBy(1 / 1.2);
    else if (e.key === "0") fitAll();
    else if (e.key === "Escape") onClearSelection();
  };

  const transform = view ? `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` : undefined;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border border-border bg-background",
        className,
      )}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset can't be a pannable surface; this is a labelled group of node buttons. */}
      <div
        ref={surface}
        role="group"
        aria-label="Project canvas. Arrow keys pan, plus and minus zoom, 0 fits every service."
        aria-roledescription="canvas"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the surface itself is keyboard-pannable.
        tabIndex={0}
        onPointerDown={onSurfacePointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={onSurfaceKeyDown}
        className="absolute inset-0 touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        style={{
          backgroundImage: "radial-gradient(var(--color-border) 1px, transparent 1px)",
          backgroundSize: `${20 * (view?.zoom ?? 1)}px ${20 * (view?.zoom ?? 1)}px`,
          backgroundPosition: view ? `${view.x}px ${view.y}px` : undefined,
        }}
      >
        <div className="absolute top-0 left-0 origin-top-left" style={{ transform }}>
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute top-0 left-0 overflow-visible"
            width={1}
            height={1}
          >
            <defs>
              {(["current", "staged", "removed"] as const).map((state) => (
                <marker
                  key={state}
                  id={`canvas-arrow-${state}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path
                    d="M 0 0 L 10 5 L 0 10 z"
                    className={
                      state === "current"
                        ? "fill-border-strong"
                        : state === "staged"
                          ? "fill-accent"
                          : "fill-danger/60"
                    }
                  />
                </marker>
              ))}
            </defs>
            {canvas.edges.map((edge) => {
              const from = positions[edge.from];
              const to = positions[edge.to];
              return from && to ? (
                <ServiceEdge key={edge.id} edge={edge} from={from} to={to} />
              ) : null;
            })}
          </svg>
          {canvas.nodes.map((node) => (
            <ServiceNode
              key={node.id}
              node={node}
              view={views.get(node.id)}
              position={positions[node.id] ?? { x: 0, y: 0 }}
              selected={selectedId === node.id}
              movable={Boolean(onMove) && node.staged !== "create"}
              onPointerDown={onNodePointerDown}
              onKeyDown={onNodeKeyDown}
              onClick={onNodeClick}
            />
          ))}
        </div>
      </div>
      <div className="absolute bottom-3 left-3 flex items-center gap-1 rounded-md border border-border bg-surface p-0.5 shadow-sm">
        <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onClick={() => zoomBy(1.2)}>
          <PlusIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Zoom out"
          onClick={() => zoomBy(1 / 1.2)}
        >
          <MinusIcon />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Fit every service" onClick={fitAll}>
          <MaximizeIcon />
        </Button>
      </div>
      <ul
        aria-label="Edge legend"
        className="absolute right-3 bottom-3 hidden items-center gap-3 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-muted-foreground shadow-sm sm:flex"
      >
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-px w-4 bg-border-strong" />
          references
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-px w-4 bg-info/70" />
          private network
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden="true" className="h-0 w-4 border-t border-dashed border-accent" />
          staged
        </li>
      </ul>
    </div>
  );
}
