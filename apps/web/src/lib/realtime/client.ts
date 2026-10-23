/**
 * Browser side of a project's realtime socket (`/v1/projects/{id}/realtime`).
 *
 * Responsibilities:
 * - one WebSocket per open project, reconnecting with capped exponential backoff and
 *   jitter, and resubscribing to every log topic after each reconnect;
 * - reference-counted log subscriptions, so several viewers of one deployment's logs
 *   share a single `subscribe` message;
 * - acting on the server's close codes (`REALTIME_CLOSE_CODES`): 4401 means the session
 *   ended, 4403 that access was lost, 4404 that the project is gone; none of them is
 *   retried. A socket that closes before opening (a proxy or an older server refusing
 *   the upgrade) triggers a session check instead, and a signed-out result stops too;
 * - shape-checking every incoming frame before handing it on.
 *
 * Framework-free and clock-injectable, so it is tested with a fake WebSocket.
 *
 * @module
 */
import { REALTIME_CLOSE_CODES, shouldReconnect } from "@openrail/shared";
import type {
  RealtimeClientMessage,
  RealtimeLogLines,
  RealtimeServerMessage,
  RealtimeTopic,
} from "../api/deploy-types";

/** The subset of the browser WebSocket the client uses. */
export interface RealtimeSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/**
 * Connection state, for status indicators. `expired` (session ended), `forbidden`
 * (access lost) and `not_found` (project gone) are final: the client stopped retrying.
 */
export type RealtimeStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "expired"
  | "forbidden"
  | "not_found";

/** Timer functions, injectable for tests. */
export interface RealtimeTimers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/** Options for {@link RealtimeClient}. */
export interface RealtimeClientOptions {
  /** Absolute `ws:`/`wss:` URL of the project's socket. */
  url: string;
  /** Called for every valid server message. */
  onMessage: (message: RealtimeServerMessage) => void;
  /** Called whenever the connection state changes. */
  onStatus?: (status: RealtimeStatus) => void;
  /**
   * Resolves `false` when the session is gone (the API answers 401). Called when the
   * socket closes before it ever opened; other failures just reconnect.
   */
  checkSession?: () => Promise<boolean>;
  /**
   * Called once when the session is over: the server closed with 4401, or
   * {@link RealtimeClientOptions.checkSession} reported a dead session.
   */
  onSessionExpired?: () => void;
  /**
   * Called once when the server closes with 4403 (access lost) or 4404 (project gone).
   * The client stops reconnecting.
   */
  onUnavailable?: (reason: "forbidden" | "not_found") => void;
  /** Creates the socket. Defaults to `new WebSocket(url)`. */
  createSocket?: (url: string) => RealtimeSocket;
  /** First reconnect delay in ms. Defaults to 500. */
  baseDelayMs?: number;
  /** Longest reconnect delay in ms. Defaults to 30 s. */
  maxDelayMs?: number;
  /** Uniform random source in `[0, 1)` for jitter. Defaults to `Math.random`. */
  random?: () => number;
  /** Timer functions. Default to the global ones. */
  timers?: RealtimeTimers;
}

const OPEN = 1;
const MESSAGE_TYPES = new Set([
  "deployment.updated",
  "deployment.event",
  "log.lines",
  "service.updated",
  "presence",
]);

/**
 * Stable key of a log topic, also used to route `log.lines` to subscribers.
 *
 * @param topic - A deployment or build log topic.
 * @returns E.g. `deployment_logs:dep_1`.
 */
export function topicKey(topic: RealtimeTopic): string {
  return topic.kind === "deployment_logs"
    ? `deployment_logs:${topic.deployment_id}`
    : `build_logs:${topic.build_id}`;
}

/**
 * Topic key that a `log.lines` message belongs to.
 *
 * @param message - A log lines message.
 * @returns The key of the subscription it answers.
 */
export function logMessageTopicKey(message: RealtimeLogLines): string {
  return message.source.type === "runtime"
    ? `deployment_logs:${message.source.deployment_id}`
    : `build_logs:${message.source.build_id}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parses and shape-checks a text frame. Only the discriminant and the fields the
 * dashboard dereferences are checked; the API's schema is the full contract.
 *
 * @param data - Raw frame data.
 * @returns The message, or `null` for anything malformed or unknown.
 */
export function parseServerMessage(data: unknown): RealtimeServerMessage | null {
  if (typeof data !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObject(value) || typeof value.type !== "string" || !MESSAGE_TYPES.has(value.type)) {
    return null;
  }
  switch (value.type) {
    case "deployment.updated":
      return isObject(value.deployment) && typeof value.deployment.id === "string"
        ? (value as RealtimeServerMessage)
        : null;
    case "deployment.event":
      return isObject(value.event) && typeof value.event.deployment_id === "string"
        ? (value as RealtimeServerMessage)
        : null;
    case "service.updated":
      return isObject(value.service) && typeof value.service.project_id === "string"
        ? (value as RealtimeServerMessage)
        : null;
    case "presence":
      return Array.isArray(value.users) ? (value as RealtimeServerMessage) : null;
    default:
      return isObject(value.source) && Array.isArray(value.lines)
        ? (value as RealtimeServerMessage)
        : null;
  }
}

/**
 * Builds the socket URL for a project from the page's origin.
 *
 * @param projectId - Project id.
 * @param origin - Page origin. Defaults to `window.location.origin`.
 * @returns `ws://…` or `wss://…` URL.
 */
export function realtimeUrl(projectId: string, origin = window.location.origin): string {
  const url = new URL(`/v1/projects/${encodeURIComponent(projectId)}/realtime`, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

type LogListener = (message: RealtimeLogLines) => void;

type OptionalCallback = "onStatus" | "checkSession" | "onSessionExpired" | "onUnavailable";

/**
 * One project's realtime connection. Call {@link RealtimeClient.connect} once and
 * {@link RealtimeClient.close} when the project is left.
 */
export class RealtimeClient {
  private socket: RealtimeSocket | null = null;
  private opened = false;
  private stopped = true;
  private attempt = 0;
  private retryHandle: unknown = null;
  private status: RealtimeStatus = "closed";
  private readonly topics = new Map<
    string,
    { topic: RealtimeTopic; listeners: Set<LogListener> }
  >();
  private readonly options: Required<Omit<RealtimeClientOptions, OptionalCallback>> &
    Pick<RealtimeClientOptions, OptionalCallback>;

  /**
   * @param options - URL, callbacks, and injectable socket, timers and randomness.
   */
  constructor(options: RealtimeClientOptions) {
    this.options = {
      ...options,
      // NOTE: `??` rather than spreading defaults first: callers pass explicit
      // `undefined`s (an unset prop), which would otherwise replace the defaults.
      createSocket:
        options.createSocket ?? ((url) => new WebSocket(url) as unknown as RealtimeSocket),
      baseDelayMs: options.baseDelayMs ?? 500,
      maxDelayMs: options.maxDelayMs ?? 30_000,
      random: options.random ?? Math.random,
      timers: options.timers ?? {
        setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
        clearTimeout: (handle) =>
          globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
      },
    };
  }

  /** Current connection state. */
  get state(): RealtimeStatus {
    return this.status;
  }

  /** Opens the socket. Safe to call again after {@link close}. */
  connect(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.open();
  }

  /** Closes the socket for good and cancels any pending reconnect. */
  close(): void {
    this.stopped = true;
    this.cancelRetry();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onopen = null;
      socket.close(1000, "leaving project");
    }
    this.setStatus("closed");
  }

  /** Reconnects now instead of waiting out the backoff, e.g. when the browser goes online. */
  reconnectNow(): void {
    if (this.stopped || this.status === "open" || this.status === "connecting") return;
    this.cancelRetry();
    this.open();
  }

  /**
   * Subscribes to a log topic. The first listener sends `subscribe`; the last one to
   * leave sends `unsubscribe`. Subscriptions survive reconnects.
   *
   * @param topic - Deployment or build logs.
   * @param listener - Receives each `log.lines` message for the topic.
   * @returns Unsubscribe function.
   */
  subscribeLogs(topic: RealtimeTopic, listener: LogListener): () => void {
    const key = topicKey(topic);
    let entry = this.topics.get(key);
    if (!entry) {
      entry = { topic, listeners: new Set() };
      this.topics.set(key, entry);
      this.send({ type: "subscribe", topic });
    }
    entry.listeners.add(listener);
    return () => {
      const current = this.topics.get(key);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size === 0) {
        this.topics.delete(key);
        this.send({ type: "unsubscribe", topic });
      }
    };
  }

  private setStatus(status: RealtimeStatus) {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus?.(status);
  }

  private send(message: RealtimeClientMessage) {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(message));
  }

  private cancelRetry() {
    if (this.retryHandle !== null) this.options.timers.clearTimeout(this.retryHandle);
    this.retryHandle = null;
  }

  private open() {
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");
    this.opened = false;
    let socket: RealtimeSocket;
    try {
      socket = this.options.createSocket(this.options.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.opened = true;
      this.attempt = 0;
      this.setStatus("open");
      for (const { topic } of this.topics.values()) this.send({ type: "subscribe", topic });
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      const message = parseServerMessage(event.data);
      if (!message) return;
      if (message.type === "log.lines") {
        const entry = this.topics.get(logMessageTopicKey(message));
        for (const listener of entry?.listeners ?? []) listener(message);
      }
      this.options.onMessage(message);
    };
    socket.onerror = () => {};
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.stopped) return;
      if (!shouldReconnect(event.code)) {
        this.stopFor(event.code);
        return;
      }
      if (!this.opened && this.options.checkSession) {
        this.setStatus("reconnecting");
        void this.options.checkSession().then(
          (valid) => {
            if (this.stopped) return;
            if (valid) this.scheduleReconnect();
            else this.stopFor(REALTIME_CLOSE_CODES.unauthorized);
          },
          () => this.scheduleReconnect(),
        );
        return;
      }
      this.scheduleReconnect();
    };
  }

  /** Stops for good after a close code that would fail the same way on every retry. */
  private stopFor(code: number) {
    this.stopped = true;
    this.cancelRetry();
    switch (code) {
      case REALTIME_CLOSE_CODES.unauthorized:
        this.setStatus("expired");
        this.options.onSessionExpired?.();
        return;
      case REALTIME_CLOSE_CODES.forbidden:
        this.setStatus("forbidden");
        this.options.onUnavailable?.("forbidden");
        return;
      case REALTIME_CLOSE_CODES.notFound:
        this.setStatus("not_found");
        this.options.onUnavailable?.("not_found");
        return;
      default:
        // NOTE: 1008/1009 mean this client sent a frame the server refuses; resending the
        // same subscriptions after a reconnect would only repeat it.
        this.setStatus("closed");
    }
  }

  /**
   * Waits `min(max, base * 2^attempt)`, scaled by a random factor in `[0.5, 1)` so many
   * tabs reconnecting after an outage don't arrive in lockstep.
   */
  private scheduleReconnect() {
    if (this.stopped) return;
    this.setStatus("reconnecting");
    const { baseDelayMs, maxDelayMs, random, timers } = this.options;
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** this.attempt);
    const delay = Math.round(ceiling * (0.5 + random() * 0.5));
    this.attempt += 1;
    this.cancelRetry();
    this.retryHandle = timers.setTimeout(() => {
      this.retryHandle = null;
      if (!this.stopped) this.open();
    }, delay);
  }
}
