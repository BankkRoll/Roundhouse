import { describe, expect, it } from "vitest";
import {
  autoLayout,
  COLUMN_GAP,
  clampZoom,
  edgePath,
  fitView,
  keyMove,
  MAX_ZOOM,
  NODE_WIDTH,
  overlaps,
  ROW_GAP,
  zoomAt,
} from "./layout";

describe("autoLayout", () => {
  it("places dependencies left of the services that reference them", () => {
    const layout = autoLayout(
      ["web", "api", "db", "cache"],
      [
        { from: "web", to: "api" },
        { from: "api", to: "db" },
        { from: "api", to: "cache" },
      ],
      {},
    );
    expect(layout).toEqual({
      db: { x: 0, y: 0 },
      cache: { x: 0, y: ROW_GAP },
      api: { x: COLUMN_GAP, y: 0 },
      web: { x: 2 * COLUMN_GAP, y: 0 },
    });
  });

  it("keeps stored positions and never stacks new nodes on them", () => {
    const layout = autoLayout(["a", "b"], [], { a: { x: 0, y: 0 } });
    expect(layout.a).toEqual({ x: 0, y: 0 });
    expect(overlaps(layout.a!, layout.b!)).toBe(false);
  });

  it("survives reference cycles and ignores unknown nodes", () => {
    const layout = autoLayout(
      ["a", "b"],
      [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
        { from: "a", to: "ghost" },
      ],
      {},
    );
    expect(Object.keys(layout).sort()).toEqual(["a", "b"]);
  });

  it("is deterministic", () => {
    const args = [["x", "y", "z"], [{ from: "z", to: "x" }], {}] as const;
    expect(autoLayout(...args)).toEqual(autoLayout(...args));
  });
});

describe("edgePath", () => {
  it("leaves the referencing node towards the referenced one", () => {
    const { d } = edgePath({ x: COLUMN_GAP, y: 0 }, { x: 0, y: 0 });
    expect(d.startsWith(`M ${COLUMN_GAP} `)).toBe(true);
    expect(d.endsWith(`${NODE_WIDTH} 42`)).toBe(true);
  });
});

describe("viewport", () => {
  it("fits every node without zooming in past 1", () => {
    const view = fitView(
      [
        { x: 0, y: 0 },
        { x: 640, y: 320 },
      ],
      { width: 400, height: 300 },
    );
    expect(view.zoom).toBeLessThan(1);
    expect(fitView([{ x: 0, y: 0 }], { width: 4000, height: 3000 }).zoom).toBe(1);
  });

  it("zooms around the anchor and clamps", () => {
    const view = zoomAt({ x: 0, y: 0, zoom: 1 }, 2, { x: 100, y: 100 });
    expect(view).toEqual({ x: -100, y: -100, zoom: 2 });
    expect(clampZoom(10)).toBe(MAX_ZOOM);
  });
});

describe("keyMove", () => {
  it("moves by a step, more with shift, and ignores other keys", () => {
    expect(keyMove({ x: 0, y: 0 }, "ArrowRight", false)).toEqual({ x: 16, y: 0 });
    expect(keyMove({ x: 0, y: 0 }, "ArrowUp", true)).toEqual({ x: 0, y: -80 });
    expect(keyMove({ x: 0, y: 0 }, "Enter", false)).toBeNull();
  });
});
