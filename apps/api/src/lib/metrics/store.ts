/**
 * The two metrics stores of ADR 0008 behind one interface:
 * - {@link AnalyticsEngineStore} (production) asks the Analytics Engine SQL
 *   API, and caches each answer for 30 s in the Cache API;
 * - {@link D1MetricsStore} (development, tests, installs without an
 *   analytics token) runs the equivalent query on `metrics_samples`.
 *
 * @module
 */
import type { Env } from "../../env";
import { ApiError } from "../errors";
import { analyticsCredentials, type MetricsBackend, metricsBackend } from "./backend";
import { type BuiltQuery, buildMetricsQuery, type MetricsQuery } from "./query";

/** One grouped row of a metrics query. */
export interface MetricsResultRow {
  /** Start of the step, unix seconds. */
  t: number;
  workload?: string;
  service?: string;
  /** One value per query column, in order; `null` when not a finite number. */
  values: (number | null)[];
  /** Any sample came from Docker stats (cgroup v1 hosts). */
  approx: boolean;
}

/** Answers typed metrics queries. */
export interface MetricsStore {
  readonly backend: MetricsBackend;
  run(query: MetricsQuery): Promise<MetricsResultRow[]>;
}

/** How long an Analytics Engine answer is reused (ADR 0008). */
export const METRICS_CACHE_TTL_S = 30;

/** Analytics Engine SQL API endpoint of an account. */
export function analyticsSqlUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/analytics_engine/sql`;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Turns raw rows (`FORMAT JSON` data or D1 results) into result rows.
 *
 * @param rows - Rows with `t`, optional `workload`/`service`, `m0…` and `approx`.
 * @param columns - Number of `m` columns.
 * @returns Parsed rows; rows without a usable `t` are dropped.
 */
export function parseRows(rows: readonly Record<string, unknown>[], columns: number) {
  const out: MetricsResultRow[] = [];
  for (const r of rows) {
    const t = num(r.t);
    if (t === null) continue;
    out.push({
      t,
      ...(typeof r.workload === "string" ? { workload: r.workload } : {}),
      ...(typeof r.service === "string" ? { service: r.service } : {}),
      values: Array.from({ length: columns }, (_, i) => num(r[`m${i}`])),
      approx: num(r.approx) === 1,
    });
  }
  return out;
}

/** Reads from Analytics Engine through its SQL API. */
export class AnalyticsEngineStore implements MetricsStore {
  readonly backend = "analytics_engine" as const;

  /**
   * @param accountId - Cloudflare account ID.
   * @param token - "Account Analytics Read" API token.
   * @param fetcher - `fetch`, replaceable in tests.
   * @param cache - Cache for answers; `null` disables caching.
   */
  constructor(
    private readonly accountId: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly cache: Cache | null = typeof caches === "undefined" ? null : caches.default,
  ) {}

  async run(query: MetricsQuery): Promise<MetricsResultRow[]> {
    const built = buildMetricsQuery(query, "analytics_engine");
    return parseRows(await this.fetchData(built), query.columns.length);
  }

  private async fetchData(built: BuiltQuery): Promise<Record<string, unknown>[]> {
    // SECURITY: the cache key hashes the SQL (which embeds the account and
    // every filter) so answers for one service can never serve another; the
    // token is not part of it and never stored.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${this.accountId}\n${built.sql}`),
    );
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const key = new Request(`https://metrics-cache.roundhouse.invalid/${hex}`);
    const cached = await this.cache?.match(key);
    if (cached) return ((await cached.json()) as { data: Record<string, unknown>[] }).data;

    let res: Response;
    try {
      res = await this.fetcher(analyticsSqlUrl(this.accountId), {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "text/plain" },
        body: built.sql,
      });
    } catch {
      throw new ApiError(503, "upstream_error", "Analytics Engine is unreachable");
    }
    if (!res.ok) {
      // NOTE: the body may echo the SQL; log the status only.
      console.warn("analytics engine query failed", res.status);
      throw new ApiError(503, "upstream_error", `Analytics Engine answered ${res.status}`);
    }
    const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
    if (!body || !Array.isArray(body.data)) {
      throw new ApiError(503, "upstream_error", "Analytics Engine sent an unreadable answer");
    }
    const data = body.data as Record<string, unknown>[];
    await this.cache?.put(
      key,
      new Response(JSON.stringify({ data }), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${METRICS_CACHE_TTL_S}`,
        },
      }),
    );
    return data;
  }
}

/** Reads from the `metrics_samples` table. */
export class D1MetricsStore implements MetricsStore {
  readonly backend = "d1" as const;

  /** @param db - The D1 database. */
  constructor(private readonly db: D1Database) {}

  async run(query: MetricsQuery): Promise<MetricsResultRow[]> {
    const { sql, params } = buildMetricsQuery(query, "d1");
    const { results } = await this.db
      .prepare(sql)
      .bind(...params)
      .all<Record<string, unknown>>();
    return parseRows(results, query.columns.length);
  }
}

/**
 * The store answering this install's queries.
 *
 * @param env - Worker bindings.
 * @returns The store for {@link metricsBackend}.
 * @throws {ApiError} 503 when Analytics Engine is forced but its credentials are missing.
 */
export function metricsStore(env: Env): MetricsStore {
  if (metricsBackend(env) === "d1") return new D1MetricsStore(env.DB);
  const creds = analyticsCredentials(env);
  if (!creds) {
    throw new ApiError(
      503,
      "upstream_error",
      "METRICS_BACKEND is analytics_engine but CF_ACCOUNT_ID or CF_ANALYTICS_TOKEN is not set",
    );
  }
  return new AnalyticsEngineStore(creds.accountId, creds.token);
}
