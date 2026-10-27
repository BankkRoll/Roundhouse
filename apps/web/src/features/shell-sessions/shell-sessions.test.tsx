import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, PASSWORD, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { MOCK_TOTP_CODE } from "../../mocks/security-db";
import { addRecordedShellSession, shellMock } from "../../mocks/shell-handlers";
import { SEED } from "../../test/phase1";
import { renderApp } from "../../test/render";

/** jsdom has no canvas, so the player's terminal is this fake (as in the Shell tab tests). */
const terminal = vi.hoisted(() => {
  class FakeTerminal {
    output: string[] = [];
    sizes: string[] = [];
    resets = 0;
    disposed = false;
    constructor(readonly options: { label: string; readOnly?: boolean }) {}
    get cols() {
      return 80;
    }
    get rows() {
      return 24;
    }
    write(bytes: Uint8Array) {
      this.output.push(new TextDecoder().decode(bytes));
    }
    writeNotice() {}
    onData() {
      return { dispose: () => {} };
    }
    onBinary() {
      return { dispose: () => {} };
    }
    fit() {
      return { cols: 80, rows: 24 };
    }
    resize(cols: number, rows: number) {
      this.sizes.push(`${cols}x${rows}`);
    }
    reset() {
      this.resets += 1;
      this.output = [];
    }
    focus() {}
    blur() {}
    setScreenReaderMode() {}
    onKey() {}
    dispose() {
      this.disposed = true;
    }
  }
  const state = { instances: [] as FakeTerminal[] };
  return {
    state,
    loadTerminal:
      async () => (_element: HTMLElement, options: { label: string; readOnly?: boolean }) => {
        const instance = new FakeTerminal(options);
        state.instances.push(instance);
        return instance;
      },
  };
});

vi.mock("../services/shell/terminal", () => ({ loadTerminal: terminal.loadTerminal }));

const PAGE = `/w/${WORKSPACE_ID}/shell-sessions`;
const CAST = [
  JSON.stringify({ version: 2, width: 100, height: 30 }),
  '[0.01,"o","$ "]',
  '[0.02,"i","typed-password\\r"]',
  '[0.03,"o","hello from the shell\\r\\n"]',
  '[0.04,"r","120x40"]',
  "",
].join("\n");

function session(id: string, over: Partial<Parameters<typeof addRecordedShellSession>[0]> = {}) {
  const now = Date.now();
  return {
    id,
    project_id: SEED.project,
    environment_id: SEED.production,
    service_id: SEED.web,
    workload_id: `wl_${SEED.webActive}_0`,
    deployment_id: SEED.webActive,
    replica: 0,
    node_id: "node_hel1",
    user_id: USERS.owner.id,
    token_id: null,
    command: "/bin/sh",
    container_user: "node",
    started_at: now - 5 * 60_000,
    opened_at: now - 5 * 60_000,
    ended_at: now - 2 * 60_000,
    end_reason: "exited",
    exit_code: 0,
    bytes_in: 14,
    bytes_out: 24,
    recording: "none" as const,
    recording_parts: 0,
    ...over,
  };
}

const term = () => terminal.state.instances.at(-1)!;

function bodyRows() {
  const [, body] = screen.getAllByRole("rowgroup");
  return within(body as HTMLElement).getAllByRole("row");
}

beforeEach(() => {
  terminal.state.instances = [];
  db.security.twoFactor[USERS.owner.id] = { backupCodes: [] };
  shellMock.rows.push(session("shl_plain", { started_at: Date.now() - 60 * 60_000 }));
  addRecordedShellSession(session("shl_recorded"), CAST);
});

describe("Shell sessions", () => {
  it("lists sessions with who, where, how long and whether they were recorded", async () => {
    renderApp(PAGE);
    expect(await screen.findByRole("heading", { name: "Shell sessions" })).toBeInTheDocument();
    await waitFor(() => expect(bodyRows()).toHaveLength(2));
    const [recorded, plain] = bodyRows();
    expect(recorded).toHaveTextContent("web");
    expect(recorded).toHaveTextContent("replica 0");
    expect(recorded).toHaveTextContent("Ada Lovelace");
    expect(recorded).toHaveTextContent("3m");
    expect(recorded).toHaveTextContent("The process exited");
    expect(within(recorded!).getByText("Recorded")).toBeInTheDocument();
    expect(
      within(recorded!).getByRole("button", { name: /Play the recording of web/ }),
    ).toBeEnabled();
    expect(within(plain!).queryByRole("button", { name: /Play/ })).not.toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(within(nav).getByRole("link", { name: "Shell sessions" })).toHaveAttribute("href", PAGE);
  });

  it("plays a recording's output and resizes, never its keystrokes, and audits the viewing", async () => {
    const { user } = renderApp(PAGE);
    await user.click(await screen.findByRole("button", { name: /Play the recording of web/ }));
    const dialog = await screen.findByRole("dialog", { name: "web, replica 0" });
    await waitFor(() => expect(term().output.join("")).toBe("$ hello from the shell\r\n"));
    expect(term().options).toMatchObject({ readOnly: true, label: "Recording of web, replica 0" });
    await waitFor(() => expect(term().sizes).toEqual(["100x30", "120x40"]));
    expect(term().output.join("")).not.toContain("typed-password");
    expect(db.audit.find((entry) => entry.action === "shell.recording_viewed")).toMatchObject({
      target_id: "shl_recorded",
    });

    const position = within(dialog).getByRole("progressbar", { name: "Playback position" });
    await waitFor(() => expect(position).toHaveAttribute("aria-valuetext", "0:00 of 0:00"));
    const twice = within(dialog).getByRole("button", { name: "2x speed" });
    await user.click(twice);
    expect(twice).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByRole("button", { name: "1x speed" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await user.click(within(dialog).getByRole("button", { name: "Restart" }));
    expect(term().resets).toBeGreaterThan(0);
    await waitFor(() => expect(term().output.join("")).toBe("$ hello from the shell\r\n"));

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(term().disposed).toBe(true));
  });

  it("asks for the password first when the session isn't fresh", async () => {
    db.sessionStale = true;
    const { user } = renderApp(PAGE);
    await user.click(await screen.findByRole("button", { name: /Play the recording of web/ }));
    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.type(within(reauth).getByLabelText("Password"), PASSWORD);
    await user.click(within(reauth).getByRole("button", { name: "Confirm" }));
    await user.type(await within(reauth).findByLabelText("Authentication code"), MOCK_TOTP_CODE);
    await user.click(within(reauth).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(term().output.join("")).toContain("hello from the shell"));
    expect(db.sessionStale).toBe(false);
  });

  it("says when the recording is gone", async () => {
    shellMock.recordings.delete("shl_recorded");
    const { user } = renderApp(PAGE);
    await user.click(await screen.findByRole("button", { name: /Play the recording of web/ }));
    expect(await screen.findByText("No recording is stored for this session.")).toBeInTheDocument();
  });

  it("is limited to audit readers", async () => {
    signInAs(USERS.member.id);
    renderApp(PAGE);
    expect(await screen.findByText("Shell sessions are limited to admins")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
