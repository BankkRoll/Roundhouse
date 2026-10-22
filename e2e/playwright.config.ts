import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.E2E_PORT ?? "8798";

export default defineConfig({
  testDir: "./tests",
  // The tests share one control plane whose first-run setup can happen only once.
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        // Dark is the primary theme in the design.
        colorScheme: "dark",
      },
    },
  ],
  webServer: {
    command: "node serve.mjs",
    url: `http://127.0.0.1:${PORT}/v1/setup`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { E2E_PORT: PORT },
  },
});
