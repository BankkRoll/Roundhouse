import { REALTIME_CLOSE_CODES } from "@roundhouse/shared";
import { describe, expect, it, vi } from "vitest";
import {
  parseServerMessage,
  RealtimeClient,
  type RealtimeSocket,
  type RealtimeStatus,
  realtimeUrl,
} from "./client";

/** A WebSocket double the test drives by hand. */
class FakeSocket implements RealtimeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  closedWith: number | undefined;
  onopen: RealtimeSocket["onopen"] = null;
  onclose: RealtimeSocket["onclose"] = null;
  onmessage: RealtimeSocket["onmessage"] = null;
  onerror: RealtimeSocket["onerror"] = null;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closedWith = code;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function setup(options: { checkSession?: () => Promise<boolean> } = {}) {
  FakeSocket.all = [];
  const timers: { ms: number; run: () => void }[] = [];
  const statuses: RealtimeStatus[] = [];
  const onMessage = vi.fn();
  const onSessionExpired = vi.fn();
  const onUnavailable = vi.fn();
  const client = new RealtimeClient({
    url: "ws://localhost/v1/projects/prj_1/realtime",
    onMessage,
    onStatus: (status) => statuses.push(status),
    onSessionExpired,
    onUnavailable,
    checkSession: options.checkSession,
    createSocket: (url) => new FakeSocket(url),
    // The top of the jitter range, so delays equal the backoff ceiling.
    random: () => 1,
    timers: {
      setTimeout: (run, ms) => {
        const timer = { ms, run };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        const index = timers.indexOf(timer as (typeof timers)[number]);
        if (index !== -1) timers.splice(index, 1);
      },
    },
  });
  const socket = () => FakeSocket.all.at(-1) as FakeSocket;
  const fire = () => timers.shift()?.run();
  return { client, timers, statuses, onMessage, onSessionExpired, onUnavailable, socket, fire };
}

const topic = { kind: "deployment_logs", deployment_id: "dep_1" } as const;

describe("RealtimeClient", () => {
  it("connects once and reports status", () => {
    const { client, socket, statuses } = setup();
    client.connect();
    client.connect();
    expect(FakeSocket.all).toHaveLength(1);
    socket().open();
    expect(statuses).toEqual(["connecting", "open"]);
  });

  it("reconnects with capped exponential backoff, resetting after a successful open", () => {
    const { client, socket, timers, fire } = setup();
    client.connect();
    socket().open();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      socket().drop();
      delays.push(timers[0]?.ms ?? -1);
      fire();
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    socket().open();
    socket().drop();
    expect(timers[0]?.ms).toBe(500);
  });

  it("adds jitter so many tabs don't reconnect in lockstep", () => {
    const delays: number[] = [];
    const client = new RealtimeClient({
      url: "ws://x",
      onMessage: () => {},
      createSocket: (url) => new FakeSocket(url),
      random: () => 0,
      timers: {
        setTimeout: (_run, ms) => delays.push(ms),
        clearTimeout: () => {},
      },
    });
    client.connect();
    FakeSocket.all.at(-1)?.open();
    FakeSocket.all.at(-1)?.drop();
    expect(delays).toEqual([250]);
  });

  it("subscribes once per topic, resubscribes after reconnecting, and unsubscribes last", () => {
    const { client, socket, fire } = setup();
    client.connect();
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = client.subscribeLogs(topic, first);
    const stopSecond = client.subscribeLogs(topic, second);
    socket().open();
    expect(socket().sent).toEqual([{ type: "subscribe", topic }]);

    socket().drop();
    fire();
    socket().open();
    expect(socket().sent).toEqual([{ type: "subscribe", topic }]);

    socket().receive({
      type: "log.lines",
      source: { type: "runtime", service_id: "s", deployment_id: "dep_1", workload_id: "w" },
      lines: [{ ts: 1, stream: "stdout", text: "hi" }],
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    stopFirst();
    expect(socket().sent).toHaveLength(1);
    stopSecond();
    expect(socket().sent.at(-1)).toEqual({ type: "unsubscribe", topic });
  });

  it("routes log lines only to their topic", () => {
    const { client, socket } = setup();
    client.connect();
    socket().open();
    const listener = vi.fn();
    client.subscribeLogs({ kind: "build_logs", build_id: "bld_1" }, listener);
    socket().receive({
      type: "log.lines",
      source: { type: "runtime", service_id: "s", deployment_id: "dep_9", workload_id: "w" },
      lines: [],
    });
    expect(listener).not.toHaveBeenCalled();
    socket().receive({
      type: "log.lines",
      source: { type: "build", service_id: "s", build_id: "bld_1" },
      lines: [],
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("passes valid messages on and ignores malformed ones", () => {
    const { client, socket, onMessage } = setup();
    client.connect();
    socket().open();
    socket().onmessage?.({ data: "not json" });
    socket().receive({ type: "unknown.kind" });
    socket().receive({ type: "deployment.updated" });
    socket().receive({ type: "presence", users: [] });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ type: "presence", users: [] });
  });

  it("checks the session when the upgrade is refused, and stops when it has expired", async () => {
    const checkSession = vi.fn().mockResolvedValue(false);
    const { client, socket, timers, onSessionExpired, statuses } = setup({ checkSession });
    client.connect();
    socket().drop();
    await vi.waitFor(() => expect(onSessionExpired).toHaveBeenCalledTimes(1));
    expect(statuses.at(-1)).toBe("expired");
    expect(timers).toHaveLength(0);
  });

  it("keeps reconnecting when the session is fine", async () => {
    const checkSession = vi.fn().mockResolvedValue(true);
    const { client, socket, timers, onSessionExpired } = setup({ checkSession });
    client.connect();
    socket().open();
    socket().drop(1006);
    expect(checkSession).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);
    timers.shift()?.run();
    socket().drop(1006);
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    expect(checkSession).toHaveBeenCalledTimes(1);
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it("stops at once and reports an expired session when the server closes with 4401", () => {
    const checkSession = vi.fn().mockResolvedValue(true);
    const { client, socket, timers, onSessionExpired, statuses } = setup({ checkSession });
    client.connect();
    socket().open();
    socket().drop(REALTIME_CLOSE_CODES.unauthorized);
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(checkSession).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toBe("expired");
    expect(timers).toHaveLength(0);
    client.reconnectNow();
    expect(FakeSocket.all).toHaveLength(1);
  });

  it.each([
    [REALTIME_CLOSE_CODES.forbidden, "forbidden"],
    [REALTIME_CLOSE_CODES.notFound, "not_found"],
  ] as const)("stops quietly after %i (%s)", (code, reason) => {
    const { client, socket, timers, onUnavailable, onSessionExpired, statuses } = setup();
    client.connect();
    socket().open();
    socket().drop(code);
    expect(onUnavailable).toHaveBeenCalledWith(reason);
    expect(onSessionExpired).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toBe(reason);
    expect(timers).toHaveLength(0);
  });

  it("doesn't retry after a policy close, which would only repeat", () => {
    const { client, socket, timers, statuses } = setup();
    client.connect();
    socket().open();
    socket().drop(REALTIME_CLOSE_CODES.policy);
    expect(timers).toHaveLength(0);
    expect(statuses.at(-1)).toBe("closed");
  });

  it("closes cleanly without reconnecting", () => {
    const { client, socket, timers } = setup();
    client.connect();
    socket().open();
    const current = socket();
    client.close();
    expect(current.closedWith).toBe(1000);
    expect(timers).toHaveLength(0);
    expect(client.state).toBe("closed");
  });

  it("coalesces presence updates, keeps the latest, and sends it again after a reconnect", () => {
    const { client, socket, timers, fire } = setup();
    client.connect();
    socket().open();
    const first = { environment_id: "env_1", selection: ["svc_1"], editing: null };
    const latest = {
      environment_id: "env_1",
      selection: ["svc_2"],
      editing: { service_id: "svc_2", part: "variables" as const },
    };
    client.updatePresence(first);
    client.updatePresence(latest);
    expect(timers).toHaveLength(1);
    fire();
    expect(socket().sent).toEqual([{ type: "presence.update", ...latest }]);

    socket().drop();
    fire();
    socket().open();
    expect(socket().sent).toEqual([{ type: "presence.update", ...latest }]);
  });

  it("passes change set and canvas frames on", () => {
    const { client, socket, onMessage } = setup();
    client.connect();
    socket().open();
    socket().receive({ type: "canvas.edges_updated", by_user_id: "usr_1" });
    socket().receive({
      type: "change_set.applied",
      change_set_id: "chs_1",
      environment_id: "env_1",
      deployment_ids: [],
    });
    socket().receive({ type: "change_set.updated", change_set: "nope" });
    expect(onMessage.mock.calls.map(([m]) => m.type)).toEqual([
      "canvas.edges_updated",
      "change_set.applied",
    ]);
  });
});

describe("helpers", () => {
  it("builds ws and wss URLs from the page origin", () => {
    expect(realtimeUrl("prj 1", "http://localhost:5173")).toBe(
      "ws://localhost:5173/v1/projects/prj%201/realtime",
    );
    expect(realtimeUrl("prj_1", "https://cp.example.com")).toBe(
      "wss://cp.example.com/v1/projects/prj_1/realtime",
    );
  });

  it("rejects non-string frames", () => {
    expect(parseServerMessage(new ArrayBuffer(2))).toBeNull();
  });
});
