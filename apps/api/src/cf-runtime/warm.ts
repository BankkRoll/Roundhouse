/**
 * The contract between the control plane and the runtime Worker
 * (`runtime.worker.js`) that does not depend on the runtime's source text,
 * so Node tests can import it without the Text-module loader.
 *
 * Responsibilities:
 * - names the runtime script's main module, Durable Object class and bindings;
 * - the `RH_CONFIG` shape and the `resolveEnv` result;
 * - the `RH-Warm` header the deploy workflow sends, which the runtime checks
 *   with an identical HMAC of its own;
 * - the `edge_request` Analytics Engine row layout the runtime writes.
 *
 * @module
 */

/** Module name of the runtime source in the script upload's `metadata.main_module`. */
export const RUNTIME_MAIN_MODULE = "runtime.worker.js";

/** Durable Object class the container application is attached to. */
export const RUNTIME_DO_CLASS = "AppContainer";

/** Binding names the runtime reads from its `env`. */
export const RUNTIME_BINDINGS = {
  /** Durable Object namespace of {@link RUNTIME_DO_CLASS}. */
  app: "APP",
  /** Service binding to the control plane's `RuntimeEnv` entrypoint. */
  control: "CONTROL",
  /** `secret_text`: the per-generation runtime token. */
  token: "RH_RUNTIME_TOKEN",
  /** `plain_text`: JSON {@link RuntimeConfig}. */
  config: "RH_CONFIG",
  /** Analytics Engine dataset `roundhouse_metrics`. */
  metrics: "METRICS",
} as const;

/** Header carrying a deploy warm-up's proof, `<ts_ms>.<hex HMAC>`. */
export const RUNTIME_WARM_HEADER = "RH-Warm";

/** How far a warm-up timestamp may be from the runtime's clock, either way. */
export const RUNTIME_WARM_WINDOW_MS = 300_000;

/** `RH_CONFIG`: everything the generic runtime knows about its service-environment. */
export interface RuntimeConfig {
  service_id: string;
  environment_id: string;
  deployment_id: string;
  /** Bumped on every Cloudflare deploy and on disable; part of the warm-up HMAC. */
  generation: number;
  /** Container port the app listens on; also passed to it as `PORT`. */
  port: number;
  /** Pool size: requests go to instance `i0`..`i<max_instances-1>` at random. */
  max_instances: number;
  /** Idle time before a container is stopped: `"90s"`, `"10m"`, `"1h30m"`. */
  sleep_after: string;
  /** Hostnames the runtime serves; anything else gets `404 no route`. */
  hostnames: string[];
  /** Path the warm-up and the port wait request; must start with `/`. */
  health_path: string;
}

/** What `CONTROL.resolveEnv(token)` returns. */
export interface RuntimeEnvResolution {
  /** The deployment's resolved variables; they live only in the container. */
  env: Record<string, string>;
  deployment_id: string;
}

/** `kind` (`blob1`) of the runtime's Analytics Engine rows. */
export const EDGE_REQUEST_KIND = "edge_request";

/**
 * Blob columns of an `edge_request` row, in order. The first nine mirror
 * `METRIC_BLOBS` of `@roundhouse/shared`, empty where the runtime has no
 * value; `status_class` (`"2xx"`) is `blob10`. `index1` is the service ID.
 */
export const EDGE_REQUEST_BLOBS = [
  "kind",
  "workspace_id",
  "project_id",
  "environment_id",
  "service_id",
  "deployment_id",
  "instance",
  "node_id",
  "source",
  "status_class",
] as const;

/** Double columns of an `edge_request` row, in order. */
export const EDGE_REQUEST_DOUBLES = ["latency_ms", "status"] as const;

const encoder = new TextEncoder();

/**
 * The `RH-Warm` header value for a warm-up at `nowMs`.
 *
 * @param token - The script's `RH_RUNTIME_TOKEN`, as uploaded.
 * @param generation - `RH_CONFIG.generation` of the same upload.
 * @param nowMs - Current Unix time, ms; the runtime accepts it for ±{@link RUNTIME_WARM_WINDOW_MS}.
 * @returns `<ts_ms>.<hex HMAC-SHA256(token, "warm:<generation>:<ts_ms>")>`.
 * @example
 * await fetch(`https://${script}.${subdomain}${healthPath}`, {
 *   headers: { [RUNTIME_WARM_HEADER]: await warmHeaderValue(token, 3, Date.now()) },
 * });
 */
export async function warmHeaderValue(
  token: string,
  generation: number,
  nowMs: number,
): Promise<string> {
  const ts = Math.floor(nowMs);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(token),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`warm:${generation}:${ts}`)),
  );
  return `${ts}.${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
