/**
 * The D1 fallback for the metrics dataset (ADR 0008): used in development,
 * tests, and installs without an Analytics Engine read token.
 *
 * Columns mirror an Analytics Engine data point one to one (`index1`,
 * `blob1`…, `double1`…, `timestamp`), so the query builder emits the same
 * column names for either backend. Which blob or double holds what is fixed
 * in `@roundhouse/shared`'s `metrics-layout.ts`.
 *
 * No foreign keys on purpose: samples outlive the deployments and replicas
 * they describe, and the hourly retention job prunes them after 48 hours.
 *
 * @module
 */
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** One metrics sample: a container's or a node's, at `timestamp` (unix ms). */
export const metricsSamples = sqliteTable(
  "metrics_samples",
  {
    /** `service_id` for container rows, `node_id` for node rows. */
    index1: text("index1").notNull(),
    timestamp: integer("timestamp").notNull(),
    blob1: text("blob1").notNull(),
    blob2: text("blob2").notNull().default(""),
    blob3: text("blob3").notNull().default(""),
    blob4: text("blob4").notNull().default(""),
    blob5: text("blob5").notNull().default(""),
    blob6: text("blob6").notNull().default(""),
    blob7: text("blob7").notNull().default(""),
    blob8: text("blob8").notNull().default(""),
    blob9: text("blob9").notNull().default(""),
    double1: real("double1").notNull().default(0),
    double2: real("double2").notNull().default(0),
    double3: real("double3").notNull().default(0),
    double4: real("double4").notNull().default(0),
    double5: real("double5").notNull().default(0),
    double6: real("double6").notNull().default(0),
    double7: real("double7").notNull().default(0),
    double8: real("double8").notNull().default(0),
    double9: real("double9").notNull().default(0),
    double10: real("double10").notNull().default(0),
    double11: real("double11").notNull().default(0),
  },
  (t) => [
    index("metrics_samples_index_ts_idx").on(t.index1, t.blob1, t.timestamp),
    // The project summary filters by project and environment, not service.
    index("metrics_samples_project_ts_idx").on(t.blob3, t.blob4, t.timestamp),
    index("metrics_samples_ts_idx").on(t.timestamp),
  ],
);
