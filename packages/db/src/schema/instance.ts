/**
 * Install-wide settings and the record of redeemed single-use values.
 *
 * @module
 */
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { json, timestamp, timestamps } from "./columns";

/**
 * Install-wide key/value settings written by the setup wizard (apps domain,
 * signing keys, setup completion). One row per key.
 */
export const instanceSettings = sqliteTable("instance_settings", {
  key: text("key").primaryKey(),
  value: json<unknown>("value").notNull(),
  ...timestamps,
});

/**
 * Single-use values that were already redeemed, such as the nonce of a signed
 * GitHub install state. A redeemed value is inserted once; a second insert
 * conflicts, which is how a replay is detected. Rows are pruned after they
 * expire, since an expired value is rejected on its own.
 */
export const consumedNonces = sqliteTable(
  "consumed_nonces",
  {
    /** `<purpose>:<nonce>`. */
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    ...timestamps,
  },
  (t) => [index("consumed_nonces_expires_idx").on(t.expiresAt)],
);
