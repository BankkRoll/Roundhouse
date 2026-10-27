/**
 * Roundhouse runtime Worker (ADR 0011, "Runtime Worker").
 *
 * The control plane uploads this file unchanged, as the main module of one
 * script per Cloudflare-provider service-environment. It is plain JavaScript
 * with no imports besides `cloudflare:workers`, because it ships as text and
 * is never bundled.
 *
 * Responsibilities:
 * - authenticate deploy warm-ups (`RH-Warm`, an HMAC over the generation and
 *   a timestamp), accept each header once and none after the generation
 *   answered healthy, and start instance 0 against the health path;
 * - answer `404 no route` for any hostname the service does not own, so the
 *   script's `workers.dev` address is not a second public entry point;
 * - spread requests over a fixed pool of `AppContainer` Durable Objects and
 *   strip every incoming `RH-*` header before the app sees it;
 * - start a container on demand with the environment the control plane
 *   resolves through the `CONTROL` service binding, and stop it after
 *   `sleep_after` of inactivity;
 * - write one Analytics Engine row per routed request.
 *
 * Bindings: `APP` (Durable Object namespace of {@link AppContainer}, with
 * the container attached), `CONTROL` (service binding to the control
 * plane's `RuntimeEnv` entrypoint), `RH_RUNTIME_TOKEN` (secret),
 * `RH_CONFIG` (JSON, see `RuntimeConfig` in `./index.ts`), `METRICS`
 * (Analytics Engine, dataset `roundhouse_metrics`).
 *
 * `edge_request` row layout (positions mirror `METRIC_BLOBS` of
 * `@roundhouse/shared` metrics-layout so blob4..blob6 filter the same way
 * as container rows; blob10 is a new slot that only edge rows use):
 * - `index1`: service_id
 * - `blob1` kind = "edge_request", `blob2` workspace_id = "", `blob3`
 *   project_id = "", `blob4` environment_id, `blob5` service_id, `blob6`
 *   deployment_id, `blob7` instance name ("i0".."i<max-1>"), `blob8`
 *   node_id = "", `blob9` source = "cloudflare", `blob10` status class
 *   ("1xx".."5xx")
 * - `double1` latency_ms (edge receipt to response headers), `double2`
 *   HTTP status
 *
 * Requests counted: every request that passed the host check and was sent
 * to the pool, including ones answered 502/503 by the runtime. Warm-ups and
 * `no route` answers are not counted. Count with `SUM(_sample_interval)`,
 * latency with `quantileExactWeighted(q)(double1, _sample_interval)`.
 *
 * SECURITY: console output becomes `system` log lines through the tail
 * consumer. Nothing here logs request bodies, headers, the runtime token or
 * any resolved environment value.
 *
 * @module
 */
import { DurableObject } from "cloudflare:workers";

/**
 * @typedef {object} RuntimeConfig
 * @property {string} service_id
 * @property {string} environment_id
 * @property {string} deployment_id
 * @property {number} generation
 * @property {number} port
 * @property {number} max_instances
 * @property {string} sleep_after
 * @property {string[]} hostnames
 * @property {string} health_path
 */

/**
 * @typedef {object} RuntimeBindings
 * @property {DurableObjectNamespace} APP
 * @property {{ resolveEnv(token: string): Promise<{ env: Record<string, string>; deployment_id: string }> }} CONTROL
 * @property {string} RH_RUNTIME_TOKEN
 * @property {string} RH_CONFIG
 * @property {{ writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void } | undefined} METRICS
 */

const WARM_HEADER = "rh-warm";
const WARM_WINDOW_MS = 300_000;
const DEFAULT_SLEEP_AFTER_MS = 10 * 60_000;
const PORT_WAIT_MS = 30_000;
const PORT_RETRY_START_MS = 100;
const PORT_RETRY_MAX_MS = 2_000;
const LOG = "rh-runtime:";

const encoder = new TextEncoder();

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

/** @type {{ raw: string; config: RuntimeConfig } | undefined} */
let cachedConfig;

/**
 * @param {string} raw
 * @returns {RuntimeConfig}
 */
function readConfig(raw) {
  if (cachedConfig?.raw === raw) return cachedConfig.config;
  const parsed = JSON.parse(raw);
  const port = Number(parsed.port);
  const max = Math.floor(Number(parsed.max_instances));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid port");
  if (!Array.isArray(parsed.hostnames)) throw new Error("invalid hostnames");
  /** @type {RuntimeConfig} */
  const config = {
    service_id: String(parsed.service_id ?? ""),
    environment_id: String(parsed.environment_id ?? ""),
    deployment_id: String(parsed.deployment_id ?? ""),
    generation: Number(parsed.generation),
    port,
    max_instances: Number.isFinite(max) && max >= 1 ? max : 1,
    sleep_after: String(parsed.sleep_after ?? "10m"),
    hostnames: parsed.hostnames.map((/** @type {unknown} */ h) => String(h).toLowerCase()),
    health_path:
      typeof parsed.health_path === "string" && parsed.health_path.startsWith("/")
        ? parsed.health_path
        : "/",
  };
  cachedConfig = { raw, config };
  return config;
}

/**
 * "10m", "90s", "1h30m", "1d" → milliseconds; anything else → 10 minutes.
 *
 * @param {string} value
 * @returns {number}
 */
function parseDuration(value) {
  const units = /** @type {Record<string, number>} */ ({ s: 1e3, m: 6e4, h: 36e5, d: 864e5 });
  const text = String(value).trim().toLowerCase();
  if (!/^(\d+[smhd])+$/.test(text)) return DEFAULT_SLEEP_AFTER_MS;
  let ms = 0;
  for (const [, n, unit] of text.matchAll(/(\d+)([smhd])/g)) ms += Number(n) * units[unit];
  return ms > 0 ? ms : DEFAULT_SLEEP_AFTER_MS;
}

// -----------------------------------------------------------------------------
// Warm-up authentication
// -----------------------------------------------------------------------------

/**
 * Checks `RH-Warm: <ts_ms>.<hex>` where hex = HMAC-SHA256(token,
 * `warm:<generation>:<ts_ms>`). Mirrors `warmHeaderValue` in `./warm.ts`.
 *
 * @param {string | null} header
 * @param {string} token
 * @param {number} generation
 * @param {number} nowMs
 * @returns {Promise<number | null>} The header's timestamp when it is
 *   authentic and inside the window. The caller still has to claim it
 *   (`AppContainer.claimWarm`), which is what makes it single-use.
 */
async function verifyWarmHeader(header, token, generation, nowMs) {
  if (!header || !token) return null;
  const match = /^(\d{1,16})\.([0-9a-f]{64})$/.exec(header.trim());
  if (!match) return null;
  const ts = Number(match[1]);
  if (!Number.isSafeInteger(ts) || Math.abs(nowMs - ts) > WARM_WINDOW_MS) return null;
  const hex = /** @type {string} */ (match[2]);
  const mac = new Uint8Array(32);
  for (let i = 0; i < 32; i++) mac[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  // SECURITY: subtle.verify compares in constant time; never compare hex strings with ===.
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    mac,
    encoder.encode(`warm:${generation}:${ts}`),
  );
  return ok ? ts : null;
}

// -----------------------------------------------------------------------------
// Edge
// -----------------------------------------------------------------------------

/**
 * @param {Headers} source
 * @returns {Headers}
 */
function withoutRuntimeHeaders(source) {
  const headers = new Headers(source);
  // SECURITY: RH-* is the runtime's namespace (warm-up today, edge gateway
  // auth later); a client must not be able to smuggle either to the app.
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith("rh-")) headers.delete(name);
  }
  return headers;
}

/**
 * @param {RuntimeBindings} env
 * @param {RuntimeConfig} config
 * @param {number} index
 * @param {number} status
 * @param {number} latencyMs
 */
function writeEdgeRow(env, config, index, status, latencyMs) {
  try {
    env.METRICS?.writeDataPoint({
      indexes: [config.service_id],
      blobs: [
        "edge_request",
        "",
        "",
        config.environment_id,
        config.service_id,
        config.deployment_id,
        `i${index}`,
        "",
        "cloudflare",
        `${Math.min(5, Math.max(1, Math.floor(status / 100)))}xx`,
      ],
      doubles: [latencyMs, status],
    });
  } catch (err) {
    console.log(LOG, "metrics write failed:", errorName(err));
  }
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errorName(err) {
  return err instanceof Error ? err.name : typeof err;
}

/**
 * Runs one claimed warm-up on instance 0 and, once the app answers 2xx,
 * closes warm-ups for the generation.
 *
 * @param {Request} req
 * @param {RuntimeBindings} env
 * @param {RuntimeConfig} config
 * @param {number} ts - The verified header's timestamp.
 * @returns {Promise<Response | null>} `null` when the header was used before
 *   or the generation is already warm; the caller then treats the request as
 *   an ordinary one.
 */
async function warmUp(req, env, config, ts) {
  const stub = /** @type {any} */ (env.APP.get(env.APP.idFromName("i0")));
  // SECURITY: ADR 0011 accepts a warm-up once per generation. The claim lives
  // in instance 0's storage, the one object every warm-up reaches, so a
  // captured header can't be replayed inside its window, and no header works
  // after the generation answered healthy.
  if (!(await stub.claimWarm(config.generation, ts))) return null;
  const url = new URL(config.health_path, req.url);
  try {
    const res = await stub.fetch(new Request(url, { method: "GET" }));
    await res.body?.cancel();
    if (res.ok) await stub.completeWarm(config.generation);
    return new Response(`warm ${res.status}`, { status: res.status });
  } catch (err) {
    console.log(LOG, "warm-up failed:", errorName(err));
    return new Response("warm-up failed", { status: 503 });
  }
}

export default {
  /**
   * @param {Request} req
   * @param {RuntimeBindings} env
   * @returns {Promise<Response>}
   */
  async fetch(req, env) {
    const started = Date.now();
    /** @type {RuntimeConfig} */
    let config;
    try {
      config = readConfig(env.RH_CONFIG);
    } catch {
      console.log(LOG, "RH_CONFIG is invalid");
      return new Response("runtime misconfigured", { status: 500 });
    }

    const warm = req.headers.get(WARM_HEADER);
    const warmTs = warm
      ? await verifyWarmHeader(warm, env.RH_RUNTIME_TOKEN, config.generation, started)
      : null;
    if (warmTs !== null) {
      const res = await warmUp(req, env, config, warmTs);
      if (res) return res;
    }

    if (!config.hostnames.includes(new URL(req.url).hostname.toLowerCase())) {
      return new Response("no route", { status: 404 });
    }

    const index = Math.min(
      config.max_instances - 1,
      Math.floor(Math.random() * config.max_instances),
    );
    const stub = env.APP.get(env.APP.idFromName(`i${index}`));
    /** @type {Response} */
    let res;
    try {
      res = await stub.fetch(new Request(req, { headers: withoutRuntimeHeaders(req.headers) }));
    } catch (err) {
      console.log(LOG, `instance i${index} failed:`, errorName(err));
      res = new Response("bad gateway", { status: 502 });
    }
    writeEdgeRow(env, config, index, res.status, Date.now() - started);
    return res;
  },
};

// -----------------------------------------------------------------------------
// Container Durable Object
// -----------------------------------------------------------------------------

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One pool slot: owns one container, starts it on demand with the resolved
 * environment, forwards requests to its port, and destroys it once idle for
 * `sleep_after`.
 */
export class AppContainer extends DurableObject {
  /**
   * @param {DurableObjectState} ctx
   * @param {RuntimeBindings} env
   */
  constructor(ctx, env) {
    super(ctx, env);
    /** @type {DurableObjectState} */
    this.ctx = ctx;
    /** @type {RuntimeBindings} */
    this.env = env;
    // NOTE: activity lives in memory only. After an eviction this restarts
    // the idle clock, which can only delay a stop, never cut a busy container.
    this.lastActivity = Date.now();
    this.inflight = 0;
    this.alarmScheduled = false;
    /** @type {Promise<boolean> | null} */
    this.starting = null;
  }

  /**
   * Claims a verified warm-up header: accepted only when its timestamp is
   * newer than every header claimed for the generation and the generation
   * hasn't answered healthy yet. The deploy workflow retries an unhealthy
   * warm-up with fresh headers, which this still allows.
   *
   * @param {number} generation
   * @param {number} ts
   * @returns {Promise<boolean>}
   */
  async claimWarm(generation, ts) {
    /** @type {{ generation: number; last_ts: number; done: boolean } | undefined} */
    const seen = await this.ctx.storage.get("warm");
    if (seen && seen.generation > generation) return false;
    if (seen && seen.generation === generation && (seen.done || ts <= seen.last_ts)) return false;
    await this.ctx.storage.put("warm", { generation, last_ts: ts, done: false });
    return true;
  }

  /**
   * Closes warm-ups for a generation after a healthy answer.
   *
   * @param {number} generation
   * @returns {Promise<void>}
   */
  async completeWarm(generation) {
    /** @type {{ generation: number; last_ts: number; done: boolean } | undefined} */
    const seen = await this.ctx.storage.get("warm");
    if (seen?.generation === generation)
      await this.ctx.storage.put("warm", { ...seen, done: true });
  }

  /**
   * @param {Request} req
   * @returns {Promise<Response>}
   */
  async fetch(req) {
    const container = this.ctx.container;
    if (!container) return new Response("container not attached", { status: 503 });
    const config = readConfig(this.env.RH_CONFIG);
    this.inflight++;
    this.lastActivity = Date.now();
    let release = true;
    try {
      await this.scheduleIdleCheck(config);
      if (!container.running) {
        this.starting ??= this.start(container, config).finally(() => {
          this.starting = null;
        });
        if (!(await this.starting)) return new Response("service unavailable", { status: 503 });
      }
      const res = await container.getTcpPort(config.port).fetch(req);
      if (!res.body) return res;
      release = false;
      return this.trackBody(res);
    } catch (err) {
      console.log(LOG, "forward failed:", errorName(err));
      return new Response("bad gateway", { status: 502 });
    } finally {
      if (release) this.done();
    }
  }

  /**
   * Keeps the slot busy until a streamed body ends or the client goes away,
   * so a long download or SSE stream is not cut by the idle alarm.
   *
   * @param {Response} res
   * @returns {Response}
   */
  trackBody(res) {
    const { readable, writable } = new TransformStream();
    /** @type {ReadableStream} */ (res.body).pipeTo(writable).then(
      () => this.done(),
      () => this.done(),
    );
    return new Response(readable, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }

  done() {
    this.inflight = Math.max(0, this.inflight - 1);
    this.lastActivity = Date.now();
  }

  /**
   * @param {RuntimeConfig} config
   */
  async scheduleIdleCheck(config) {
    if (this.alarmScheduled) return;
    const storage = this.ctx.storage;
    if ((await storage.getAlarm()) == null) {
      await storage.setAlarm(Date.now() + parseDuration(config.sleep_after));
    }
    this.alarmScheduled = true;
  }

  /**
   * @param {Container} container
   * @param {RuntimeConfig} config
   * @returns {Promise<boolean>}
   */
  async start(container, config) {
    /** @type {Record<string, string>} */
    let resolved;
    try {
      const result = await this.env.CONTROL.resolveEnv(this.env.RH_RUNTIME_TOKEN);
      resolved = result.env;
      console.log(LOG, `starting container for deployment ${result.deployment_id}`);
    } catch {
      // SECURITY: the rejection may describe the token; only the fact is logged.
      console.log(LOG, "environment refused (stale token or disabled runtime); not starting");
      return false;
    }
    const begun = Date.now();
    // SECURITY: the resolved environment goes straight into the container and
    // is not kept on `this`, in storage, or in any log line.
    container.start({ env: { ...resolved, PORT: String(config.port) }, enableInternet: true });
    container.monitor().then(
      () => console.log(LOG, "container exited"),
      (err) => console.log(LOG, "container exited with an error:", errorName(err)),
    );
    if (await this.waitForPort(container, config)) {
      console.log(LOG, `container ready after ${Date.now() - begun} ms`);
      return true;
    }
    console.log(LOG, `container did not accept connections on port ${config.port} in time`);
    await container.destroy().catch(() => {});
    return false;
  }

  /**
   * Polls the port with a GET of the health path until any HTTP answer
   * arrives, backing off from 100 ms to 2 s, for at most 30 s.
   *
   * @param {Container} container
   * @param {RuntimeConfig} config
   * @returns {Promise<boolean>}
   */
  async waitForPort(container, config) {
    const deadline = Date.now() + PORT_WAIT_MS;
    const url = `http://127.0.0.1:${config.port}${config.health_path}`;
    let delay = PORT_RETRY_START_MS;
    for (;;) {
      try {
        const res = await container.getTcpPort(config.port).fetch(url);
        await res.body?.cancel();
        return true;
      } catch {
        if (!container.running || Date.now() + delay > deadline) return false;
      }
      await sleep(delay);
      delay = Math.min(PORT_RETRY_MAX_MS, Math.round(delay * 1.5));
    }
  }

  async alarm() {
    this.alarmScheduled = false;
    const container = this.ctx.container;
    if (!container?.running) return;
    const config = readConfig(this.env.RH_CONFIG);
    const sleepMs = parseDuration(config.sleep_after);
    const idleMs = Date.now() - this.lastActivity;
    if (this.inflight > 0 || idleMs < sleepMs) {
      const next = this.inflight > 0 ? sleepMs : sleepMs - idleMs;
      await this.ctx.storage.setAlarm(Date.now() + next);
      this.alarmScheduled = true;
      return;
    }
    console.log(LOG, `idle for ${Math.round(idleMs / 1000)} s; stopping container`);
    await container.destroy();
  }
}
