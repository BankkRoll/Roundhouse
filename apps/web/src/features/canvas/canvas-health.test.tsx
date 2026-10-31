import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db } from "../../mocks/db";
import { announceServiceHealth } from "../../mocks/deploy-handlers";
import { PROJECT_PATH, SEED } from "../../test/phase1";
import { renderApp } from "../../test/render";

async function openCanvas() {
  const app = renderApp(PROJECT_PATH);
  const canvas = await screen.findByRole("group", { name: /Project canvas/ });
  await within(canvas).findByRole("button", { name: /^api / });
  return { ...app, canvas };
}

function degrade(serviceId: string, reason: "node_offline" | "node_maintenance") {
  const service = db.deploy.services.find((s) => s.id === serviceId)!;
  service.health = "degraded";
  service.health_reason = reason;
  service.health_node = { id: "node_hel1", name: "hel-1" };
}

describe("service health on the canvas", () => {
  it("badges a degraded node in words, explaining which server it waits on", async () => {
    degrade(SEED.web, "node_offline");
    const { canvas } = await openCanvas();
    const web = within(canvas).getByRole("button", { name: /^web / });
    await waitFor(() => expect(web).toHaveAccessibleName("web Degraded web Active, app service"));
    expect(web).toHaveAccessibleDescription(
      /^Server hel-1 went offline\. This service keeps its data there.*reconnects\.$/,
    );
    expect(within(web).getByText("Degraded")).toBeInTheDocument();
    // NOTE: Nested in the node's button, the badge must not be a second tab stop.
    expect(within(web).getByText("Degraded")).not.toHaveAttribute("tabindex");

    const api = within(canvas).getByRole("button", { name: /^api / });
    expect(within(api).queryByText("Degraded")).toBeNull();
    expect(api).not.toHaveAttribute("aria-describedby");
  });

  it("shows the reason in a tooltip on hover", async () => {
    degrade(SEED.web, "node_maintenance");
    const { canvas, user } = await openCanvas();
    const web = within(canvas).getByRole("button", { name: /^web / });
    await user.hover(await within(web).findByText("Degraded"));
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(
      "A forced drain of server hel-1 stopped it. It starts again there when hel-1 is resumed.",
    );
  });

  it("follows health changes live over the realtime socket", async () => {
    const { canvas } = await openCanvas();
    const web = () => within(canvas).getByRole("button", { name: /^web / });
    await waitFor(() => expect(web()).toHaveAccessibleName("web web Active, app service"));

    await waitFor(() => {
      announceServiceHealth(SEED.web, {
        health: "degraded",
        health_reason: "node_maintenance",
        health_node: { id: "node_hel1", name: "hel-1" },
      });
      expect(within(web()).getByText("Degraded")).toBeInTheDocument();
    });
    expect(web()).toHaveAccessibleDescription(/forced drain of server hel-1/);

    await waitFor(() => {
      announceServiceHealth(SEED.web, { health: "ok", health_reason: null, health_node: null });
      expect(within(web()).queryByText("Degraded")).toBeNull();
    });
    expect(web()).toHaveAccessibleName("web web Active, app service");
  });

  it("names no server when it's gone", async () => {
    degrade(SEED.web, "node_offline");
    db.deploy.services.find((s) => s.id === SEED.web)!.health_node = null;
    const { canvas } = await openCanvas();
    const web = within(canvas).getByRole("button", { name: /^web / });
    await waitFor(() => expect(web).toHaveAccessibleDescription(/^Its server went offline\./));
  });
});
