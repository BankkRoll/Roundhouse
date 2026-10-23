import { applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import { beforeEach } from "vitest";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Read from the migrated schema rather than listed by hand, so a new table is
// wiped without anyone remembering to add it here.
const { results: tables } = await env.DB.prepare(
  `SELECT name FROM sqlite_master
   WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'`,
).all<{ name: string }>();

// The append-only triggers refuse the wipe below, so it drops them and puts
// them back in the same batch.
const { results: triggers } = await env.DB.prepare(
  "SELECT name, sql FROM sqlite_master WHERE type = 'trigger'",
).all<{ name: string; sql: string }>();

// NOTE: D1 storage is shared across tests within a file, and almost every
// test starts from a fresh install, so wipe app tables between tests.
beforeEach(async () => {
  // Every test reinstalls from the same (absent) client IP, which would trip
  // the real 10/min limiter; security.test.ts exercises the limiter directly.
  (env as { AUTH_LIMITER?: RateLimit }).AUTH_LIMITER = {
    limit: async () => ({ success: true }),
  };
  // Deferred so foreign keys are only checked at commit, when every table is empty.
  await env.DB.batch([
    env.DB.prepare("PRAGMA defer_foreign_keys = ON"),
    ...triggers.map((t) => env.DB.prepare(`DROP TRIGGER IF EXISTS "${t.name}"`)),
    ...tables.map((t) => env.DB.prepare(`DELETE FROM "${t.name}"`)),
    ...triggers.map((t) => env.DB.prepare(t.sql)),
  ]);
  // The chain's checkpoints describe the wiped log; a fresh install starts a new chain.
  await runInDurableObject(env.AUDIT_CHAIN.get(env.AUDIT_CHAIN.idFromName("global")), (_, state) =>
    state.storage.deleteAll(),
  );
});
