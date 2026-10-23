/**
 * Types for the Worker's bindings, shared with `cloudflare:test` so tests see
 * the same `env` shape as the app.
 *
 * @module
 */
import type { AuditChain } from "./durable/audit-chain";
import type { NodeConnection } from "./durable/node-connection";
import type { ProjectRoom } from "./durable/project-room";
import type { BackupParams } from "./workflows/backup";
import type { DeployParams } from "./workflows/deploy";
import type { KeyRotationParams } from "./workflows/key-rotation";
import type { ProvisionParams } from "./workflows/provision";
import type { VolumeMigrationParams } from "./lib/volume-migrations";
import type { RestoreParams } from "./workflows/restore";

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
  /** Per-token limiter for MCP tool calls (60 a minute, ADR 0012). Optional like `AUTH_LIMITER`. */
  MCP_LIMITER?: RateLimit;
  /**
   * The `roundhouse_metrics` dataset (ADR 0008). Optional: `wrangler dev`
   * stubs it and tests run without it.
   */
  METRICS?: AnalyticsEngineDataset;
  /** Cloudflare account ID, for the Analytics Engine SQL API. Set by the deploy script. */
  CF_ACCOUNT_ID?: string;
  /**
   * API token with "Account Analytics Read" (secret), for the Analytics
   * Engine SQL API. Without it (or `CF_ACCOUNT_ID`) metrics fall back to D1.
   */
  CF_ANALYTICS_TOKEN?: string;
  /**
   * `d1` forces the short-retention D1 store (development, tests, e2e);
   * `analytics_engine` refuses to fall back. Unset picks Analytics Engine
   * when its credentials are present, D1 otherwise.
   */
  METRICS_BACKEND?: string;
  /**
   * Overrides the 15 s agent sampling interval, in ms. For development and
   * the end-to-end suite; unset in production.
   */
  METRICS_INTERVAL_MS?: string;
  /** Base64 32-byte root secret. Missing until the operator sets it; setup refuses to run without it. */
  MASTER_KEY?: string;
  /**
   * Comma-separated base64 master keys that came before `MASTER_KEY`, newest
   * first. Still used to read values sealed under them until the key rotation
   * workflow has moved everything to `MASTER_KEY` (ADR 0014 "Crypto").
   */
  MASTER_KEYS_PREVIOUS?: string;
  /**
   * The control plane's public origin, e.g. `https://cp.example.com`. Every
   * absolute URL is built from it, never from the request's `Host` (ADR 0014).
   */
  PUBLIC_ORIGIN?: string;
  /** `"1"` in local development: relaxes `PUBLIC_ORIGIN` and lets agents use `ws://`. */
  ROUNDHOUSE_DEV?: string;
  /** The single `AuditChain` Durable Object (`idFromName("global")`). */
  AUDIT_CHAIN: DurableObjectNamespace<AuditChain>;
  /** Runs one master key rotation per instance (instance ID = rotation ID). */
  KEY_ROTATION_WORKFLOW: Workflow<KeyRotationParams>;
  /** Runs one-click server provisioning, one instance per run (instance ID = `prov_…`). */
  PROVISION_WORKFLOW: Workflow<ProvisionParams>;
  /** Runs one backup per instance (instance ID = the `bak_…` backup ID), ADR 0004. */
  BACKUP_WORKFLOW: Workflow<BackupParams>;
  /** Runs one restore per instance (instance ID = the `rst_…` restore ID), ADR 0004. */
  RESTORE_WORKFLOW: Workflow<RestoreParams>;
  /** Runs one volume migration per instance (instance ID = the `mig_…` ID), ADR 0004. */
  VOLUME_MIGRATION_WORKFLOW: Workflow<VolumeMigrationParams>;
  /**
   * Seconds a provisioned server gets to join, overriding `JOIN_TIMEOUT_MS`;
   * and seconds between join checks. For development and tests; unset in production.
   */
  PROVISION_JOIN_TIMEOUT_S?: string;
  PROVISION_JOIN_POLL_S?: string;
  /**
   * Seconds a rollout waits for healthy replicas, overriding
   * `ROLLOUT_TIMEOUT_MS`. For development and tests (the end-to-end suite
   * sees a failing health check in a minute instead of ten); unset in
   * production. See `rolloutTimeoutMs`.
   */
  ROLLOUT_TIMEOUT_S?: string;
  /**
   * DNS-over-HTTPS JSON endpoint for custom-domain checks, e.g. a resolver
   * that sees split-horizon records. Defaults to Cloudflare's; Google's is
   * the fallback either way.
   */
  DNS_RESOLVER_URL?: string;
}

type AppBindings = Env;

declare global {
  namespace Cloudflare {
    // Lets `cloudflare:test`'s `env` export carry our binding types.
    interface Env extends AppBindings {}
  }
}
