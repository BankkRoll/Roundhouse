import { readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

// The stack (control plane, node, Caddy) is started by run.mjs, which
// points PHASE1_STACK at its description; there is no webServer here.
const stack = JSON.parse(readFileSync(process.env.PHASE1_STACK ?? "", "utf8")) as { base: string };

export default defineConfig({
  testDir: ".",
  testMatch: "ui.spec.ts",
  outputDir: "./.artifacts/test-results",
  fullyParallel: false,
  workers: 1,
  timeout: 10 * 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never", outputFolder: "./.artifacts/playwright-report" }]]
    : "list",
  use: {
    baseURL: stack.base,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
