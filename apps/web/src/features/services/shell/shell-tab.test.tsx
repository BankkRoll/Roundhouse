import { SHELL_CLOSE_CODES, SHELL_IDLE_WARNING_S } from "@roundhouse/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, PASSWORD, signInAs, USERS } from "../../../mocks/db";
import { MOCK_TOTP_CODE } from "../../../mocks/security-db";
import {
  exitShellSession,
  MOCK_SHELL_IDLE_TIMEOUT_S,
  type MockShellSession,
  shellMock,
} from "../../../mocks/shell-handlers";
import { SEED, servicePath } from "../../../test/phase1";
import { renderApp } from "../../../test/render";

/**
 * jsdom has no canvas, so xterm.js can't run; the tab only talks to `TerminalHandle`,
 * which this fake implements and records.
 */
const terminal = vi.hoisted(() => {
  class FakeTerminal {
    output: string[] = [];
    notices: string[] = [];
    size = { cols: 80, rows: 24 };
    focused = false;
    screenReaderMode: boolean;
    label: string;
    disposed = false;
    private data: ((data: string) => void)[] = [];
    private keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
    constructor(options: { label: string; screenReaderMode: boolean }) {
      this.label = options.label;
      this.screenReaderMode = options.screenReaderMode;
    }
    get cols() {
      return this.size.cols;
    }
    get rows() {
      return this.size.rows;
    }
    write(bytes: Uint8Array) {
      this.output.push(new TextDecoder().decode(bytes));
    }
    writeNotice(text: string) {
      this.notices.push(text);
    }
    onData(listener: (data: string) => void) {
      this.data.push(listener);
      return { dispose: () => {} };
    }
    onBinary() {
      return { dispose: () => {} };
    }
    fit() {
      return { ...this.size };
    }
    reset() {
      this.output = [];
    }
    focus() {
      this.focused = true;
    }
    blur() {
      this.focused = false;
    }
    setScreenReaderMode(enabled: boolean) {
      this.screenReaderMode = enabled;
    }
    onKey(handler: (event: KeyboardEvent) => boolean) {
      this.keyHandler = handler;
    }
    dispose() {
      this.disposed = true;
    }
    type(data: string) {
      for (const listener of this.data) listener(data);
    }
    key(init: KeyboardEventInit) {
      return this.keyHandler?.(new KeyboardEvent("keydown", init));
    }
  }
  const state = { instances: [] as FakeTerminal[] };
  return {
    state,
    loadTerminal:
      async () =>
      (_element: HTMLElement, options: { label: string; screenReaderMode: boolean }) => {
        const instance = new FakeTerminal(options);
        state.instances.push(instance);
        return instance;
      },
  };
});

vi.mock("./terminal", () => ({ loadTerminal: terminal.loadTerminal }));

const SHELL = servicePath(SEED.web, "shell");

let resizeCallbacks: (() => void)[] = [];

beforeEach(() => {
  terminal.state.instances = [];
  resizeCallbacks = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  db.security.twoFactor[USERS.owner.id] = { backupCodes: [] };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const term = () => terminal.state.instances.at(-1)!;
const session = () => shellMock.sessions.at(-1) as MockShellSession;

async function openShell() {
  const app = renderApp(SHELL);
  await screen.findByRole("combobox", { name: "Replica" });
  return app;
}

async function connect(user: ReturnType<typeof renderApp>["user"]) {
  await user.click(await screen.findByRole("button", { name: "Connect" }));
  await screen.findByText("Connected");
  await waitFor(() => expect(session()).toBeDefined());
}

describe("Shell tab", () => {
  it("shows the tab to project admins of app services, not to developers", async () => {
    renderApp(servicePath(SEED.web, "deployments"));
    const nav = await screen.findByRole("navigation", { name: "Service" });
    expect(await within(nav).findByRole("link", { name: "Shell" })).toBeInTheDocument();
  });

  it("hides the tab from members and explains a direct link", async () => {
    signInAs(USERS.member.id);
    renderApp(SHELL);
    expect(await screen.findByText("Shells are for project admins")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Service" });
    expect(within(nav).queryByRole("link", { name: "Shell" })).not.toBeInTheDocument();
  });

  it("warns before connecting and never connects on its own", async () => {
    await openShell();
    expect(screen.getByText(/can read every variable, secrets included/)).toBeInTheDocument();
    expect(screen.getByText(/audited .* but not recorded/)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Replica" })).toHaveDisplayValue(
      "Replica 0 on hel-1",
    );
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(shellMock.sessions).toHaveLength(0);
  });

  it("marks replicas on outdated agents as needing v7", async () => {
    shellMock.outdatedNodes.add("node_hel1");
    await openShell();
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("Replica 0 on hel-1 (offline or needs agent v7)");
    expect(options[0]).toBeDisabled();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("explains two-factor and links to Account → Security", async () => {
    delete db.security.twoFactor[USERS.owner.id];
    await openShell();
    expect(await screen.findByText(/need two-factor authentication/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Turn it on in Account → Security" })).toHaveAttribute(
      "href",
      "/w/ws_acme/security",
    );
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("asks for the password first when the session isn't fresh, then connects", async () => {
    db.sessionStale = true;
    const { user } = await openShell();
    expect(await screen.findByText(/needs a recent sign-in/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.type(within(reauth).getByLabelText("Password"), PASSWORD);
    await user.click(within(reauth).getByRole("button", { name: "Confirm" }));
    await user.type(await within(reauth).findByLabelText("Authentication code"), MOCK_TOTP_CODE);
    await user.click(within(reauth).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(db.sessionStale).toBe(false);
    expect(shellMock.sessions).toHaveLength(1);
  });

  it("connects to the replica's socket with the terminal size, and shows the status line", async () => {
    const { user } = await openShell();
    await connect(user);
    const url = session().url;
    expect(url.protocol).toBe("ws:");
    expect(url.pathname).toBe(`/v1/workloads/wl_${SEED.webActive}_0/shell`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      cols: "80",
      rows: "24",
      term: "xterm-256color",
    });
    expect(screen.getByText("user node")).toBeInTheDocument();
    expect(screen.getByText("replica 0")).toBeInTheDocument();
    expect(screen.getByText("not recorded")).toBeInTheDocument();
    expect(term().focused).toBe(true);
    expect(term().label).toBe("Shell in web");
    expect(screen.getByRole("combobox", { name: "Replica" })).toBeDisabled();
  });

  it("sends keystrokes as binary frames and writes output to the terminal", async () => {
    const { user } = await openShell();
    await connect(user);
    act(() => term().type("ls\r"));
    await waitFor(() => expect(session().input).toEqual(["ls\r"]));
    await waitFor(() => expect(term().output.join("")).toBe("ls\r"));
    act(() => session().send(new TextEncoder().encode("total 0\r\n")));
    await waitFor(() => expect(term().output.join("")).toBe("ls\rtotal 0\r\n"));
  });

  it("sends the new size when the terminal is refitted", async () => {
    const { user } = await openShell();
    await connect(user);
    term().size = { cols: 132, rows: 40 };
    act(() => {
      for (const callback of resizeCallbacks) callback();
    });
    await waitFor(() =>
      expect(session().control).toContainEqual({ type: "resize", cols: 132, rows: 40 }),
    );
  });

  it("shows why the session ended, with the exit code", async () => {
    const { user } = await openShell();
    await connect(user);
    act(() => exitShellSession(session(), { reason: "exited", code: 130 }));
    expect(await screen.findByText(/The process exited \(exit code 130\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeEnabled();
  });

  it("disconnects with a close message, and reconnects as a new session", async () => {
    const { user } = await openShell();
    await connect(user);
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(session().control).toContainEqual({ type: "close" }));
    expect(await screen.findByText(/You disconnected/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    await screen.findByText("Connected");
    await waitFor(() => expect(shellMock.sessions).toHaveLength(2));
    expect(shellMock.sessions[1]!.id).not.toBe(shellMock.sessions[0]!.id);
  });

  it.each([
    [SHELL_CLOSE_CODES.busy, /Server busy\./],
    [SHELL_CLOSE_CODES.nodeUnavailable, /Server unavailable\./],
    [SHELL_CLOSE_CODES.forbidden, /Access denied\./],
  ])("explains close code %i", async (code, message) => {
    shellMock.refuseWith = code;
    const { user } = await openShell();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(alert).toHaveTextContent(`(code ${code})`);
  });

  it("adds the relay's own explanation to a refusal", async () => {
    shellMock.refuseWith = SHELL_CLOSE_CODES.nodeUnavailable;
    const { user } = await openShell();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Server unavailable. The server's agent isn't connected. Try again once it is back online. The node's agent isn't connected.",
    );
  });

  it("offers to upgrade when the agent is too old", async () => {
    shellMock.refuseWith = SHELL_CLOSE_CODES.agentOutdated;
    const { user } = await openShell();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Upgrade it to v7/);
  });

  it("re-authenticates and reconnects when the relay asks for a fresh session", async () => {
    shellMock.refuseWith = SHELL_CLOSE_CODES.reauthRequired;
    const { user } = await openShell();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Confirm it's you/);
    shellMock.refuseWith = null;
    await user.click(within(alert).getByRole("button", { name: "Confirm and reconnect" }));
    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.type(within(reauth).getByLabelText("Password"), PASSWORD);
    await user.click(within(reauth).getByRole("button", { name: "Confirm" }));
    await user.type(await within(reauth).findByLabelText("Authentication code"), MOCK_TOTP_CODE);
    await user.click(within(reauth).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Connected")).toBeInTheDocument();
  });

  it("counts down from a minute before the idle timeout, and resets on input", async () => {
    // NOTE: Only the interval and the clock are faked, before the session opens so the
    // countdown's interval is a fake one; Testing Library keeps its real timeouts.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { user } = await openShell();
    await connect(user);
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime((MOCK_SHELL_IDLE_TIMEOUT_S - SHELL_IDLE_WARNING_S - 1) * 1000);
    });
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByRole("timer", { name: "Idle timeout" })).toHaveTextContent(
      "closes in 0:59 if idle",
    );
    act(() => term().type("x"));
    expect(screen.queryByRole("timer")).not.toBeInTheDocument();
  });

  it("hands focus back to the page on Ctrl+]", async () => {
    const { user } = await openShell();
    await connect(user);
    let kept: boolean | undefined;
    act(() => {
      kept = term().key({ key: "]", ctrlKey: true });
    });
    expect(kept).toBe(false);
    expect(term().focused).toBe(false);
    expect(document.activeElement).toHaveTextContent("Connected");
    expect(screen.getByText(/to move focus out of it/)).toBeInTheDocument();
  });

  it("toggles screen reader mode on the terminal", async () => {
    const { user } = await openShell();
    await connect(user);
    await user.click(screen.getByRole("switch", { name: "Screen reader mode" }));
    expect(term().screenReaderMode).toBe(true);
  });

  it("closes the socket and the terminal when the tab is left", async () => {
    const { user, router } = await openShell();
    await connect(user);
    const open = session();
    await act(() => router.navigate({ to: servicePath(SEED.web, "logs") }));
    await waitFor(() => expect(open.control).toContainEqual({ type: "close" }));
    expect(term().disposed).toBe(true);
  });
});
