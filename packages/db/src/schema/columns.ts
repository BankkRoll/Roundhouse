/**
 * Column builders shared by every table, so IDs, timestamps, and JSON columns
 * are declared the same way everywhere.
 *
 * @module
 */
import { integer, text } from "drizzle-orm/sqlite-core";

/**
 * Primary key column. IDs are generated in application code (prefixed ULIDs)
 * so they're known before insert and sortable by creation time.
 *
 * @returns A TEXT primary-key column named `id`.
 */
export const id = () => text("id").primaryKey();

/**
 * Unix-millisecond timestamp column, read and written as a `Date`.
 *
 * @param name - SQL column name.
 * @returns An INTEGER column in `timestamp_ms` mode.
 */
export const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

/** `created_at` / `updated_at` pair carried by every table. */
export const timestamps = {
  createdAt: timestamp("created_at")
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp("updated_at")
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
};

/**
 * JSON column stored as TEXT.
 *
 * @param name - SQL column name.
 * @returns A TEXT column in `json` mode, typed as `T`.
 */
export const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();
