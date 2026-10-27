import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db } from "../../mocks/db";
import { SEED, servicePath } from "../../test/phase1";
import { renderApp } from "../../test/render";

describe("service health", () => {
  it("badges a degraded service in its header with the reason", async () => {
    const service = db.deploy.services.find((s) => s.id === SEED.web)!;
    service.health = "degraded";
    service.health_reason = "node_offline";
    renderApp(servicePath(SEED.web, "settings"));
    const badge = await screen.findByText("Degraded");
    expect(badge).toHaveAttribute("title", expect.stringMatching(/server is offline/));
  });

  it("shows no badge for a healthy service", async () => {
    renderApp(servicePath(SEED.web, "settings"));
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.queryByText("Degraded")).toBeNull();
  });
});
