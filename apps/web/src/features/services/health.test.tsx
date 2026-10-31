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
    service.health_node = { id: "node_hel1", name: "hel-1" };
    const { user } = renderApp(servicePath(SEED.web, "settings"));
    const badge = await screen.findByText("Degraded");
    expect(badge).toHaveAccessibleDescription(/^Server hel-1 went offline./);
    await user.tab();
    while (document.activeElement !== badge) await user.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/hel-1 reconnects/);
  });

  it("shows no badge for a healthy service", async () => {
    renderApp(servicePath(SEED.web, "settings"));
    expect(await screen.findByRole("heading", { level: 1 })).toBeInTheDocument();
    expect(screen.queryByText("Degraded")).toBeNull();
  });
});
