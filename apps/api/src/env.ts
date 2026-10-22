/**
 * Types for the Worker's bindings, shared with `cloudflare:test` so tests see
 * the same `env` shape as the app.
 *
 * @module
 */
import type { NodeConnection } from "./durable/node-connection";

/** Worker bindings declared in `wrangler.jsonc`. */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  NODE_CONNECTION: DurableObjectNamespace<NodeConnection>;
  /**
   * Per-IP limiter for secret-accepting endpoints and agent connects. Optional
   * so tooling without it still runs.
   */
  AUTH_LIMITER?: RateLimit;
  /** Optional: absent in local dev and tests. */
  METRICS?: AnalyticsEngineDataset;
  /** Base64 32-byte root secret. Missing until the operator sets it; setup refuses to run without it. */
  MASTER_KEY?: string;
}

type AppBindings = Env;

declare global {
  namespace Cloudflare {
    // Lets `cloudflare:test`'s `env` export carry our binding types.
    interface Env extends AppBindings {}
  }
}
