import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// NOTE: The router plugin is left out on purpose. Tests import the committed
// routeTree.gen.ts directly, and code splitting would only slow module loading.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The MSW contract test reads the API's route definitions (and their zod schemas)
      // straight from source. Only tests may import through this alias.
      "@openrail/api-source": resolve(import.meta.dirname, "../api/src"),
      // The API's Phase 1 routers import Durable Object and Workflow classes; the contract
      // test only reads their route registries, so a stub of the runtime module suffices.
      "cloudflare:workers": resolve(import.meta.dirname, "src/test/cloudflare-workers-stub.ts"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    testTimeout: 15_000,
  },
});
