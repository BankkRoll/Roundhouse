import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import runtime, { AppContainer } from "../src/cf-runtime/runtime.worker.js";
import {
  EDGE_REQUEST_BLOBS,
  EDGE_REQUEST_DOUBLES,
  RUNTIME_DO_CLASS,
  RUNTIME_WARM_HEADER,
  RUNTIME_WARM_WINDOW_MS,
  type RuntimeConfig,
  warmHeaderValue,
} from "../src/cf-runtime/warm";

const TOKEN = "rt-token-0123456789";
const SECRET = "s3cr3t-database-password";
const HOST = "app.example.com";

const CONFIG: RuntimeConfig = {
  service_id: "svc_1",
  environment_id: "env_1",
  deployment_id: "dep_1",
  generation: 3,
  port: 8080,
  max_instances: 4,
  sleep_after: "10m",
  hostnames: [HOST],
  health_path: "/healthz",
};

interface FakeContainer {
  running: boolean;
  start: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  monitor: ReturnType<typeof vi.fn>;
  signal: ReturnType<typeof vi.fn>;
  getTcpPort: ReturnType<typeof vi.fn>;
  /** Port fetches that fail before the app "listens". */
  refuse: number;
  /** Requests the app received (probes excluded). */
  received: Request[];
  app: (req: Request) => Response | Promise<Response>;
}

function fakeContainer(): FakeContainer {
  const c: FakeContainer = {
    running: false,
    start: vi.fn(() => {
      c.running = true;
    }),
    destroy: vi.fn(async () => {
      c.running = false;
    }),
    monitor: vi.fn(() => new Promise(() => {})),
    signal: vi.fn(),
    refuse: 0,
    received: [],
    app: () => new Response("hello"),
    getTcpPort: vi.fn(() => ({
      fetch: async (input: Request | string) => {
        if (!c.running) throw new Error("container not running");
        if (c.refuse > 0) {
          c.refuse--;
          throw new Error("connection refused");
        }
        if (typeof input === "string") return new Response("probe");
        c.received.push(input);
        return c.app(input);
      },
    })),
  };
  return c;
}

function harness(config: Partial<RuntimeConfig> = {}) {
  const containers = new Map<string, FakeContainer>();
  const objects = new Map<string, InstanceType<typeof AppContainer>>();
  const alarms = new Map<string, number | null>();
  const stored = new Map<string, Map<string, unknown>>();
  const env = {
    RH_RUNTIME_TOKEN: TOKEN,
    RH_CONFIG: JSON.stringify({ ...CONFIG, ...config }),
    CONTROL: {
      resolveEnv: vi.fn(async (_token: string) => ({
        env: { DATABASE_URL: SECRET, PORT: "1" },
        deployment_id: "dep_1",
      })),
    },
    METRICS: { writeDataPoint: vi.fn() },
    APP: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn((id: string) => ({
        fetch: (req: Request) => object(id).fetch(req),
        claimWarm: (generation: number, ts: number) => object(id).claimWarm(generation, ts),
        completeWarm: (generation: number) => object(id).completeWarm(generation),
      })),
    },
  };
  function container(name: string): FakeContainer {
    let c = containers.get(name);
    if (!c) {
      c = fakeContainer();
      containers.set(name, c);
    }
    return c;
  }
  function object(name: string) {
    let o = objects.get(name);
    if (!o) {
      const ctx = {
        container: container(name),
        storage: {
          get: vi.fn(async (key: string) => stored.get(name)?.get(key)),
          put: vi.fn(async (key: string, value: unknown) => {
            if (!stored.has(name)) stored.set(name, new Map());
            stored.get(name)!.set(key, value);
          }),
          getAlarm: vi.fn(async () => alarms.get(name) ?? null),
          setAlarm: vi.fn(async (at: number) => {
            alarms.set(name, at);
          }),
        },
      };
      o = new AppContainer(ctx, env);
      objects.set(name, o);
    }
    return o!;
  }
  return { env, container, object, alarms };
}

const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runtime source", () => {
  it("is self-contained and exports the Durable Object class the control plane names", () => {
    const source = readFileSync(new URL("../src/cf-runtime/runtime.worker.js", import.meta.url), {
      encoding: "utf8",
    });
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["cloudflare:workers"]);
    expect(source).toContain(`export class ${RUNTIME_DO_CLASS} extends DurableObject`);
    expect(AppContainer.name).toBe(RUNTIME_DO_CLASS);
  });
});

describe("routing", () => {
  it("answers 404 no route for a hostname the service does not own", async () => {
    const h = harness();
    const res = await runtime.fetch(req("https://other.example.com/"), h.env);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("no route");
    expect(h.env.APP.get).not.toHaveBeenCalled();
  });

  it("answers 404 on workers.dev without a warm header", async () => {
    const h = harness();
    const res = await runtime.fetch(req("https://rh-abc.acct.workers.dev/healthz"), h.env);
    expect(res.status).toBe(404);
    expect(h.env.METRICS.writeDataPoint).not.toHaveBeenCalled();
  });

  it("matches hostnames case-insensitively", async () => {
    const h = harness();
    const res = await runtime.fetch(req("https://APP.Example.com/"), h.env);
    expect(res.status).toBe(200);
  });

  it("picks a pool index within [0, max_instances)", async () => {
    const h = harness();
    for (const [r, name] of [
      [0, "i0"],
      [0.5, "i2"],
      [0.999999, "i3"],
    ] as const) {
      vi.spyOn(Math, "random").mockReturnValue(r);
      await runtime.fetch(req(`https://${HOST}/`), h.env);
      expect(h.env.APP.idFromName).toHaveBeenLastCalledWith(name);
    }
  });

  it("strips RH-* headers before the app sees the request", async () => {
    const h = harness({ max_instances: 1 });
    const warm = await warmHeaderValue("wrong-token", CONFIG.generation, Date.now());
    await runtime.fetch(
      req(`https://${HOST}/x`, {
        [RUNTIME_WARM_HEADER]: warm,
        "RH-Auth": "forged",
        "rh-target": "db.internal:5432",
        "X-Keep": "yes",
      }),
      h.env,
    );
    const seen = h.container("i0").received[0]!;
    expect(seen.headers.get("x-keep")).toBe("yes");
    expect([...seen.headers.keys()].filter((k) => k.startsWith("rh-"))).toEqual([]);
  });
});

describe("warm-up", () => {
  it("accepts warmHeaderValue, starts instance 0 and returns the health status", async () => {
    const h = harness();
    h.container("i0").app = (r) =>
      new Response("ok", { status: new URL(r.url).pathname === "/healthz" ? 200 : 500 });
    const res = await runtime.fetch(
      req("https://rh-abc.acct.workers.dev/", {
        [RUNTIME_WARM_HEADER]: await warmHeaderValue(TOKEN, CONFIG.generation, Date.now()),
      }),
      h.env,
    );
    expect(res.status).toBe(200);
    expect(h.env.APP.idFromName).toHaveBeenCalledWith("i0");
    expect(h.container("i0").start).toHaveBeenCalledOnce();
    expect(new URL(h.container("i0").received[0]!.url).pathname).toBe("/healthz");
    expect(h.env.METRICS.writeDataPoint).not.toHaveBeenCalled();
  });

  it("accepts each header once, and none after the generation answered healthy", async () => {
    const h = harness();
    const header = await warmHeaderValue(TOKEN, CONFIG.generation, Date.now());
    const warmReq = () =>
      req("https://rh-abc.acct.workers.dev/", { [RUNTIME_WARM_HEADER]: header });
    expect((await runtime.fetch(warmReq(), h.env)).status).toBe(200);
    // A replay inside the window falls through to the host check.
    expect((await runtime.fetch(warmReq(), h.env)).status).toBe(404);
    const fresh = await warmHeaderValue(TOKEN, CONFIG.generation, Date.now() + 1);
    const again = await runtime.fetch(
      req("https://rh-abc.acct.workers.dev/", { [RUNTIME_WARM_HEADER]: fresh }),
      h.env,
    );
    expect(again.status).toBe(404);
    expect(h.container("i0").received).toHaveLength(1);
  });

  it("lets the workflow retry an unhealthy warm-up with a newer header only", async () => {
    const h = harness();
    let healthy = false;
    h.container("i0").app = () => new Response("", { status: healthy ? 200 : 503 });
    const t0 = Date.now();
    const first = await warmHeaderValue(TOKEN, CONFIG.generation, t0);
    const send = (value: string) =>
      runtime.fetch(
        req("https://rh-abc.acct.workers.dev/", { [RUNTIME_WARM_HEADER]: value }),
        h.env,
      );
    expect((await send(first)).status).toBe(503);
    healthy = true;
    expect((await send(first)).status).toBe(404);
    expect((await send(await warmHeaderValue(TOKEN, CONFIG.generation, t0 - 1))).status).toBe(404);
    expect((await send(await warmHeaderValue(TOKEN, CONFIG.generation, t0 + 1))).status).toBe(200);
  });

  it("passes an unhealthy status through", async () => {
    const h = harness();
    h.container("i0").app = () => new Response("down", { status: 503 });
    const res = await runtime.fetch(
      req("https://rh-abc.acct.workers.dev/", {
        [RUNTIME_WARM_HEADER]: await warmHeaderValue(TOKEN, CONFIG.generation, Date.now()),
      }),
      h.env,
    );
    expect(res.status).toBe(503);
  });

  it("accepts timestamps inside the window either way", async () => {
    for (const skew of [-RUNTIME_WARM_WINDOW_MS + 5_000, RUNTIME_WARM_WINDOW_MS - 5_000]) {
      const h = harness();
      const value = await warmHeaderValue(TOKEN, CONFIG.generation, Date.now() + skew);
      const res = await runtime.fetch(
        req("https://rh-abc.acct.workers.dev/", { [RUNTIME_WARM_HEADER]: value }),
        h.env,
      );
      expect(res.status).toBe(200);
    }
  });

  it.each([
    ["expired", () => warmHeaderValue(TOKEN, CONFIG.generation, Date.now() - 301_000)],
    ["from the future", () => warmHeaderValue(TOKEN, CONFIG.generation, Date.now() + 301_000)],
    ["signed with another token", () => warmHeaderValue("other", CONFIG.generation, Date.now())],
    ["for another generation", () => warmHeaderValue(TOKEN, CONFIG.generation - 1, Date.now())],
    [
      "with a tampered timestamp",
      async () => {
        const [ts, mac] = (await warmHeaderValue(TOKEN, CONFIG.generation, Date.now())).split(".");
        return `${Number(ts) + 1}.${mac}`;
      },
    ],
    ["malformed", async () => "not-a-warm-header"],
  ])("rejects a warm header %s and treats the request as normal", async (_name, make) => {
    const h = harness();
    const res = await runtime.fetch(
      req("https://rh-abc.acct.workers.dev/", { [RUNTIME_WARM_HEADER]: await make() }),
      h.env,
    );
    expect(res.status).toBe(404);
    expect(h.env.APP.get).not.toHaveBeenCalled();
  });
});

describe("AppContainer", () => {
  it("cold start resolves the env once, starts with env + PORT, waits for the port, forwards", async () => {
    const h = harness({ max_instances: 1 });
    const c = h.container("i0");
    c.refuse = 2;
    const [a, b] = await Promise.all([
      runtime.fetch(req(`https://${HOST}/a`), h.env),
      runtime.fetch(req(`https://${HOST}/b`), h.env),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.text()).toBe("hello");
    expect(h.env.CONTROL.resolveEnv).toHaveBeenCalledOnce();
    expect(h.env.CONTROL.resolveEnv).toHaveBeenCalledWith(TOKEN);
    expect(c.start).toHaveBeenCalledOnce();
    expect(c.start).toHaveBeenCalledWith({
      env: { DATABASE_URL: SECRET, PORT: "8080" },
      enableInternet: true,
    });
    expect(c.getTcpPort).toHaveBeenCalledWith(8080);
    expect(c.received.map((r) => new URL(r.url).pathname).sort()).toEqual(["/a", "/b"]);

    await runtime.fetch(req(`https://${HOST}/c`), h.env);
    expect(h.env.CONTROL.resolveEnv).toHaveBeenCalledOnce();
    expect(c.start).toHaveBeenCalledOnce();
  });

  it("answers 503 without starting when the token is stale", async () => {
    const h = harness({ max_instances: 1 });
    h.env.CONTROL.resolveEnv.mockRejectedValue(new Error(`stale token ${TOKEN}`));
    const res = await runtime.fetch(req(`https://${HOST}/`), h.env);
    expect(res.status).toBe(503);
    expect(h.container("i0").start).not.toHaveBeenCalled();
  });

  it("schedules an idle check and destroys an idle container after sleep_after", async () => {
    const h = harness({ max_instances: 1, sleep_after: "2m" });
    const t0 = Date.now();
    await (await runtime.fetch(req(`https://${HOST}/`), h.env)).text();
    const at = h.alarms.get("i0")!;
    expect(at - t0).toBeGreaterThanOrEqual(120_000);
    expect(at - t0).toBeLessThan(125_000);

    vi.spyOn(Date, "now").mockReturnValue(t0 + 60_000);
    await h.object("i0").alarm();
    expect(h.container("i0").destroy).not.toHaveBeenCalled();
    expect(h.alarms.get("i0")!).toBeGreaterThan(t0 + 60_000);

    vi.spyOn(Date, "now").mockReturnValue(t0 + 121_000);
    await h.object("i0").alarm();
    expect(h.container("i0").destroy).toHaveBeenCalledOnce();
    expect(h.container("i0").running).toBe(false);
  });

  it("keeps a container with a response still streaming", async () => {
    const h = harness({ max_instances: 1, sleep_after: "1m" });
    h.container("i0").app = () =>
      new Response(new ReadableStream({ start: (ctl) => ctl.enqueue(new Uint8Array([1])) }));
    const t0 = Date.now();
    const res = await runtime.fetch(req(`https://${HOST}/stream`), h.env);
    expect(res.status).toBe(200);

    vi.spyOn(Date, "now").mockReturnValue(t0 + 10 * 60_000);
    await h.object("i0").alarm();
    expect(h.container("i0").destroy).not.toHaveBeenCalled();
    expect(h.alarms.get("i0")!).toBe(t0 + 11 * 60_000);
    await res.body!.cancel();
  });

  it("restarts after an idle stop with a fresh resolveEnv", async () => {
    const h = harness({ max_instances: 1, sleep_after: "1m" });
    await (await runtime.fetch(req(`https://${HOST}/`), h.env)).text();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    await h.object("i0").alarm();
    vi.mocked(Date.now).mockRestore();
    const res = await runtime.fetch(req(`https://${HOST}/`), h.env);
    expect(res.status).toBe(200);
    expect(h.env.CONTROL.resolveEnv).toHaveBeenCalledTimes(2);
    expect(h.container("i0").start).toHaveBeenCalledTimes(2);
  });
});

describe("metrics", () => {
  it("writes one edge_request row in the documented layout", async () => {
    const h = harness();
    vi.spyOn(Math, "random").mockReturnValue(0.3);
    h.container("i1").app = () => new Response("nope", { status: 404 });
    const res = await runtime.fetch(req(`https://${HOST}/missing`), h.env);
    expect(res.status).toBe(404);
    expect(h.env.METRICS.writeDataPoint).toHaveBeenCalledOnce();
    const point = h.env.METRICS.writeDataPoint.mock.calls[0]![0];
    expect(point.indexes).toEqual(["svc_1"]);
    expect(point.blobs).toHaveLength(EDGE_REQUEST_BLOBS.length);
    expect(Object.fromEntries(EDGE_REQUEST_BLOBS.map((n, i) => [n, point.blobs[i]]))).toEqual({
      kind: "edge_request",
      workspace_id: "",
      project_id: "",
      environment_id: "env_1",
      service_id: "svc_1",
      deployment_id: "dep_1",
      instance: "i1",
      node_id: "",
      source: "cloudflare",
      status_class: "4xx",
    });
    expect(point.doubles).toHaveLength(EDGE_REQUEST_DOUBLES.length);
    expect(point.doubles[0]).toBeGreaterThanOrEqual(0);
    expect(point.doubles[1]).toBe(404);
  });

  it("records a refused start as a 5xx", async () => {
    const h = harness({ max_instances: 1 });
    h.env.CONTROL.resolveEnv.mockRejectedValue(new Error("stale"));
    await runtime.fetch(req(`https://${HOST}/`), h.env);
    expect(h.env.METRICS.writeDataPoint.mock.calls[0]![0].blobs[9]).toBe("5xx");
  });

  it("never fails the request when the metrics write throws", async () => {
    const h = harness();
    h.env.METRICS.writeDataPoint.mockImplementation(() => {
      throw new Error("dataset unavailable");
    });
    const res = await runtime.fetch(req(`https://${HOST}/`), h.env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });
});

describe("logging", () => {
  it("never prints the token or resolved env values", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const h = harness({ max_instances: 1, sleep_after: "1m" });
    h.container("i0").refuse = 1;
    await (await runtime.fetch(req(`https://${HOST}/`), h.env)).text();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    await h.object("i0").alarm();
    vi.mocked(Date.now).mockRestore();
    h.env.CONTROL.resolveEnv.mockRejectedValue(new Error(`stale token ${TOKEN}`));
    await runtime.fetch(req(`https://${HOST}/`), h.env);

    const printed = spies.flatMap((s) => s.mock.calls.flat().map(String)).join("\n");
    expect(printed).toContain("rh-runtime:");
    expect(printed).not.toContain(SECRET);
    expect(printed).not.toContain(TOKEN);
  });
});
