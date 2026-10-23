/**
 * Geometry of the project canvas, kept pure so it is unit-tested apart from React:
 * automatic placement of services without a stored position, edge paths, fitting the
 * view, zooming around a point, and keyboard moves.
 *
 * @module
 */

/** A point in canvas units. */
export interface Point {
  x: number;
  y: number;
}

/** Pan and zoom of the canvas: screen = canvas × zoom + (x, y). */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/** Width of a service node, in canvas units. */
export const NODE_WIDTH = 232;
/** Height of a service node, in canvas units. */
export const NODE_HEIGHT = 84;
/** Horizontal distance between layout columns (ADR 0006: 320 px). */
export const COLUMN_GAP = 320;
/** Vertical distance between nodes of one column (ADR 0006: 160 px). */
export const ROW_GAP = 160;
/** Zoom limits. */
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
/** Arrow-key step, and the larger step with Shift. */
export const KEY_STEP = 16;
export const KEY_STEP_LARGE = 80;

/**
 * Places every node: stored positions win; the rest go into a deterministic layered
 * layout where a service sits one column right of everything it references, so
 * dependencies (databases) read left to right towards the apps that use them.
 *
 * Algorithm: depth(n) = 1 + max depth of the nodes n references (0 for none), with a
 * visiting set so a reference cycle can't recurse forever. Nodes are stacked by depth
 * column in input order; a slot already taken by a stored node moves further down.
 *
 * @param ids - Node ids in display order.
 * @param edges - `from` references `to`.
 * @param stored - Positions saved for some nodes.
 * @returns A position for every id.
 * @example
 * autoLayout(["api", "db"], [{ from: "api", to: "db" }], {});
 * // { db: { x: 0, y: 0 }, api: { x: 320, y: 0 } }
 */
export function autoLayout(
  ids: readonly string[],
  edges: readonly { from: string; to: string }[],
  stored: Readonly<Record<string, Point>>,
): Record<string, Point> {
  const known = new Set(ids);
  const deps = new Map<string, string[]>();
  for (const e of edges) {
    if (!known.has(e.from) || !known.has(e.to) || e.from === e.to) continue;
    deps.set(e.from, [...(deps.get(e.from) ?? []), e.to]);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const d = Math.max(-1, ...(deps.get(id) ?? []).map(depthOf)) + 1;
    visiting.delete(id);
    depth.set(id, d);
    return d;
  };

  const out: Record<string, Point> = {};
  const taken: Point[] = [];
  for (const id of ids) {
    const p = stored[id];
    if (p) {
      out[id] = p;
      taken.push(p);
    }
  }
  const rows = new Map<number, number>();
  for (const id of ids) {
    if (out[id]) continue;
    const column = depthOf(id);
    let row = rows.get(column) ?? 0;
    let candidate = { x: column * COLUMN_GAP, y: row * ROW_GAP };
    while (taken.some((t) => overlaps(t, candidate))) {
      row += 1;
      candidate = { x: column * COLUMN_GAP, y: row * ROW_GAP };
    }
    rows.set(column, row + 1);
    out[id] = candidate;
    taken.push(candidate);
  }
  return out;
}

/**
 * Whether two node boxes overlap.
 *
 * @param a - Top-left of one node.
 * @param b - Top-left of the other.
 * @returns `true` when they intersect.
 */
export function overlaps(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < NODE_WIDTH && Math.abs(a.y - b.y) < NODE_HEIGHT;
}

/**
 * An SVG path for an edge from the service that references to the one referenced,
 * leaving and entering on the facing sides.
 *
 * @param from - Top-left of the referencing node.
 * @param to - Top-left of the referenced node.
 * @returns The path and its midpoint (for a label).
 */
export function edgePath(from: Point, to: Point): { d: string; mid: Point } {
  const fromCenter = { x: from.x + NODE_WIDTH / 2, y: from.y + NODE_HEIGHT / 2 };
  const toCenter = { x: to.x + NODE_WIDTH / 2, y: to.y + NODE_HEIGHT / 2 };
  const horizontal = Math.abs(toCenter.x - fromCenter.x) >= NODE_WIDTH / 2;
  let start: Point;
  let end: Point;
  if (horizontal) {
    const leftward = toCenter.x < fromCenter.x;
    start = { x: leftward ? from.x : from.x + NODE_WIDTH, y: fromCenter.y };
    end = { x: leftward ? to.x + NODE_WIDTH : to.x, y: toCenter.y };
    const bend = Math.max(40, Math.abs(end.x - start.x) / 2) * (leftward ? -1 : 1);
    return {
      d: `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`,
      mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    };
  }
  const upward = toCenter.y < fromCenter.y;
  start = { x: fromCenter.x, y: upward ? from.y : from.y + NODE_HEIGHT };
  end = { x: toCenter.x, y: upward ? to.y + NODE_HEIGHT : to.y };
  const bend = Math.max(30, Math.abs(end.y - start.y) / 2) * (upward ? -1 : 1);
  return {
    d: `M ${start.x} ${start.y} C ${start.x} ${start.y + bend}, ${end.x} ${end.y - bend}, ${end.x} ${end.y}`,
    mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
  };
}

/**
 * Clamps a zoom level to {@link MIN_ZOOM}…{@link MAX_ZOOM}.
 *
 * @param zoom - Requested zoom.
 * @returns The allowed zoom.
 */
export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/**
 * The viewport that shows every node with a margin, never zooming in past 1.
 *
 * @param points - Node positions.
 * @param size - Visible area in screen pixels.
 * @param margin - Space to keep around the nodes, in screen pixels.
 * @returns The viewport.
 */
export function fitView(
  points: readonly Point[],
  size: { width: number; height: number },
  margin = 48,
): Viewport {
  if (!points.length || size.width <= 0 || size.height <= 0)
    return { x: margin, y: margin, zoom: 1 };
  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxX = Math.max(...points.map((p) => p.x + NODE_WIDTH));
  const maxY = Math.max(...points.map((p) => p.y + NODE_HEIGHT));
  const zoom = clampZoom(
    Math.min(
      1,
      (size.width - margin * 2) / (maxX - minX),
      (size.height - margin * 2) / (maxY - minY),
    ),
  );
  return {
    x: (size.width - (maxX - minX) * zoom) / 2 - minX * zoom,
    y: (size.height - (maxY - minY) * zoom) / 2 - minY * zoom,
    zoom,
  };
}

/**
 * Zooms by `factor` keeping the canvas point under `anchor` (screen pixels) in place.
 *
 * @param view - Current viewport.
 * @param factor - Multiplier, e.g. 1.2 to zoom in.
 * @param anchor - Screen point that stays put.
 * @returns The new viewport.
 */
export function zoomAt(view: Viewport, factor: number, anchor: Point): Viewport {
  const zoom = clampZoom(view.zoom * factor);
  const ratio = zoom / view.zoom;
  return {
    zoom,
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio,
  };
}

/** Arrow keys and the direction each moves a node. */
const ARROWS: Record<string, Point> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/**
 * Where an arrow key moves a node, or `null` for any other key.
 *
 * @param p - Current position.
 * @param key - `KeyboardEvent.key`.
 * @param large - Shift held: a bigger step.
 * @returns The new position, snapped to the step grid.
 */
export function keyMove(p: Point, key: string, large: boolean): Point | null {
  const dir = ARROWS[key];
  if (!dir) return null;
  const step = large ? KEY_STEP_LARGE : KEY_STEP;
  return {
    x: Math.round((p.x + dir.x * step) / KEY_STEP) * KEY_STEP,
    y: Math.round((p.y + dir.y * step) / KEY_STEP) * KEY_STEP,
  };
}
