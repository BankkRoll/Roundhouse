import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The runtime Worker (src/cf-runtime) is uploaded as text, so its tests run
// the source directly under Node with `cloudflare:workers` stubbed.
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./test-runtime/cloudflare-workers-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["test-runtime/**/*.test.ts"],
  },
});
