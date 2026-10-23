/**
 * Builds metrics SQL from typed queries, for Analytics Engine's SQL API and
 * for the D1 fallback table, which shares its column names.
 *
 * SECURITY: Analytics Engine's SQL API takes no bound parameters, so its SQL
 * is interpolated. Every interpolated value is checked first: IDs against
 * `ID_RE`, numbers as safe non-negative integers, column names from the
 * fixed layout. Nothing a caller types reaches the SQL text otherwise, and
 * a bad value throws before any SQL exists. D1 statements bind the same
 * values as parameters.
 *
 * Every query groups by step and workload; replicas are combined into a
 * service series afterwards (`series.ts`), because summing per-replica
 * averages is right for CPU and memory while one average over every
 * replica's samples is not.
 *
 * @module
 */
import { ID_RE } from "@roundhouse/protocol";
import {
  CONTAINER_DOUBLES,
  METRICS_DATASET,
  type MetricAggregate,
  metricColumn,
  NODE_DOUBLES,
} from "@roundhouse/shared";

/** Which SQL dialect to emit. */
export type SqlDialect = "analytics_engine" | "d1";

/** One aggregate column of a query, selected as `m<i>`. */
export interface QueryColumn {
  column: (typeof CONTAINER_DOUBLES)[number] | (typeof NODE_DOUBLES)[number];
  aggregate: MetricAggregate;
}

/** A typed metrics query. */
export interface MetricsQuery {
  kind: "container" | "node";
  /** Equality filters on layout blobs; `index` filters `index1`. */
  filters: {
    index?: string;
    workspace_id?: string;
    project_id?: string;
    environment_id?: string;
  };
  /** Range, unix seconds, `from` inclusive and `to` exclusive; multiples of `stepS`. */
  from: number;
  to: number;
  stepS: number;
  columns: readonly QueryColumn[];
  /** Also group by `blob5` (service), for project summaries. */
  byService?: boolean;
  /** Group by `blob7` (workload); container queries only. */
  byWorkload?: boolean;
  /** Also select `approx`: 1 when any sample came from Docker stats. */
  withSource?: boolean;
}

/** SQL text and, for D1, its parameters. */
export interface BuiltQuery {
  sql: string;
  params: (string | number)[];
}

/** Rows one query may return; bounds the response whatever the data. */
export const MAX_QUERY_ROWS = 20_000;

/** Thrown for a query value that may not reach SQL. */
export class InvalidMetricsQuery extends Error {
  override name = "InvalidMetricsQuery";
}

function id(value: string, what: string): string {
  if (!ID_RE.test(value)) throw new InvalidMetricsQuery(`${what} is not a valid ID`);
  return value;
}

function int(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidMetricsQuery(`${what} must be a non-negative integer`);
  }
  return value;
}

const FILTER_COLUMNS = {
  index: "index1",
  workspace_id: metricColumn("blob", "workspace_id"),
  project_id: metricColumn("blob", "project_id"),
  environment_id: metricColumn("blob", "environment_id"),
} as const;

function aggregate(dialect: SqlDialect, col: string, agg: MetricAggregate, stepS: number) {
  const ae = dialect === "analytics_engine";
  switch (agg) {
    case "avg":
      return ae ? `sum(${col} * _sample_interval) / sum(_sample_interval)` : `avg(${col})`;
    case "max":
      return `max(${col})`;
    case "rate":
      return ae ? `sum(${col} * _sample_interval) / ${stepS}` : `sum(${col}) / ${stepS}.0`;
    case "sum":
      return ae ? `sum(${col} * _sample_interval)` : `sum(${col})`;
  }
}

/**
 * Builds the SQL for a query.
 *
 * @param q - The query; every ID and number is validated.
 * @param dialect - Analytics Engine (values inlined) or D1 (values bound).
 * @returns SQL selecting `t` (unix seconds, the step's start), `workload`
 *   and `service` when grouped by them, `m0…` per column, and `approx`
 *   when asked.
 * @throws {InvalidMetricsQuery} For a value that is not a valid ID or integer.
 * @example
 * buildMetricsQuery({ kind: "node", filters: { index: "nod_1" }, from: 0, to: 3600,
 *   stepS: 15, columns: [{ column: "cpu_percent", aggregate: "avg" }] }, "d1");
 */
export function buildMetricsQuery(q: MetricsQuery, dialect: SqlDialect): BuiltQuery {
  const stepS = int(q.stepS, "step");
  if (stepS === 0) throw new InvalidMetricsQuery("step must be positive");
  const from = int(q.from, "from");
  const to = int(q.to, "to");
  if (from >= to) throw new InvalidMetricsQuery("from must be before to");
  if (!q.columns.length) throw new InvalidMetricsQuery("no columns");

  const ae = dialect === "analytics_engine";
  const params: (string | number)[] = [];
  const value = (v: string | number) => {
    if (ae) return typeof v === "number" ? String(v) : `'${v}'`;
    params.push(v);
    return "?";
  };

  const doubles: readonly string[] = q.kind === "container" ? CONTAINER_DOUBLES : NODE_DOUBLES;
  const select = [
    ae
      ? `toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL '${stepS}' SECOND)) AS t`
      : `(timestamp / ${stepS * 1000}) * ${stepS} AS t`,
  ];
  const group = ["t"];
  if (q.byService) {
    select.push(`${metricColumn("blob", "service_id")} AS service`);
    group.push("service");
  }
  if (q.byWorkload) {
    select.push(`${metricColumn("blob", "workload_id")} AS workload`);
    group.push("workload");
  }
  q.columns.forEach((c, i) => {
    const pos = doubles.indexOf(c.column);
    if (pos < 0) throw new InvalidMetricsQuery(`no ${q.kind} column ${c.column}`);
    select.push(`${aggregate(dialect, `double${pos + 1}`, c.aggregate, stepS)} AS m${i}`);
  });
  if (q.withSource) {
    const src = metricColumn("blob", "source");
    select.push(
      ae
        ? `max(if(${src} = 'docker_stats', 1, 0)) AS approx`
        : `max(CASE WHEN ${src} = 'docker_stats' THEN 1 ELSE 0 END) AS approx`,
    );
  }

  const where = [`${metricColumn("blob", "kind")} = ${value(q.kind)}`];
  for (const [key, column] of Object.entries(FILTER_COLUMNS)) {
    const v = q.filters[key as keyof typeof FILTER_COLUMNS];
    if (v !== undefined) where.push(`${column} = ${value(id(v, key))}`);
  }
  where.push(
    ae
      ? `timestamp >= toDateTime(${from}) AND timestamp < toDateTime(${to})`
      : `timestamp >= ${value(from * 1000)} AND timestamp < ${value(to * 1000)}`,
  );

  const table = ae ? METRICS_DATASET : "metrics_samples";
  const sql = [
    `SELECT ${select.join(", ")}`,
    `FROM ${table}`,
    `WHERE ${where.join(" AND ")}`,
    `GROUP BY ${group.join(", ")}`,
    `ORDER BY t`,
    `LIMIT ${MAX_QUERY_ROWS}`,
    ...(ae ? ["FORMAT JSON"] : []),
  ].join("\n");
  return { sql, params };
}
