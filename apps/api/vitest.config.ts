import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  // wrangler.jsonc points assets at the web build; tests don't need it to exist.
  mkdirSync(join(import.meta.dirname, "../web/dist"), { recursive: true });
  const migrations = await readD1Migrations(
    join(import.meta.dirname, "../../packages/db/migrations"),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            // Fixed test-only key; never used outside the test runtime.
            MASTER_KEY: "dGVzdC1tYXN0ZXIta2V5LWRvLW5vdC11c2UtMDAwMDA=",
            TEST_MIGRATIONS: migrations,
            // Provisioned test servers join (or time out) in seconds, not minutes.
            PROVISION_JOIN_TIMEOUT_S: "8",
            PROVISION_JOIN_POLL_S: "1",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
