/**
 * Which metrics store answers queries, and how often agents sample.
 *
 * @module
 */
import { MAX_METRICS_INTERVAL_MS, MIN_METRICS_INTERVAL_MS } from "@roundhouse/protocol";
import type { Env } from "../../env";

/** Where metrics are read from. */
export type MetricsBackend = "analytics_engine" | "d1";

/** Agent sampling interval of ADR 0008. */
export const DEFAULT_METRICS_INTERVAL_MS = 15_000;

type BackendEnv = Pick<Env, "METRICS_BACKEND" | "CF_ACCOUNT_ID" | "CF_ANALYTICS_TOKEN">;

/**
 * The store that answers metrics queries: D1 when forced (`METRICS_BACKEND=d1`)
 * or when the Analytics Engine SQL credentials are missing, else Analytics
 * Engine. The node Durable Object also writes samples to D1 exactly when
 * this says `d1`, so reads and writes always agree.
 *
 * @param env - Worker bindings.
 * @returns The backend in use.
 */
export function metricsBackend(env: BackendEnv): MetricsBackend {
  const forced = env.METRICS_BACKEND?.trim();
  if (forced === "d1") return "d1";
  if (forced === "analytics_engine") return "analytics_engine";
  return analyticsCredentials(env) ? "analytics_engine" : "d1";
}

/**
 * The account ID and read token for the Analytics Engine SQL API, or `null`
 * when either is missing.
 *
 * @param env - Worker bindings.
 * @returns Both values, trimmed.
 */
export function analyticsCredentials(env: BackendEnv): { accountId: string; token: string } | null {
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const token = env.CF_ANALYTICS_TOKEN?.trim();
  return accountId && token ? { accountId, token } : null;
}

/**
 * The `welcome.metrics_interval_ms` sent to metrics-capable agents.
 *
 * @param env - Worker bindings; `METRICS_INTERVAL_MS` overrides the default.
 * @returns The interval, clamped to the protocol's range.
 */
export function metricsIntervalMs(env: Pick<Env, "METRICS_INTERVAL_MS">): number {
  const raw = Number(env.METRICS_INTERVAL_MS);
  const ms = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DEFAULT_METRICS_INTERVAL_MS;
  return Math.min(MAX_METRICS_INTERVAL_MS, Math.max(MIN_METRICS_INTERVAL_MS, ms));
}
