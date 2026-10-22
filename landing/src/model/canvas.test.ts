import { describe, expect, it } from "vitest";
import {
  AUTOPILOT_REPLICAS,
  autopilotActions,
  autopilotFrame,
  blockProgress,
  type CanvasAction,
  type CanvasState,
  canvasEdges,
  canvasReducer,
  INITIAL_CANVAS,
  nodeStatus,
  referencedServices,
  stagedChanges,
  variableRef,
} from "./canvas";

function run(state: CanvasState, ...actions: CanvasAction[]): CanvasState {
  return actions.reduce(canvasReducer, state);
}

function node(state: CanvasState, id: string) {
  const found = state.nodes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no node ${id}`);
  return found;
}

describe("referencedServices", () => {
  it("extracts service ids from references", () => {
    expect(referencedServices(variableRef("postgres", "DATABASE_URL"))).toEqual(["postgres"]);
    const spaced = `redis://\${{ redis.HOST }}:${variableRef("redis", "PORT")}`;
    expect(referencedServices(spaced)).toEqual(["redis"]);
    expect(referencedServices(`${variableRef("a", "X")} ${variableRef("b", "Y")}`)).toEqual([
      "a",
      "b",
    ]);
    expect(referencedServices("plain")).toEqual([]);
  });
});

describe("variableRef", () => {
  it("builds the reference syntax", () => {
    expect(variableRef("postgres", "DATABASE_URL")).toMatch(/^\$\{\{postgres\.DATABASE_URL\}\}$/);
  });
});

describe("canvasEdges", () => {
  it("draws an edge for each reference in the demo project", () => {
    const edges = canvasEdges(INITIAL_CANVAS.nodes).map((e) => `${e.from}->${e.to}:${e.key}`);
    expect(edges).toEqual([
      "api->web:API_URL",
      "postgres->api:DATABASE_URL",
      "redis->api:REDIS_URL",
      "postgres->worker:DATABASE_URL",
    ]);
  });

  it("adds an edge when a staged value references another service", () => {
    const state = run(INITIAL_CANVAS, {
      type: "edit",
      id: "worker",
      key: "REDIS_URL",
      value: variableRef("redis", "REDIS_URL"),
    });
    expect(canvasEdges(state.nodes)).toContainEqual({
      from: "redis",
      to: "worker",
      key: "REDIS_URL",
    });
  });

  it("ignores references to unknown services and to itself", () => {
    const state = run(
      INITIAL_CANVAS,
      { type: "edit", id: "web", key: "A", value: variableRef("ghost", "URL") },
      { type: "edit", id: "web", key: "B", value: variableRef("web", "URL") },
    );
    expect(canvasEdges(state.nodes).filter((edge) => edge.to === "web")).toHaveLength(1);
  });
});

describe("canvasReducer", () => {
  it("stages an edit without touching the deployed values", () => {
    const state = run(INITIAL_CANVAS, {
      type: "edit",
      id: "api",
      key: "LOG_LEVEL",
      value: "debug",
    });
    expect(nodeStatus(node(state, "api"))).toBe("staged");
    expect(node(state, "api").deployed.LOG_LEVEL).toBe("info");
    expect(stagedChanges(state.nodes)).toEqual([
      { nodeId: "api", key: "LOG_LEVEL", from: "info", to: "debug" },
    ]);
  });

  it("unstages when a value is edited back", () => {
    const state = run(
      INITIAL_CANVAS,
      { type: "edit", id: "api", key: "LOG_LEVEL", value: "debug" },
      { type: "edit", id: "api", key: "LOG_LEVEL", value: "info" },
    );
    expect(stagedChanges(state.nodes)).toEqual([]);
    expect(nodeStatus(node(state, "api"))).toBe("active");
  });

  it("reports new variables with no previous value", () => {
    const state = run(INITIAL_CANVAS, {
      type: "edit",
      id: "redis",
      key: "APPENDONLY",
      value: "yes",
    });
    expect(stagedChanges(state.nodes)).toEqual([
      { nodeId: "redis", key: "APPENDONLY", from: undefined, to: "yes" },
    ]);
  });

  it("discards every staged edit", () => {
    const state = run(
      INITIAL_CANVAS,
      { type: "edit", id: "api", key: "LOG_LEVEL", value: "debug" },
      { type: "edit", id: "web", key: "NODE_ENV", value: "staging" },
      { type: "discard" },
    );
    expect(stagedChanges(state.nodes)).toEqual([]);
  });

  it("deploys staged nodes and returns them to active", () => {
    let state = run(
      INITIAL_CANVAS,
      { type: "edit", id: "api", key: "LOG_LEVEL", value: "debug" },
      { type: "deployStart" },
    );
    expect(nodeStatus(node(state, "api"))).toBe("deploying");
    expect(nodeStatus(node(state, "web"))).toBe("active");
    state = run(state, { type: "edit", id: "api", key: "LOG_LEVEL", value: "warn" });
    expect(node(state, "api").vars.LOG_LEVEL).toBe("debug");
    state = run(state, { type: "deployNode", id: "api" });
    expect(nodeStatus(node(state, "api"))).toBe("active");
    expect(node(state, "api").deployed.LOG_LEVEL).toBe("debug");
    expect(stagedChanges(state.nodes)).toEqual([]);
  });

  it("moves and selects nodes", () => {
    const state = run(
      INITIAL_CANVAS,
      { type: "move", id: "web", x: 10, y: 20 },
      { type: "select", id: "web" },
    );
    expect(node(state, "web")).toMatchObject({ x: 10, y: 20 });
    expect(state.selectedId).toBe("web");
  });

  it("returns the same state for unknown nodes", () => {
    expect(run(INITIAL_CANVAS, { type: "move", id: "nope", x: 0, y: 0 })).toBe(INITIAL_CANVAS);
  });
});

describe("unset", () => {
  it("stages a removal and restores it on discard", () => {
    const removed = run(INITIAL_CANVAS, { type: "unset", id: "api", key: "REDIS_URL" });
    expect(stagedChanges(removed.nodes)).toEqual([
      { nodeId: "api", key: "REDIS_URL", from: variableRef("redis", "REDIS_URL"), to: undefined },
    ]);
    expect(nodeStatus(node(removed, "api"))).toBe("staged");
    expect(canvasEdges(removed.nodes).some((edge) => edge.from === "redis")).toBe(false);
    const restored = run(removed, { type: "discard" });
    expect(stagedChanges(restored.nodes)).toEqual([]);
  });

  it("is a no-op for a variable that does not exist", () => {
    const state = run(INITIAL_CANVAS, { type: "unset", id: "api", key: "NOPE" });
    expect(stagedChanges(state.nodes)).toEqual([]);
  });
});

describe("autopilot", () => {
  it("rests at the deployed values and finishes at the scripted ones", () => {
    expect(autopilotFrame([0, 0, 0, 0])).toEqual({
      logLevel: "info",
      queue: "none",
      replicas: 1,
      deploy: false,
    });
    expect(autopilotFrame([1, 1, 1, 1])).toEqual({
      logLevel: "debug",
      queue: "redis",
      replicas: AUTOPILOT_REPLICAS,
      deploy: true,
    });
  });

  it("erases then retypes the log level as the block scrolls", () => {
    expect(autopilotFrame([0.4]).logLevel).toBe("");
    expect(autopilotFrame([0.8]).logLevel).toBe("deb");
  });

  it("maps a block's position in the viewport to progress", () => {
    expect(blockProgress(900, 1000)).toBe(0);
    expect(blockProgress(350, 1000)).toBe(1);
    expect(blockProgress(575, 1000)).toBeCloseTo(0.5);
  });

  it("emits nothing at rest, so the canvas starts clean", () => {
    expect(autopilotActions(INITIAL_CANVAS, autopilotFrame([]), new Set())).toEqual([]);
  });

  it("stages the frame and rewinds it", () => {
    const end = autopilotFrame([1, 1, 1, 0]);
    const staged = run(INITIAL_CANVAS, ...autopilotActions(INITIAL_CANVAS, end, new Set()));
    expect(stagedChanges(staged.nodes).map((change) => change.key)).toEqual([
      "LOG_LEVEL",
      "REPLICAS",
      "REDIS_URL",
    ]);
    const rewound = run(staged, ...autopilotActions(staged, autopilotFrame([]), new Set()));
    expect(stagedChanges(rewound.nodes)).toEqual([]);
  });

  it("leaves controls the visitor took over alone", () => {
    const edited = run(INITIAL_CANVAS, {
      type: "edit",
      id: "api",
      key: "LOG_LEVEL",
      value: "warn",
    });
    const actions = autopilotActions(edited, autopilotFrame([1, 1, 1, 1]), new Set(["logLevel"]));
    expect(actions.some((action) => "key" in action && action.key === "LOG_LEVEL")).toBe(false);
    expect(actions).toHaveLength(2);
  });
});
