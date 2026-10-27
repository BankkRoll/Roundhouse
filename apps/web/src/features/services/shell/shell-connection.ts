/**
 * Browser side of one web shell session (`/v1/workloads/{id}/shell`, ADR 0012).
 *
 * Responsibilities:
 * - one socket per session, never reconnected: a shell has no resume, so "Reconnect"
 *   is a new {@link ShellConnection};
 * - binary frames both ways for terminal bytes, JSON text frames for control
 *   (`resize`, `close` out; `opened`, `exit` in), shape-checked before use;
 * - splitting large input (a paste) into frames well under
 *   `SHELL_MAX_CLIENT_FRAME_BYTES`;
 * - turning close codes and exit reasons into words and a next step
 *   ({@link describeShellClose}, {@link describeExitReason}).
 *
 * Framework-free, so it is tested with a fake WebSocket.
 *
 * @module
 */
import {
  SHELL_CLOSE_CODES,
  type ShellClientMessage,
  type ShellExitReason,
  type ShellServerMessage,
} from "@roundhouse/shared";

/** The subset of the browser WebSocket a shell needs. */
export interface ShellSocket {
  readonly readyState: number;
  binaryType: string;
  send(data: string | ArrayBufferView | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** Creates a socket for a URL. Defaults to `new WebSocket(url)`. */
export type ShellSocketFactory = (url: string) => ShellSocket;

/** The `opened` message: where the process runs and its limits. */
export type ShellOpened = Extract<ShellServerMessage, { type: "opened" }>;
/** The `exit` message: why the session ended. */
export type ShellExit = Extract<ShellServerMessage, { type: "exit" }>;

/** Callbacks of a {@link ShellConnection}. */
export interface ShellConnectionHandlers {
  /** Terminal output bytes. */
  onOutput: (bytes: Uint8Array) => void;
  /** The process started. */
  onOpened: (message: ShellOpened) => void;
  /** The session ended; a close follows. */
  onExit: (message: ShellExit) => void;
  /** The socket closed, with the server's code (1006 when it dropped). */
  onClose: (code: number, reason: string) => void;
}

const OPEN = 1;
/** Input frames stay this small, as the relay coalesces them (ADR 0012). */
export const SHELL_INPUT_CHUNK_BYTES = 16 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function parseServerMessage(text: string): ShellServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const message = value as Record<string, unknown>;
  if (
    message.type === "opened" &&
    typeof message.session_id === "string" &&
    typeof message.node_name === "string" &&
    typeof message.user === "string" &&
    typeof message.replica === "number" &&
    typeof message.idle_timeout_s === "number" &&
    typeof message.max_duration_s === "number"
  ) {
    return message as unknown as ShellOpened;
  }
  if (
    message.type === "exit" &&
    typeof message.reason === "string" &&
    (message.code === null || typeof message.code === "number")
  ) {
    return message as unknown as ShellExit;
  }
  return null;
}

/**
 * Output bytes of a binary frame. With `binaryType = "arraybuffer"` that is an
 * ArrayBuffer, handled synchronously so output keeps its order with control frames.
 */
function toBytes(data: unknown): Uint8Array | Promise<Uint8Array> | null {
  // COMPAT: Checked by tag, not `instanceof`: buffers from another realm (a test
  // environment's, a worker's) fail `instanceof ArrayBuffer`.
  if (Object.prototype.toString.call(data) === "[object ArrayBuffer]") {
    return new Uint8Array(data as ArrayBuffer);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.arrayBuffer().then((buffer) => new Uint8Array(buffer));
  }
  return null;
}

/**
 * One shell session over one socket. Call {@link ShellConnection.connect} once, and
 * {@link ShellConnection.dispose} when the view goes away.
 */
export class ShellConnection {
  private socket: ShellSocket | null = null;
  private closed = false;

  /**
   * @param handlers - Output, control and close callbacks.
   * @param createSocket - Socket factory, injectable for tests.
   */
  constructor(
    private readonly handlers: ShellConnectionHandlers,
    private readonly createSocket: ShellSocketFactory = (url) =>
      new WebSocket(url) as unknown as ShellSocket,
  ) {}

  /** Whether the socket is open and accepts input. */
  get isOpen(): boolean {
    return this.socket?.readyState === OPEN;
  }

  /**
   * Opens the socket.
   *
   * @param url - Absolute shell socket URL (see `shellSocketUrl`).
   */
  connect(url: string): void {
    if (this.socket) return;
    const socket = this.createSocket(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onmessage = (event) => this.receive(event.data);
    socket.onclose = (event) => {
      if (this.closed) return;
      this.closed = true;
      this.handlers.onClose(event.code, event.reason ?? "");
    };
  }

  private receive(data: unknown): void {
    if (typeof data === "string") {
      const message = parseServerMessage(data);
      if (message?.type === "opened") this.handlers.onOpened(message);
      else if (message?.type === "exit") this.handlers.onExit(message);
      return;
    }
    const bytes = toBytes(data);
    if (bytes instanceof Promise) {
      void bytes.then((resolved) => this.output(resolved));
    } else if (bytes) {
      this.output(bytes);
    }
  }

  private output(bytes: Uint8Array): void {
    if (!this.closed) this.handlers.onOutput(bytes);
  }

  /**
   * Sends keystrokes or pasted text as binary frames, UTF-8 encoded.
   *
   * @param data - What xterm's `onData` reported.
   */
  sendInput(data: string): void {
    this.sendBytes(encoder.encode(data));
  }

  /**
   * Sends raw bytes from xterm's `onBinary` (a string of byte-valued characters, used
   * for some mouse reports).
   *
   * @param data - One character per byte.
   */
  sendBinary(data: string): void {
    const bytes = new Uint8Array(data.length);
    for (let index = 0; index < data.length; index += 1) {
      bytes[index] = data.charCodeAt(index) & 0xff;
    }
    this.sendBytes(bytes);
  }

  private sendBytes(bytes: Uint8Array): void {
    if (!this.socket || !this.isOpen || bytes.length === 0) return;
    for (let start = 0; start < bytes.length; start += SHELL_INPUT_CHUNK_BYTES) {
      this.socket.send(bytes.subarray(start, start + SHELL_INPUT_CHUNK_BYTES));
    }
  }

  /**
   * Tells the process the terminal's new size.
   *
   * @param cols - Columns.
   * @param rows - Rows.
   */
  resize(cols: number, rows: number): void {
    this.sendControl({ type: "resize", cols, rows });
  }

  /** Asks the relay to end the session; it answers with `exit`, then closes. */
  requestClose(): void {
    this.sendControl({ type: "close" });
  }

  private sendControl(message: ShellClientMessage): void {
    if (this.socket && this.isOpen) this.socket.send(JSON.stringify(message));
  }

  /**
   * Closes the socket without reporting it (the view is going away, or the relay didn't
   * close after {@link ShellConnection.requestClose}).
   */
  dispose(): void {
    const socket = this.socket;
    this.closed = true;
    if (!socket) return;
    socket.onmessage = null;
    socket.onclose = null;
    if (socket.readyState === OPEN) {
      socket.send(JSON.stringify({ type: "close" } satisfies ShellClientMessage));
    }
    if (socket.readyState <= OPEN) socket.close(SHELL_CLOSE_CODES.normal, "closed");
  }
}

/**
 * Decodes output bytes for tests and plain-text fallbacks.
 *
 * @param bytes - Terminal output.
 * @returns The text.
 */
export function decodeOutput(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** What the user can do about a closed shell. */
export type ShellRemedy = "reauth" | "two_factor" | "upgrade_agent" | "retry" | "sign_in" | "none";

/** A close code in words. */
export interface ShellCloseDescription {
  title: string;
  message: string;
  remedy: ShellRemedy;
}

/**
 * Explains why a shell socket closed, and what to do next.
 *
 * @param code - The close code.
 * @returns Title, explanation and remedy.
 * @example
 * describeShellClose(4409).remedy; // "retry"
 */
export function describeShellClose(code: number): ShellCloseDescription {
  switch (code) {
    case SHELL_CLOSE_CODES.reauthRequired:
      return {
        title: "Confirm it's you",
        message: "Opening a shell needs a recent sign-in. Confirm your password, then reconnect.",
        remedy: "reauth",
      };
    case SHELL_CLOSE_CODES.twoFactorRequired:
      return {
        title: "Two-factor authentication required",
        message: "Shells need two-factor authentication on your account. Turn it on, then retry.",
        remedy: "two_factor",
      };
    case SHELL_CLOSE_CODES.agentOutdated:
      return {
        title: "Agent too old",
        message: "This server's agent predates web shells. Upgrade it to v7 or later.",
        remedy: "upgrade_agent",
      };
    case SHELL_CLOSE_CODES.busy:
      return {
        title: "Server busy",
        message: "The server already runs as many shell sessions as it allows. Try again shortly.",
        remedy: "retry",
      };
    case SHELL_CLOSE_CODES.nodeUnavailable:
      return {
        title: "Server unavailable",
        message: "The server's agent isn't connected. Try again once it is back online.",
        remedy: "retry",
      };
    case SHELL_CLOSE_CODES.forbidden:
      return {
        title: "Access denied",
        message:
          "You can't open a shell here, or your access changed while it was open. Ask a project admin.",
        remedy: "none",
      };
    case SHELL_CLOSE_CODES.notFound:
      return {
        title: "Replica not found",
        message: "The replica isn't running any more. Pick another one and connect again.",
        remedy: "retry",
      };
    case SHELL_CLOSE_CODES.unauthorized:
      return {
        title: "Signed out",
        message: "Your session ended. Sign in again to open a shell.",
        remedy: "sign_in",
      };
    case SHELL_CLOSE_CODES.protectedEnvironment:
      return {
        title: "Protected environment",
        message: "API tokens can't open shells in a protected environment.",
        remedy: "none",
      };
    case SHELL_CLOSE_CODES.policy:
    case SHELL_CLOSE_CODES.tooBig:
      return {
        title: "Session ended by the server",
        message: "The server refused a message from this terminal. Reconnect to start over.",
        remedy: "retry",
      };
    default:
      return {
        title: "Connection lost",
        message: "The connection to the shell dropped. Reconnect to open a new session.",
        remedy: "retry",
      };
  }
}

const EXIT_REASONS: Record<ShellExitReason, string> = {
  exited: "The process exited",
  closed: "You disconnected",
  idle_timeout: "Closed after being idle",
  max_duration: "Reached the longest a session may last",
  error: "The session failed",
  revoked: "Closed because your access changed",
  node_disconnected: "The server's agent disconnected",
  timeout: "The server didn't answer in time",
};

/**
 * Says why a session ended.
 *
 * @param reason - The `exit` message's reason.
 * @returns A short sentence.
 */
export function describeExitReason(reason: string): string {
  return EXIT_REASONS[reason as ShellExitReason] ?? "The session ended";
}
