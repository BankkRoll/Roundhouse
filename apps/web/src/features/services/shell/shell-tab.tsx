/**
 * The service's Shell tab (ADR 0012 "Web shell", ADR 0014 §15): an interactive shell in
 * one running replica, for project admins.
 *
 * Responsibilities:
 * - the privileged-access notice, the replica picker and the gate the API reports
 *   (re-auth, two-factor, protected environment, forbidden), with the way out of each;
 * - an explicit Connect: xterm.js loads on first use, fits its element, and opens one
 *   socket per session; Reconnect is a new session, as a shell has no resume;
 * - the status line (connection state, server, container user, replica, "not
 *   recorded") and the idle countdown, from `SHELL_IDLE_WARNING_S` before the idle
 *   timeout, measured from the last keystroke;
 * - turning exits and close codes into words and a next step;
 * - keyboard: the terminal keeps Tab, Ctrl+] hands focus back to the page;
 * - cleanup of the socket and terminal when the tab is left.
 *
 * @module
 */
import { SHELL_CLOSE_CODES, SHELL_IDLE_WARNING_S } from "@roundhouse/shared";
import { Button, EmptyState, Label, Select, Skeleton } from "@roundhouse/ui";
import { Switch } from "@roundhouse/ui/controls";
import { Link } from "@tanstack/react-router";
import { ShieldAlertIcon, TerminalIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useReducer, useRef, useState } from "react";
import { ErrorState } from "../../../components/error-state";
import { errorMessage, requestReauth } from "../../../lib/api/client";
import { type ShellTarget, type ShellTargets, shellSocketUrl } from "../../../lib/api/shell-client";
import { useProjectPermissions } from "../../../lib/permissions";
import { useShellTargets } from "../../../queries/shell";
import { findService, useProjectEnvironment } from "../../projects/use-project-environment";
import type { ServicePageProps } from "../service-layout";
import {
  describeExitReason,
  describeShellClose,
  type ShellCloseDescription,
  ShellConnection,
  type ShellExit,
  type ShellOpened,
  type ShellSocketFactory,
} from "./shell-connection";
import { loadTerminal, type TerminalHandle } from "./terminal";

/** Props for {@link ShellTab}. */
export interface ShellTabProps extends ServicePageProps {
  /** Socket factory; tests pass a fake. Defaults to the browser WebSocket. */
  createSocket?: ShellSocketFactory;
}

type Phase =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "open"; opened: ShellOpened | null }
  | { kind: "closing"; opened: ShellOpened | null }
  | { kind: "closed"; exit: ShellExit | null; opened: ShellOpened | null }
  | {
      kind: "error";
      code: number | null;
      close: ShellCloseDescription;
      /** The relay's own explanation, from the `exit` before the close. */
      detail: string | null;
    };

/** How long Disconnect waits for the relay's `exit` before closing the socket itself. */
const CLOSE_GRACE_MS = 2_000;
/** Shortcut that moves focus out of the terminal; Tab itself belongs to the shell. */
const RELEASE_FOCUS_HINT = "Ctrl+]";
const SCREEN_READER_KEY = "roundhouse.shell.screen-reader";

const PHASE_LABELS: Record<Phase["kind"], string> = {
  idle: "Not connected",
  connecting: "Connecting…",
  open: "Connected",
  closing: "Disconnecting…",
  closed: "Disconnected",
  error: "Disconnected",
};

function readScreenReaderMode(): boolean {
  try {
    return localStorage.getItem(SCREEN_READER_KEY) === "on";
  } catch {
    return false;
  }
}

function writeScreenReaderMode(enabled: boolean): void {
  try {
    localStorage.setItem(SCREEN_READER_KEY, enabled ? "on" : "off");
  } catch {}
}

function formatCountdown(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function targetLabel(target: ShellTarget): string {
  const base = `Replica ${target.replica} on ${target.node_name}`;
  // NOTE: The API reports false both for agents older than v7 and for offline servers.
  if (!target.shell_supported) return `${base} (offline or needs agent v7)`;
  return target.state === "running" ? base : `${base} (${target.state})`;
}

/** The gate's refusal in words, with what the user can do. */
function GateMessage({
  gate,
  workspaceId,
  environmentName,
}: {
  gate: ShellTargets["gate"];
  workspaceId: string;
  environmentName: string | undefined;
}) {
  if (gate.allowed || !gate.reason) return null;
  let body: ReactNode;
  switch (gate.reason) {
    case "reauth_required":
      body =
        "Opening a shell needs a recent sign-in. You'll be asked for your password when you connect.";
      break;
    case "two_factor_required":
      body = (
        <>
          Shells need two-factor authentication on your account, whatever the workspace policy.{" "}
          <Link
            to="/w/$workspaceId/security"
            params={{ workspaceId }}
            className="text-accent-text underline-offset-4 outline-none hover:underline focus-visible:underline"
          >
            Turn it on in Account → Security
          </Link>
          , then come back.
        </>
      );
      break;
    case "protected_environment":
      body = `${environmentName ?? "This environment"} is protected: API tokens can't open shells here. Use a signed-in browser or CLI session.`;
      break;
    case "oauth_token":
      body = "Apps connected over OAuth (MCP clients) can't open shells.";
      break;
    default:
      body =
        "You can't open a shell in this service. Shells are for project admins, and a protected environment's rules must allow them.";
  }
  const tone = gate.reason === "reauth_required" ? "text-muted-foreground" : "text-warning";
  return (
    <p role="status" className={`text-sm ${tone}`}>
      {body}
    </p>
  );
}

/**
 * The Shell tab. The route renders it for app and database services; the tab itself
 * also explains when it can't be used, for direct links.
 *
 * @param props - Workspace, project and service ids, and an optional socket factory.
 * @returns The tab.
 */
export function ShellTab({ workspaceId, projectId, serviceId, createSocket }: ShellTabProps) {
  const { project, environment } = useProjectEnvironment(projectId);
  const service = findService(project.data, serviceId);
  const access = useProjectPermissions(workspaceId, projectId);
  const targets = useShellTargets(serviceId, environment?.id);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [chosen, setChosen] = useState<string | null>(null);
  const [screenReader, setScreenReader] = useState(readScreenReaderMode);
  const [now, setNow] = useState(() => Date.now());
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const terminalRef = useRef<TerminalHandle | null>(null);
  const connectionRef = useRef<ShellConnection | null>(null);
  const exitRef = useRef<ShellExit | null>(null);
  const openedRef = useRef<ShellOpened | null>(null);
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const lastInputRef = useRef(Date.now());
  const graceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusTargetRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);
  const idleTimeoutRef = useRef(0);
  const selectId = useId();
  const srId = useId();

  const list = targets.data?.targets ?? [];
  const usable = (target: ShellTarget) => target.shell_supported;
  const target =
    list.find((entry) => entry.workload_id === chosen && usable(entry)) ?? list.find(usable);
  const gate = targets.data?.gate;
  const active = phase.kind === "connecting" || phase.kind === "open" || phase.kind === "closing";

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (graceRef.current) clearTimeout(graceRef.current);
      connectionRef.current?.dispose();
      connectionRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
    };
  }, []);

  const fitAndResize = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const size = terminal.fit();
    const previous = sizeRef.current;
    if (previous && previous.cols === size.cols && previous.rows === size.rows) return;
    sizeRef.current = size;
    connectionRef.current?.resize(size.cols, size.rows);
  }, []);

  useEffect(() => {
    if (!container) return;
    const observer = new ResizeObserver(() => fitAndResize());
    observer.observe(container);
    return () => observer.disconnect();
  }, [container, fitAndResize]);

  const idleTimeout = phase.kind === "open" ? (phase.opened?.idle_timeout_s ?? 0) : 0;
  useEffect(() => {
    if (idleTimeout <= 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [idleTimeout]);
  idleTimeoutRef.current = idleTimeout;
  const idleLeft = idleTimeout > 0 ? idleTimeout - (now - lastInputRef.current) / 1_000 : null;
  const idleWarning = idleLeft !== null && idleLeft <= SHELL_IDLE_WARNING_S;

  function ensureTerminal(create: Awaited<ReturnType<typeof loadTerminal>>): TerminalHandle {
    if (terminalRef.current) {
      terminalRef.current.reset();
      return terminalRef.current;
    }
    const element = container;
    if (!element) throw new Error("The terminal's element is not mounted.");
    const terminal = create(element, {
      label: `Shell in ${service?.name ?? "the service"}`,
      screenReaderMode: screenReader,
    });
    const onInput = () => {
      const before = lastInputRef.current;
      lastInputRef.current = Date.now();
      // NOTE: Re-render at once only when the countdown is showing, so it disappears on
      // the keystroke that resets it; otherwise the next tick catches up.
      if (idleTimeoutRef.current > 0) {
        const left = idleTimeoutRef.current - (Date.now() - before) / 1_000;
        if (left <= SHELL_IDLE_WARNING_S) rerender();
      }
    };
    terminal.onData((data) => {
      if (!connectionRef.current?.isOpen) return;
      onInput();
      connectionRef.current.sendInput(data);
    });
    terminal.onBinary((data) => {
      if (!connectionRef.current?.isOpen) return;
      onInput();
      connectionRef.current.sendBinary(data);
    });
    terminal.onKey((event) => {
      if (event.type === "keydown" && event.ctrlKey && event.key === "]") {
        terminal.blur();
        focusTargetRef.current?.focus();
        return false;
      }
      return true;
    });
    terminalRef.current = terminal;
    return terminal;
  }

  /** Connects; `reauthenticated` skips the gate the last render saw, which is stale then. */
  async function connect(reauthenticated = false) {
    if (!target || !environment) return;
    setLoadError(null);
    if (!reauthenticated && gate && !gate.allowed) {
      if (gate.reason !== "reauth_required") return;
      if (!(await requestReauth())) return;
      const refreshed = await targets.refetch();
      if (!refreshed.data?.gate.allowed) return;
    }
    if (!mountedRef.current) return;
    setPhase({ kind: "connecting" });
    let terminal: TerminalHandle;
    try {
      terminal = ensureTerminal(await loadTerminal());
    } catch (cause) {
      if (!mountedRef.current) return;
      setPhase({ kind: "idle" });
      setLoadError(errorMessage(cause, "Could not load the terminal."));
      return;
    }
    if (!mountedRef.current) return;
    connectionRef.current?.dispose();
    exitRef.current = null;
    openedRef.current = null;
    const size = terminal.fit();
    sizeRef.current = size;
    const connection = new ShellConnection(
      {
        onOutput: (bytes) => terminalRef.current?.write(bytes),
        onOpened: (message) => {
          if (connectionRef.current !== connection) return;
          openedRef.current = message;
          lastInputRef.current = Date.now();
          setPhase({ kind: "open", opened: message });
          fitAndResize();
          terminalRef.current?.focus();
        },
        onExit: (message) => {
          if (connectionRef.current === connection) exitRef.current = message;
        },
        onClose: (code) => {
          if (connectionRef.current !== connection || !mountedRef.current) return;
          if (graceRef.current) clearTimeout(graceRef.current);
          const exit = exitRef.current;
          // NOTE: The relay sends `exit` before refusals too, so the close code decides:
          // only 1000 is an ordinary end, anything else is explained as a refusal.
          if (code === SHELL_CLOSE_CODES.normal) {
            terminalRef.current?.writeNotice(
              `[${describeExitReason(exit?.reason ?? "closed")}${
                exit?.code !== null && exit?.code !== undefined ? `, exit code ${exit.code}` : ""
              }]`,
            );
            setPhase({ kind: "closed", exit, opened: openedRef.current });
          } else {
            const close = describeShellClose(code);
            terminalRef.current?.writeNotice(`[${close.title}]`);
            setPhase({ kind: "error", code, close, detail: exit?.message ?? null });
          }
        },
      },
      createSocket,
    );
    connectionRef.current = connection;
    terminal.writeNotice(`Connecting to replica ${target.replica} on ${target.node_name}…`);
    connection.connect(shellSocketUrl(target.workload_id, size));
  }

  function disconnect() {
    const connection = connectionRef.current;
    if (!connection) return;
    if (phase.kind === "connecting") {
      connection.dispose();
      connectionRef.current = null;
      setPhase({ kind: "closed", exit: null, opened: null });
      return;
    }
    connection.requestClose();
    setPhase({ kind: "closing", opened: openedRef.current });
    graceRef.current = setTimeout(() => {
      if (connectionRef.current !== connection || !mountedRef.current) return;
      connection.dispose();
      const exit = exitRef.current;
      setPhase({ kind: "closed", exit, opened: openedRef.current });
    }, CLOSE_GRACE_MS);
  }

  async function reauthAndReconnect() {
    if (!(await requestReauth())) return;
    const refreshed = await targets.refetch();
    if (refreshed.data?.gate.allowed) void connect(true);
  }

  function toggleScreenReader(enabled: boolean) {
    setScreenReader(enabled);
    writeScreenReaderMode(enabled);
    terminalRef.current?.setScreenReaderMode(enabled);
  }

  if (!project.data || !environment) {
    return (
      <div className="grid gap-3" aria-busy="true">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-80 rounded-md" />
      </div>
    );
  }
  if (service?.kind === "cron") {
    return (
      <EmptyState
        icon={<TerminalIcon />}
        title="No shell for cron services"
        description="A cron service has no long-running replica to open a shell in. Each run's output is under Runs."
        className="py-16"
      />
    );
  }
  if (!access.can("shell:open")) {
    return (
      <EmptyState
        icon={<TerminalIcon />}
        title="Shells are for project admins"
        description="A shell can read every variable of the service, secrets included, so only project admins may open one."
        className="py-16"
      />
    );
  }
  if (targets.isError) {
    return (
      <ErrorState message={errorMessage(targets.error)} onRetry={() => void targets.refetch()} />
    );
  }

  const opened =
    phase.kind === "open" || phase.kind === "closing" || phase.kind === "closed"
      ? phase.opened
      : null;
  const blocked = Boolean(gate && !gate.allowed && gate.reason !== "reauth_required");
  const started = phase.kind !== "idle";

  return (
    <div className="grid min-w-0 gap-4">
      <p className="flex max-w-[52rem] items-start gap-2 text-sm text-muted-foreground">
        <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
        <span>
          A shell runs as the container's user and can read every variable, secrets included.
          Sessions are audited (who, which replica, when, how long) but not recorded.
        </span>
      </p>
      {gate ? (
        <GateMessage gate={gate} workspaceId={workspaceId} environmentName={environment.name} />
      ) : null}

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor={selectId}>Replica</Label>
          {targets.isPending ? (
            <Skeleton className="h-8 w-64" />
          ) : list.length === 0 ? (
            <p id={selectId} className="text-sm text-muted-foreground">
              No running replicas in {environment.name}. Deploy the service first.
            </p>
          ) : (
            <Select
              id={selectId}
              value={target?.workload_id ?? ""}
              disabled={active}
              onChange={(event) => setChosen(event.target.value)}
              className="w-72 max-w-full"
            >
              {list.map((entry) => (
                <option key={entry.workload_id} value={entry.workload_id} disabled={!usable(entry)}>
                  {targetLabel(entry)}
                </option>
              ))}
            </Select>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {active ? (
            <Button variant="secondary" onClick={disconnect} disabled={phase.kind === "closing"}>
              Disconnect
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => void connect()}
              disabled={!target || blocked || targets.isFetching}
            >
              <TerminalIcon />
              {started ? "Reconnect" : "Connect"}
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2 sm:ml-auto">
          <Switch id={srId} checked={screenReader} onCheckedChange={toggleScreenReader} />
          <Label htmlFor={srId} className="text-sm font-normal text-muted-foreground">
            Screen reader mode
          </Label>
        </div>
      </div>

      {loadError ? (
        <p role="alert" className="text-sm text-danger">
          {loadError}
        </p>
      ) : null}
      {phase.kind === "error" ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger/40 bg-danger/10 py-2 pr-2 pl-3.5 text-sm text-foreground"
        >
          <span>
            <span className="font-medium">{phase.close.title}.</span> {phase.close.message}
            {phase.detail ? <span className="text-muted-foreground"> {phase.detail}.</span> : null}
            {phase.code !== null ? (
              <span className="text-muted-foreground"> (code {phase.code})</span>
            ) : null}
          </span>
          {phase.close.remedy === "reauth" ? (
            <Button size="sm" variant="primary" onClick={() => void reauthAndReconnect()}>
              Confirm and reconnect
            </Button>
          ) : phase.close.remedy === "two_factor" ? (
            <Button size="sm" variant="secondary" asChild>
              <Link to="/w/$workspaceId/security" params={{ workspaceId }}>
                Set up two-factor
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}
      {phase.kind === "closed" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {describeExitReason(phase.exit?.reason ?? "closed")}
          {phase.exit?.code !== null && phase.exit?.code !== undefined
            ? ` (exit code ${phase.exit.code})`
            : ""}
          {phase.exit?.message ? `: ${phase.exit.message}` : ""}. Reconnect opens a new session.
        </p>
      ) : null}

      <section
        aria-label="Terminal"
        className="relative min-w-0 overflow-hidden rounded-md border border-border bg-background"
      >
        <div ref={setContainer} className="h-[60vh] min-h-72 w-full p-2" />
        {started ? null : (
          <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
            {target
              ? `Connect to open a shell in replica ${target.replica} on ${target.node_name}.`
              : "Pick a replica to connect to."}
          </div>
        )}
      </section>

      <div
        ref={focusTargetRef}
        tabIndex={-1}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-live="polite" className="text-foreground">
          {PHASE_LABELS[phase.kind]}
        </span>
        {opened ? (
          <>
            <span>{opened.node_name}</span>
            <span>user {opened.user}</span>
            <span>replica {opened.replica}</span>
          </>
        ) : target ? (
          <>
            <span>{target.node_name}</span>
            <span>replica {target.replica}</span>
          </>
        ) : null}
        <span>not recorded</span>
        {phase.kind === "open" && idleWarning && idleLeft !== null ? (
          <span role="timer" aria-label="Idle timeout" className="text-warning">
            closes in {formatCountdown(idleLeft)} if idle
          </span>
        ) : null}
        {phase.kind === "open" && idleWarning ? (
          <span className="sr-only" aria-live="assertive">
            The session closes in about a minute unless you type.
          </span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        The terminal keeps Tab and arrow keys. Press{" "}
        <kbd className="font-mono text-foreground">{RELEASE_FOCUS_HINT}</kbd> to move focus out of
        it.
      </p>
    </div>
  );
}
