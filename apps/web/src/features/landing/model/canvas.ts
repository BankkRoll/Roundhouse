/**
 * State for the landing page's project canvas demo. Mirrors how the real canvas will
 * work: edits are staged per service, variable references such as
 * `${{postgres.DATABASE_URL}}` become edges, and nothing changes until you deploy.
 *
 * @module
 */

/** What a canvas node represents. */
export type CanvasNodeKind = "service" | "database";

/** Lifecycle shown on a node. */
export type CanvasNodeStatus = "active" | "staged" | "deploying";

/** A service or database on the canvas. */
export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  /** Source shown under the name, e.g. "github.com/acme/web" or "postgres:17". */
  source: string;
  x: number;
  y: number;
  /** Variables as last deployed. */
  deployed: Readonly<Record<string, string>>;
  /** Variables including staged edits. */
  vars: Readonly<Record<string, string>>;
  /** `true` while a deploy is rolling this node. */
  deploying: boolean;
}

/** One staged variable edit. */
export interface StagedChange {
  nodeId: string;
  key: string;
  /** Deployed value, or `undefined` for a new variable. */
  from: string | undefined;
  /** Staged value, or `undefined` when the variable is being removed. */
  to: string | undefined;
}

/** A variable reference drawn as an edge from the referenced node to the consumer. */
export interface CanvasEdge {
  from: string;
  to: string;
  /** The variable on the consuming node, e.g. "DATABASE_URL". */
  key: string;
}

/** Canvas state. */
export interface CanvasState {
  nodes: readonly CanvasNode[];
  selectedId: string | null;
}

/** Events the canvas responds to. */
export type CanvasAction =
  | { type: "select"; id: string | null }
  | { type: "move"; id: string; x: number; y: number }
  | { type: "edit"; id: string; key: string; value: string }
  | { type: "unset"; id: string; key: string }
  | { type: "discard" }
  | { type: "deployStart" }
  | { type: "deployNode"; id: string };

/**
 * Builds a variable reference such as `${{postgres.DATABASE_URL}}`.
 *
 * @param service - Referenced service id.
 * @param variable - Variable on that service.
 * @returns The reference string.
 * @example
 * variableRef("postgres", "DATABASE_URL"); // "${{postgres.DATABASE_URL}}"
 */
export function variableRef(service: string, variable: string): string {
  return `\${{${service}.${variable}}}`;
}

const REFERENCE = /\$\{\{\s*([a-z0-9-]+)\.([A-Z0-9_]+)\s*\}\}/g;

/**
 * Finds the services a value references.
 *
 * @param value - Variable value, e.g. `"${{postgres.DATABASE_URL}}"`.
 * @returns Referenced service ids in order of appearance, without duplicates.
 * @example
 * referencedServices("redis://${{redis.HOST}}:6379"); // ["redis"]
 */
export function referencedServices(value: string): string[] {
  const found: string[] = [];
  for (const match of value.matchAll(REFERENCE)) {
    const id = match[1];
    if (id && !found.includes(id)) found.push(id);
  }
  return found;
}

/**
 * Derives the reference edges between nodes. References to unknown services are dropped.
 *
 * @param nodes - Canvas nodes.
 * @returns One edge per (referenced node, consumer, variable).
 */
export function canvasEdges(nodes: readonly CanvasNode[]): CanvasEdge[] {
  const ids = new Set(nodes.map((node) => node.id));
  const edges: CanvasEdge[] = [];
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node.vars)) {
      for (const from of referencedServices(value)) {
        if (ids.has(from) && from !== node.id) edges.push({ from, to: node.id, key });
      }
    }
  }
  return edges;
}

/**
 * Lists edits that differ from what is deployed.
 *
 * @param nodes - Canvas nodes.
 * @returns Staged changes, grouped by node in canvas order.
 */
export function stagedChanges(nodes: readonly CanvasNode[]): StagedChange[] {
  const changes: StagedChange[] = [];
  for (const node of nodes) {
    for (const key of changedKeys(node)) {
      changes.push({ nodeId: node.id, key, from: node.deployed[key], to: node.vars[key] });
    }
  }
  return changes;
}

/**
 * Status badge for a node.
 *
 * @param node - Canvas node.
 * @returns `deploying`, `staged` when it has unsaved edits, otherwise `active`.
 */
export function nodeStatus(node: CanvasNode): CanvasNodeStatus {
  if (node.deploying) return "deploying";
  return changedKeys(node).length > 0 ? "staged" : "active";
}

function changedKeys(node: CanvasNode): string[] {
  const keys = new Set([...Object.keys(node.deployed), ...Object.keys(node.vars)]);
  return [...keys].filter((key) => node.deployed[key] !== node.vars[key]);
}

function update(
  state: CanvasState,
  id: string,
  change: (node: CanvasNode) => CanvasNode,
): CanvasState {
  let touched = false;
  const nodes = state.nodes.map((node) => {
    if (node.id !== id) return node;
    touched = true;
    return change(node);
  });
  return touched ? { ...state, nodes } : state;
}

/**
 * Applies a canvas event.
 *
 * @param state - Current state.
 * @param action - Event.
 * @returns The next state.
 */
export function canvasReducer(state: CanvasState, action: CanvasAction): CanvasState {
  switch (action.type) {
    case "select":
      return { ...state, selectedId: action.id };
    case "move":
      return update(state, action.id, (node) => ({ ...node, x: action.x, y: action.y }));
    case "edit":
      return update(state, action.id, (node) =>
        node.deploying ? node : { ...node, vars: { ...node.vars, [action.key]: action.value } },
      );
    case "unset":
      return update(state, action.id, (node) => {
        if (node.deploying || !(action.key in node.vars)) return node;
        const { [action.key]: _removed, ...vars } = node.vars;
        return { ...node, vars };
      });
    case "discard":
      return {
        ...state,
        nodes: state.nodes.map((node) =>
          node.deploying ? node : { ...node, vars: node.deployed },
        ),
      };
    case "deployStart":
      return {
        ...state,
        nodes: state.nodes.map((node) =>
          nodeStatus(node) === "staged" ? { ...node, deploying: true } : node,
        ),
      };
    case "deployNode":
      return update(state, action.id, (node) =>
        node.deploying ? { ...node, deploying: false, deployed: node.vars } : node,
      );
  }
}

function service(
  id: string,
  kind: CanvasNodeKind,
  source: string,
  x: number,
  y: number,
  vars: Record<string, string>,
): CanvasNode {
  return { id, kind, source, x, y, deployed: vars, vars, deploying: false };
}

/** Logical canvas size the default layout is drawn in. */
export const CANVAS_SIZE = { width: 640, height: 380 } as const;

/** Width and height of a node card in canvas units. */
export const NODE_SIZE = { width: 168, height: 64 } as const;

/** The demo project: a web app, an API, a worker, Postgres and Redis. */
export const INITIAL_CANVAS: CanvasState = {
  selectedId: null,
  nodes: [
    service("web", "service", "github.com/acme/web", 24, 40, {
      API_URL: `http://${variableRef("api", "HOST")}:8080`,
      NODE_ENV: "production",
    }),
    service("api", "service", "github.com/acme/api", 236, 150, {
      DATABASE_URL: variableRef("postgres", "DATABASE_URL"),
      REDIS_URL: variableRef("redis", "REDIS_URL"),
      LOG_LEVEL: "info",
    }),
    service("worker", "service", "github.com/acme/api · worker", 24, 286, {
      DATABASE_URL: variableRef("postgres", "DATABASE_URL"),
      CONCURRENCY: "4",
      REPLICAS: "1",
    }),
    service("postgres", "database", "postgres:17 · 10 GB volume", 448, 40, {
      POSTGRES_DB: "acme",
    }),
    service("redis", "database", "redis:8", 448, 286, {
      MAXMEMORY: "256mb",
    }),
  ],
};
