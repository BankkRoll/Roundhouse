import { defineConfig } from "vitest/config";

// Node-only integration tests (Pebble in Docker); the Workers pool config in
// vitest.config.ts runs everything else.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test-node/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
