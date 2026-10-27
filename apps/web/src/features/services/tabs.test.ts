import { describe, expect, it } from "vitest";
import { serviceTabs } from "./tabs";

describe("serviceTabs", () => {
  it("leads a cron service with Runs and leaves out Metrics and Domains", () => {
    expect(serviceTabs({ kind: "cron" }, () => true).map((tab) => tab.id)).toEqual([
      "runs",
      "deployments",
      "logs",
      "variables",
      "settings",
    ]);
  });

  it("gives an app service no Runs tab", () => {
    expect(serviceTabs({ kind: "app" }, () => true).map((tab) => tab.id)).not.toContain("runs");
  });
});
