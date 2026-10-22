/**
 * Install-wide settings table.
 *
 * @module
 */
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { json, timestamps } from "./columns";

/**
 * Install-wide key/value settings written by the setup wizard (apps domain,
 * signing keys, setup completion). One row per key.
 */
export const instanceSettings = sqliteTable("instance_settings", {
  key: text("key").primaryKey(),
  value: json<unknown>("value").notNull(),
  ...timestamps,
});
