/**
 * Types for the Worker's bindings, shared with `cloudflare:test` so tests see
 * the same `env` shape as the app.
 *
 * @module
 */
import type { NodeConnection } from "./durable/node-connection";
import type { ProjectRoom } from "./durable/project-room";
import type { DeployParams } from "./workflows/deploy";

/** Worker bindings declared in `wrangler.jsonc`. */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  NODE_CONNECTION: DurableObjectNamespace<NodeConnection>;
  /** One `ProjectRoom` per project: the dashboard's realtime socket. */
  PROJECT_ROOM: DurableObjectNamespace<ProjectRoom>;
  /** Runs the deploy pipeline, one instance per deployment (instance ID = deployment ID). */
  DEPLOY_WORKFLOW: Workflow<DeployParams>;
  /** NDJSON log chunks, indexed by `log_chunks`. */
  LOGS: R2Bucket;
  /**
   * Per-IP limiter for secret-accepting endpoints and agent connects. Optional
   * so tooling without it still runs.
   */
  AUTH_LIMITER?: RateLimit;
  /** Per-IP limiter for the GitHub webhook receiver. Optional like `AUTH_LIMITER`. */
  WEBHOOK_LIMITER?: RateLimit;
  /** Optional: absent in local dev and tests. */
  METRICS?: AnalyticsEngineDataset;
  /** Base64 32-byte root secret. Missing until the operator sets it; setup refuses to run without it. */
  MASTER_KEY?: string;
  /**
   * Seconds a rollout waits for healthy replicas, overriding
   * `ROLLOUT_TIMEOUT_MS`. For development and tests (the end-to-end suite
   * sees a failing health check in a minute instead of ten); unset in
   * production. See `rolloutTimeoutMs`.
   */
  ROLLOUT_TIMEOUT_S?: string;
}

type AppBindings = Env;

declare global {
  namespace Cloudflare {
    // Lets `cloudflare:test`'s `env` export carry our binding types.
    interface Env extends AppBindings {}
  }
}
