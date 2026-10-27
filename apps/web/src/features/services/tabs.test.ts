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

describe("Shell tab", () => {
  const onlyShell = (action: string) => action === "shell:open";

  it("ends app and database services' tabs with Shell for callers who may open one", () => {
    expect(serviceTabs({ kind: "app" }, () => true).at(-1)?.id).toBe("shell");
    expect(
      serviceTabs({ kind: "app", database: { engine: "postgres" } }, onlyShell).at(-1)?.id,
    ).toBe("shell");
  });

  it("leaves it out without shell:open", () => {
    const ids = serviceTabs({ kind: "app" }, (action) => action !== "shell:open").map(
      (tab) => tab.id,
    );
    expect(ids).not.toContain("shell");
  });

  it("never gives a cron service a shell", () => {
    expect(serviceTabs({ kind: "cron" }, () => true).map((tab) => tab.id)).not.toContain("shell");
  });
});
