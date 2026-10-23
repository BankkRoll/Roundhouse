/**
 * Control-plane metadata schema (D1 / SQLite via Drizzle).
 *
 * Migrations are generated into `../migrations` with `pnpm --filter @roundhouse/db generate`
 * and applied by wrangler (`d1 migrations apply`) as part of every deploy.
 *
 * @module
 */
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema/index";

export * from "./schema/index";

/**
 * Wraps a D1 binding in a typed Drizzle client.
 *
 * @param d1 - The `DB` binding from the Worker environment.
 * @returns A Drizzle database with the full schema attached for relational queries.
 */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

/** Typed Drizzle client returned by {@link createDb}. */
export type Db = ReturnType<typeof createDb>;
