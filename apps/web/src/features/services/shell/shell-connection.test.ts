import { SHELL_CLOSE_CODES } from "@roundhouse/shared";
import { describe, expect, it, vi } from "vitest";
import { shellSocketUrl } from "../../../lib/api/shell-client";
import {
  describeExitReason,
  describeShellClose,
  SHELL_INPUT_CHUNK_BYTES,
  ShellConnection,
  type ShellConnectionHandlers,
  type ShellSocket,
} from "./shell-connection";

class FakeSocket implements ShellSocket {
  readyState = 0;
  binaryType = "blob";
  sent: (string | Uint8Array)[] = [];
  closedWith: number | null = null;
  onopen: ShellSocket["onopen"] = null;
  onclose: ShellSocket["onclose"] = null;
  onmessage: ShellSocket["onmessage"] = null;
  onerror: ShellSocket["onerror"] = null;

  constructor(readonly url: string) {}

  send(data: string | ArrayBufferView | ArrayBuffer) {
    this.sent.push(
      typeof data === "string"
        ? data
        : new Uint8Array(
            ArrayBuffer.isView(data)
              ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
              : data,
          ),
    );
  }

  close(code?: number) {
    this.closedWith = code ?? null;
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(data: unknown) {
    this.onmessage?.({ data });
  }

  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function setup() {
  const handlers: ShellConnectionHandlers = {
    onOutput: vi.fn(),
    onOpened: vi.fn(),
    onExit: vi.fn(),
    onClose: vi.fn(),
  };
  let socket: FakeSocket | undefined;
  const connection = new ShellConnection(handlers, (url) => {
    socket = new FakeSocket(url);
    return socket;
  });
  connection.connect("ws://localhost/v1/workloads/wl_1/shell?cols=80&rows=24");
  return { handlers, connection, socket: socket as unknown as FakeSocket };
}

const text = (bytes: string | Uint8Array) =>
  typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);

describe("shellSocketUrl", () => {
  it("uses the page's origin with the matching ws scheme and the terminal size", () => {
    expect(shellSocketUrl("wl 1", { cols: 120, rows: 40 }, "https://cp.example.com")).toBe(
      "wss://cp.example.com/v1/workloads/wl%201/shell?cols=120&rows=40&term=xterm-256color",
    );
    expect(shellSocketUrl("wl_1", { cols: 80, rows: 24 }, "http://localhost:5173")).toMatch(
      /^ws:\/\/localhost:5173\//,
    );
  });
});

describe("ShellConnection", () => {
  it("asks for array buffers and sends keystrokes as UTF-8 binary frames", () => {
    const { connection, socket } = setup();
    expect(socket.binaryType).toBe("arraybuffer");
    connection.sendInput("ls é\r");
    expect(socket.sent).toEqual([]);
    socket.open();
    connection.sendInput("ls é\r");
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toBeInstanceOf(Uint8Array);
    expect(text(socket.sent[0]!)).toBe("ls é\r");
  });

  it("sends onBinary data byte for byte", () => {
    const { connection, socket } = setup();
    socket.open();
    connection.sendBinary("\x1b[M\xff");
    expect([...(socket.sent[0] as Uint8Array)]).toEqual([0x1b, 0x5b, 0x4d, 0xff]);
  });

  it("splits a large paste into frames under the relay's limit", () => {
    const { connection, socket } = setup();
    socket.open();
    connection.sendInput("x".repeat(SHELL_INPUT_CHUNK_BYTES * 2 + 5));
    expect(socket.sent.map((frame) => (frame as Uint8Array).length)).toEqual([
      SHELL_INPUT_CHUNK_BYTES,
      SHELL_INPUT_CHUNK_BYTES,
      5,
    ]);
  });

  it("sends resize and close as JSON text frames", () => {
    const { connection, socket } = setup();
    socket.open();
    connection.resize(100, 30);
    connection.requestClose();
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "resize", cols: 100, rows: 30 }),
      JSON.stringify({ type: "close" }),
    ]);
  });

  it("hands output bytes, opened and exit messages to their handlers", async () => {
    const { handlers, socket } = setup();
    socket.open();
    socket.receive(new TextEncoder().encode("hello").buffer);
    const opened = {
      type: "opened",
      session_id: "shl_1",
      node_id: "node_1",
      node_name: "hel-1",
      user: "node",
      replica: 0,
      idle_timeout_s: 900,
      max_duration_s: 28_800,
    };
    socket.receive(JSON.stringify(opened));
    socket.receive(JSON.stringify({ type: "exit", code: 0, reason: "exited" }));
    socket.receive(JSON.stringify({ type: "bogus" }));
    socket.receive("not json");
    await vi.waitFor(() => expect(handlers.onOutput).toHaveBeenCalledTimes(1));
    expect(text(vi.mocked(handlers.onOutput).mock.calls[0]![0])).toBe("hello");
    expect(handlers.onOpened).toHaveBeenCalledWith(opened);
    expect(handlers.onExit).toHaveBeenCalledWith({ type: "exit", code: 0, reason: "exited" });
  });

  it("reports the close code once", () => {
    const { handlers, socket } = setup();
    socket.open();
    socket.serverClose(SHELL_CLOSE_CODES.busy);
    socket.serverClose(SHELL_CLOSE_CODES.busy);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(handlers.onClose).toHaveBeenCalledWith(SHELL_CLOSE_CODES.busy, "");
  });

  it("asks the relay to close and closes the socket on dispose, without reporting it", () => {
    const { handlers, connection, socket } = setup();
    socket.open();
    connection.dispose();
    expect(socket.sent).toEqual([JSON.stringify({ type: "close" })]);
    expect(socket.closedWith).toBe(SHELL_CLOSE_CODES.normal);
    expect(handlers.onClose).not.toHaveBeenCalled();
  });
});

describe("describeShellClose", () => {
  it.each([
    [SHELL_CLOSE_CODES.reauthRequired, "reauth"],
    [SHELL_CLOSE_CODES.twoFactorRequired, "two_factor"],
    [SHELL_CLOSE_CODES.agentOutdated, "upgrade_agent"],
    [SHELL_CLOSE_CODES.busy, "retry"],
    [SHELL_CLOSE_CODES.nodeUnavailable, "retry"],
    [SHELL_CLOSE_CODES.forbidden, "none"],
    [SHELL_CLOSE_CODES.unauthorized, "sign_in"],
    [1006, "retry"],
  ])("maps %i to %s", (code, remedy) => {
    expect(describeShellClose(code).remedy).toBe(remedy);
  });

  it("words the common refusals", () => {
    expect(describeShellClose(SHELL_CLOSE_CODES.busy).title).toBe("Server busy");
    expect(describeShellClose(SHELL_CLOSE_CODES.nodeUnavailable).title).toBe("Server unavailable");
    expect(describeShellClose(SHELL_CLOSE_CODES.agentOutdated).message).toMatch(/v7/);
    expect(describeShellClose(SHELL_CLOSE_CODES.forbidden).message).toMatch(/access changed/);
  });
});

describe("describeExitReason", () => {
  it("says why a session ended", () => {
    expect(describeExitReason("idle_timeout")).toBe("Closed after being idle");
    expect(describeExitReason("revoked")).toBe("Closed because your access changed");
    expect(describeExitReason("something-new")).toBe("The session ended");
  });
});
