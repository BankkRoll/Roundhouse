import { Badge, cn, Spinner } from "@openrail/ui";
import { BoxIcon, DatabaseIcon } from "lucide-react";
import {
  type CSSProperties,
  type Dispatch,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  type AutopilotControl,
  autopilotActions,
  autopilotFrame,
  blockProgress,
  CANVAS_SIZE,
  type CanvasAction,
  type CanvasNode,
  type CanvasState,
  canvasEdges,
  canvasReducer,
  INITIAL_CANVAS,
  NODE_SIZE,
  nodeStatus,
  stagedChanges,
  variableRef,
} from "../model/canvas";
import { buttonClass, Section } from "../ui";

const DEPLOY_STEP_MS = 650;
/** Board width below which the services switch to {@link NARROW_LAYOUT}. */
const NARROW_BELOW = 520;
const NARROW_WIDTH = 400;

const WIDE_LAYOUT: Record<string, [number, number]> = Object.fromEntries(
  INITIAL_CANVAS.nodes.map((node) => [node.id, [node.x, node.y]]),
);

const NARROW_LAYOUT: Record<string, [number, number]> = {
  web: [12, 16],
  postgres: [220, 16],
  api: [116, 158],
  worker: [12, 300],
  redis: [220, 300],
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function edgePath(from: CanvasNode, to: CanvasNode): string {
  const fromCx = from.x + NODE_SIZE.width / 2;
  const toCx = to.x + NODE_SIZE.width / 2;
  const horizontal = from.x + NODE_SIZE.width < to.x || to.x + NODE_SIZE.width < from.x;
  if (horizontal) {
    const leftToRight = fromCx < toCx;
    const x1 = leftToRight ? from.x + NODE_SIZE.width : from.x;
    const x2 = leftToRight ? to.x : to.x + NODE_SIZE.width;
    const y1 = from.y + NODE_SIZE.height / 2;
    const y2 = to.y + NODE_SIZE.height / 2;
    const bend = Math.max(40, Math.abs(x2 - x1) / 2) * (leftToRight ? 1 : -1);
    return `M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`;
  }
  const down = from.y < to.y;
  const y1 = down ? from.y + NODE_SIZE.height : from.y;
  const y2 = down ? to.y : to.y + NODE_SIZE.height;
  const bend = Math.max(30, Math.abs(y2 - y1) / 2) * (down ? 1 : -1);
  return `M${fromCx} ${y1} C${fromCx} ${y1 + bend} ${toCx} ${y2 - bend} ${toCx} ${y2}`;
}

function StatusTag({ node }: { node: CanvasNode }) {
  const status = nodeStatus(node);
  if (status === "deploying") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-accent-text">
        <Spinner className="size-3" /> deploying
      </span>
    );
  }
  if (status === "staged") return <Badge tone="accent">Staged</Badge>;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-success">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-success" /> active
    </span>
  );
}

/**
 * The project canvas itself: draggable services and the reference edges between them,
 * scaled to fit its box. Arrow keys move a focused service.
 */
function CanvasBoard({
  state,
  dispatch,
}: {
  state: CanvasState;
  dispatch: Dispatch<CanvasAction>;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({
    width: CANVAS_SIZE.width,
    height: CANVAS_SIZE.height,
  });
  const drag = useRef<{
    id: string;
    dx: number;
    dy: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);

  useLayoutEffect(() => {
    const element = boxRef.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const narrow = size.width < NARROW_BELOW;
  const layoutWidth = narrow ? NARROW_WIDTH : CANVAS_SIZE.width;
  const scale = clamp(
    Math.min(size.width / layoutWidth, size.height / CANVAS_SIZE.height),
    0.4,
    1.4,
  );

  // NOTE: Phones get a two-column arrangement instead of a tiny canvas. Crossing the
  // breakpoint resets positions, which only happens when the viewport changes.
  useEffect(() => {
    const positions = narrow ? NARROW_LAYOUT : WIDE_LAYOUT;
    for (const [id, [x, y]] of Object.entries(positions)) dispatch({ type: "move", id, x, y });
  }, [narrow, dispatch]);

  const byId = new Map(state.nodes.map((node) => [node.id, node]));
  const maxX = layoutWidth - NODE_SIZE.width;
  const maxY = CANVAS_SIZE.height - NODE_SIZE.height;

  function onPointerDown(event: PointerEvent<HTMLButtonElement>, node: CanvasNode) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      id: node.id,
      dx: event.clientX / scale - node.x,
      dy: event.clientY / scale - node.y,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
  }

  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current) return;
    if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > 3) current.moved = true;
    if (!current.moved) return;
    dispatch({
      type: "move",
      id: current.id,
      x: clamp(event.clientX / scale - current.dx, 0, maxX),
      y: clamp(event.clientY / scale - current.dy, 0, maxY),
    });
  }

  function onPointerUp(node: CanvasNode) {
    const current = drag.current;
    drag.current = null;
    if (current && !current.moved) dispatch({ type: "select", id: node.id });
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, node: CanvasNode) {
    const step = event.shiftKey ? 32 : 8;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = delta[event.key];
    if (!move) return;
    event.preventDefault();
    dispatch({
      type: "move",
      id: node.id,
      x: clamp(node.x + move[0], 0, maxX),
      y: clamp(node.y + move[1], 0, maxY),
    });
  }

  return (
    <div ref={boxRef} className="relative h-full w-full">
      <div
        className="absolute top-1/2 left-1/2 origin-center"
        style={{
          width: layoutWidth,
          height: CANVAS_SIZE.height,
          transform: `translate(-50%, -50%) scale(${scale})`,
        }}
      >
        <svg
          className="pointer-events-none absolute inset-0 overflow-visible"
          width={layoutWidth}
          height={CANVAS_SIZE.height}
          aria-hidden="true"
        >
          {canvasEdges(state.nodes).map((edge) => {
            const from = byId.get(edge.from);
            const to = byId.get(edge.to);
            if (!from || !to) return null;
            const staged = to.deployed[edge.key] !== to.vars[edge.key];
            return (
              <g key={`${edge.from}-${edge.to}-${edge.key}`} data-edge={`${edge.from}-${edge.to}`}>
                <path
                  d={edgePath(from, to)}
                  fill="none"
                  className="stroke-border-strong"
                  strokeWidth={1.5}
                />
                <path
                  d={edgePath(from, to)}
                  fill="none"
                  className={cn("lp-flow", staged ? "stroke-accent" : "stroke-muted-foreground/70")}
                  strokeWidth={1.5}
                />
              </g>
            );
          })}
        </svg>
        {state.nodes.map((node) => {
          const status = nodeStatus(node);
          const Icon = node.kind === "database" ? DatabaseIcon : BoxIcon;
          const replicas = Number(node.vars.REPLICAS ?? 1);
          return (
            <button
              key={node.id}
              type="button"
              data-node={node.id}
              data-status={status}
              aria-label={`${node.id}, ${node.kind}, ${status}. Arrow keys move it.`}
              onPointerDown={(event) => onPointerDown(event, node)}
              onPointerMove={onPointerMove}
              onPointerUp={() => onPointerUp(node)}
              onPointerCancel={() => {
                drag.current = null;
              }}
              onKeyDown={(event) => onKeyDown(event, node)}
              className={cn(
                "absolute flex touch-none cursor-grab flex-col justify-center gap-1 rounded-lg border bg-surface px-3 text-left outline-none transition-[border-color] active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-ring",
                status === "active" ? "border-border-strong hover:border-input" : "border-accent",
              )}
              style={{
                left: node.x,
                top: node.y,
                width: NODE_SIZE.width,
                height: NODE_SIZE.height,
              }}
            >
              <span className="flex w-full items-center gap-2">
                <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="flex-1 truncate font-mono text-[13px] font-semibold text-foreground">
                  {node.id}
                  {replicas > 1 ? <span className="ml-1 text-accent-text">×{replicas}</span> : null}
                </span>
                <StatusTag node={node} />
              </span>
              <span className="w-full truncate font-mono text-[11px] text-muted-foreground">
                {node.source}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Block({
  index,
  title,
  body,
  children,
}: {
  index: number;
  title: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <div
      className="grid gap-4 lg:min-h-[48svh] lg:content-center"
      data-reveal
      data-step={index}
      style={{ "--i": index } as CSSProperties}
    >
      <h3 className="text-[26px] font-semibold leading-tight tracking-[-0.025em] sm:text-[30px]">
        {title}
      </h3>
      <p className="max-w-[44ch] text-foreground">{body}</p>
      <div data-ui className="font-sans">
        {children}
      </div>
    </div>
  );
}

/**
 * "Change it, then ship it": the project canvas held on the left while the reader works the
 * controls on the right. Every change stages on the canvas at once, and the last block
 * reviews and deploys them.
 *
 * @param props - `reducedMotion` makes deploys finish instantly and turns off the scroll
 *   autopilot.
 * @returns The section.
 */
export function CanvasSection({ reducedMotion }: { reducedMotion: boolean }) {
  const [state, dispatch] = useReducer(canvasReducer, { ...INITIAL_CANVAS, selectedId: null });
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const ids = useId();
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);

  const api = state.nodes.find((node) => node.id === "api");
  const worker = state.nodes.find((node) => node.id === "worker");
  const changes = stagedChanges(state.nodes);
  const deploying = state.nodes.some((node) => node.deploying);
  const queue = worker?.vars.REDIS_URL ? "redis" : "none";
  const replicas = Number(worker?.vars.REPLICAS ?? 1);

  const stepsRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const manual = useRef(new Set<AutopilotControl>());
  const autopilotDone = useRef(false);
  const takeOver = (...controls: AutopilotControl[]) => {
    for (const control of controls) manual.current.add(control);
  };

  function deploy(from: CanvasState = state) {
    const targets = from.nodes
      .filter((node) => nodeStatus(node) === "staged")
      .map((node) => node.id);
    dispatch({ type: "deployStart" });
    targets.forEach((id, index) => {
      if (reducedMotion) dispatch({ type: "deployNode", id });
      else
        timers.current.push(
          setTimeout(() => dispatch({ type: "deployNode", id }), DEPLOY_STEP_MS * (index + 2)),
        );
    });
  }
  const deployRef = useRef(deploy);
  deployRef.current = deploy;

  // NOTE: Scrolling works the controls for the reader: each block's progress through the
  // viewport sets its control, so scrolling back up rewinds it. A control the reader
  // touches drops out of the script; reaching the review block deploys once and ends it.
  useEffect(() => {
    if (reducedMotion) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const steps = stepsRef.current?.querySelectorAll<HTMLElement>("[data-step]");
      if (autopilotDone.current || !steps?.length) return;
      const boxes = [...steps].map((step) => step.getBoundingClientRect());
      // Not laid out (hidden, or a test DOM): nothing meaningful to map.
      if (boxes.some((box) => box.height === 0)) return;
      const target = autopilotFrame(boxes.map((box) => blockProgress(box.top, window.innerHeight)));
      const actions = autopilotActions(stateRef.current, target, manual.current);
      for (const action of actions) dispatch(action);
      if (!target.deploy || manual.current.has("deploy")) return;
      const next = actions.reduce(canvasReducer, stateRef.current);
      if (next.nodes.some((node) => node.deploying)) return;
      autopilotDone.current = true;
      if (stagedChanges(next.nodes).length > 0) deployRef.current(next);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [reducedMotion]);

  return (
    <Section
      id="canvas"
      labelledBy="canvas-title"
      bare
      className="flex flex-col lg:grid lg:grid-cols-12 lg:gap-x-[var(--lp-gap)]"
    >
      <div
        className="lp-wrap order-1 pt-20 pb-10 lg:col-span-5 lg:col-start-8 lg:row-start-1 lg:pl-0 lg:pr-[var(--lp-edge-v)] lg:pt-[12svh] lg:pb-0"
        data-reveal
      >
        <h2 id="canvas-title" className="lp-heading">
          Change it, then ship it
        </h2>
        <p className="mt-5 max-w-[44ch] text-foreground">
          Every service and database sits on one canvas. Changes wait on the canvas until you deploy
          them together.{" "}
          {reducedMotion
            ? "Work the controls below or drag the services around."
            : "Scroll and the controls below work themselves. Touch any of them to take over, or drag the services around."}
        </p>
      </div>
      <div
        className="order-2 h-[56svh] min-h-[380px] bg-[var(--lp-step)] lg:sticky lg:top-[var(--lp-header-h)] lg:z-10 lg:col-span-6 lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:h-[calc(100svh-var(--lp-header-h))]"
        data-testid="canvas"
        data-staged={changes.length}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between px-[var(--lp-margin)] lg:pl-[var(--lp-edge-v)] pt-4 text-[14px] text-muted-foreground lg:pt-6">
            <span>acme / production</span>
            <span aria-live="polite" data-testid="staged-count">
              {deploying
                ? "Deploying…"
                : changes.length === 0
                  ? "Everything deployed"
                  : `${changes.length} staged ${changes.length === 1 ? "change" : "changes"}`}
            </span>
          </div>
          <div
            data-ui
            className="min-h-0 flex-1 px-[var(--lp-margin)] lg:pl-[var(--lp-edge-v)] py-3 font-sans"
          >
            <CanvasBoard state={state} dispatch={dispatch} />
          </div>
        </div>
      </div>

      <div
        ref={stepsRef}
        className="lp-wrap order-3 grid gap-16 py-20 lg:col-span-5 lg:col-start-8 lg:row-start-2 lg:gap-0 lg:pl-0 lg:pr-[var(--lp-edge-v)] lg:pt-0 lg:pb-[12svh]"
      >
        <Block
          index={0}
          title="Edit a variable and it waits"
          body="A change stages on the service instead of restarting it. Nothing moves until you say so."
        >
          <label
            htmlFor={`${ids}-log`}
            className="mb-1.5 block font-mono text-[13px] text-muted-foreground"
          >
            api · LOG_LEVEL
          </label>
          <input
            id={`${ids}-log`}
            value={api?.vars.LOG_LEVEL ?? ""}
            disabled={api?.deploying}
            spellCheck={false}
            onChange={(event) => {
              takeOver("logLevel");
              dispatch({ type: "edit", id: "api", key: "LOG_LEVEL", value: event.target.value });
            }}
            className="h-11 w-full max-w-[360px] rounded-md border border-input bg-background px-3 font-mono text-[15px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          />
        </Block>

        <Block
          index={1}
          title="Reference, don't copy"
          body={`Give the worker a queue with ${variableRef("redis", "REDIS_URL")} and the canvas draws the connection. Rotate the password once; every reference follows.`}
        >
          <div
            role="radiogroup"
            aria-label="Worker queue"
            className="inline-flex rounded-md bg-background p-1"
          >
            {(["none", "redis"] as const).map((option) => (
              // biome-ignore lint/a11y/useSemanticElements: a segmented control styled as buttons; native radios cannot take this layout
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={queue === option}
                disabled={worker?.deploying}
                onClick={() => {
                  takeOver("queue");
                  option === "redis"
                    ? dispatch({
                        type: "edit",
                        id: "worker",
                        key: "REDIS_URL",
                        value: variableRef("redis", "REDIS_URL"),
                      })
                    : dispatch({ type: "unset", id: "worker", key: "REDIS_URL" });
                }}
                className={cn(
                  "min-h-10 cursor-pointer rounded-[5px] px-4 text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  queue === option
                    ? "bg-[var(--lp-step-2)] text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {option === "none" ? "No queue" : "Redis"}
              </button>
            ))}
          </div>
        </Block>

        <Block
          index={2}
          title="Run more of the worker"
          body="Replicas spread across the servers with room for them. The canvas shows the count on the service."
        >
          <label
            htmlFor={`${ids}-replicas`}
            className="mb-1.5 flex max-w-[360px] justify-between font-mono text-[13px] text-muted-foreground"
          >
            <span>worker · replicas</span>
            <span className="text-foreground">{replicas}</span>
          </label>
          <input
            id={`${ids}-replicas`}
            type="range"
            min={1}
            max={6}
            value={replicas}
            disabled={worker?.deploying}
            onChange={(event) => {
              takeOver("replicas");
              dispatch({ type: "edit", id: "worker", key: "REPLICAS", value: event.target.value });
            }}
            className="lp-range w-full max-w-[360px]"
          />
        </Block>

        <Block
          index={3}
          title="Review the diff, then deploy"
          body="Every staged change in one list. Deploy rolls them out together; discard puts the canvas back."
        >
          <div className="max-w-[440px] rounded-lg border border-border-strong bg-background">
            {changes.length === 0 ? (
              <p className="px-4 py-3 text-[14px] text-muted-foreground">
                {deploying ? "Rolling out…" : "No staged changes. Try the controls above."}
              </p>
            ) : (
              <ul
                aria-label="Staged changes"
                className="max-h-56 divide-y divide-border overflow-y-auto"
              >
                {changes.map((change) => (
                  <li
                    key={`${change.nodeId}.${change.key}`}
                    className="grid gap-0.5 px-4 py-2.5 font-mono text-[13px]"
                  >
                    <span className="text-muted-foreground">
                      {change.nodeId} · <span className="text-foreground">{change.key}</span>
                    </span>
                    <span className="break-all">
                      {change.from === undefined ? (
                        <span className="text-muted-foreground">(new)</span>
                      ) : (
                        <span className="text-danger line-through">{change.from}</span>
                      )}{" "}
                      →{" "}
                      {change.to === undefined ? (
                        <span className="text-muted-foreground">(removed)</span>
                      ) : (
                        <span className="text-success">{change.to}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center gap-2 border-t border-border p-3">
              <button
                type="button"
                onClick={() => {
                  takeOver("deploy");
                  deploy();
                }}
                disabled={changes.length === 0 || deploying}
                className={buttonClass(
                  "primary",
                  "min-h-10 px-4 text-[15px] disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                {deploying ? <Spinner /> : null}
                Deploy
              </button>
              <button
                type="button"
                onClick={() => {
                  takeOver("logLevel", "queue", "replicas", "deploy");
                  dispatch({ type: "discard" });
                }}
                disabled={changes.length === 0 || deploying}
                className="min-h-10 cursor-pointer rounded-md px-3 text-[15px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                Discard
              </button>
            </div>
          </div>
        </Block>
      </div>
    </Section>
  );
}
