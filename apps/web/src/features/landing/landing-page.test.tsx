import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKSPACE_ID } from "../../mocks/db";
import { apiError } from "../../mocks/handlers";
import { server } from "../../mocks/server";
import { renderApp } from "../../test/render";
import { buildCommands } from "../shell/commands";
import { PAGE_SECTIONS } from "./sections/header";

const apiRequests: string[] = [];
const recordRequest = ({ request }: { request: Request }) => {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/v1") || pathname.startsWith("/api")) apiRequests.push(pathname);
};

beforeEach(() => {
  apiRequests.length = 0;
  server.events.on("request:start", recordRequest);
});

afterEach(() => {
  server.events.removeListener("request:start", recordRequest);
});

async function renderLanding() {
  const result = renderApp("/");
  await screen.findByRole("heading", { level: 1, name: /your own railway/i });
  return result;
}

describe("/ (landing page route)", () => {
  it("renders for signed-out visitors on a fresh install without redirecting", async () => {
    server.use(
      http.get("*/v1/me", () => apiError(401, "unauthorized", "Not signed in")),
      http.get("*/v1/setup", () =>
        HttpResponse.json({ needs_setup: true, master_key_configured: false }),
      ),
    );
    const { router } = await renderLanding();
    // Give any stray guard a chance to fire before asserting nothing navigated.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.state.location.pathname).toBe("/");
    expect(apiRequests).toEqual([]);
  });

  it("renders while the API is unreachable", async () => {
    server.use(
      http.get("*/v1/*", () => HttpResponse.error()),
      http.get("*/api/*", () => HttpResponse.error()),
    );
    const { router } = await renderLanding();
    expect(router.state.location.pathname).toBe("/");
    expect(apiRequests).toEqual([]);
  });
});

describe("landing page content", () => {
  it("has a section for every in-page link in the header, menu, search and footer", async () => {
    await renderLanding();
    for (const [id] of PAGE_SECTIONS) {
      expect(document.getElementById(id), `#${id}`).toBeInstanceOf(HTMLElement);
    }
    const hashLinks = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href") ?? "")
      .filter((href) => href.startsWith("#") && href !== "#main");
    expect(hashLinks.length).toBeGreaterThanOrEqual(8);
    for (const href of hashLinks) {
      expect(document.getElementById(href.slice(1)), href).toBeInstanceOf(HTMLElement);
    }
  });

  it("shows no phase labels or roadmap", async () => {
    await renderLanding();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/phase \d/i);
    expect(text).not.toMatch(/coming soon/i);
    expect(text).not.toMatch(/roadmap/i);
    expect(screen.getAllByText(/early development/i).length).toBeGreaterThan(0);
  });

  it("points every GitHub link at the project repository", async () => {
    await renderLanding();
    const external = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href") ?? "")
      .filter((href) => href.includes("github.com"));
    expect(external.length).toBeGreaterThan(0);
    for (const href of external) {
      expect(href).toMatch(/^https:\/\/github\.com\/BankkRoll\/Open-Rail/);
    }
  });

  it("explains a schematic component on click", async () => {
    const { user } = await renderLanding();
    const diagram = screen.getByTestId("architecture");
    await user.click(within(diagram).getByRole("button", { name: /^Durable Objects/ }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/WebSocket terminates/);
  });

  it("lists every deploy stop with its log when the scene is at rest", async () => {
    await renderLanding();
    const pipeline = screen.getByTestId("pipeline");
    expect(pipeline).toHaveAttribute("data-mode", "rest");
    expect(
      within(pipeline)
        .getAllByRole("heading", { level: 3 })
        .map((h) => h.textContent),
    ).toEqual([
      "Push",
      "Build",
      "Registry",
      "Schedule",
      "Pull & start",
      "Health check",
      "Route",
      "Live",
    ]);
  });
});

describe("the live thing", () => {
  it("rejects a tampered envelope and accepts the original", async () => {
    const { user } = await renderLanding();
    const demo = screen.getByTestId("envelope-demo");
    await waitFor(() => expect(demo).toHaveAttribute("data-result", "accepted"));
    await user.click(within(demo).getByRole("switch", { name: /tamper/i }));
    await waitFor(() => expect(demo).toHaveAttribute("data-result", "rejected"));
    expect(within(demo).getByRole("status")).toHaveTextContent(/REJECTED · bad_signature/);
    await user.click(within(demo).getByRole("switch", { name: /tamper/i }));
    await waitFor(() => expect(demo).toHaveAttribute("data-result", "accepted"));
  });
});

describe("canvas", () => {
  it("stages edits from the controls and deploys them back to active", async () => {
    const { user } = await renderLanding();
    const canvas = screen.getByTestId("canvas");
    const logLevel = screen.getByLabelText("api · LOG_LEVEL");
    await user.clear(logLevel);
    await user.type(logLevel, "debug");
    expect(canvas.querySelector('[data-node="api"]')).toHaveAttribute("data-status", "staged");

    await user.click(screen.getByRole("radio", { name: "Redis" }));
    expect(canvas.querySelector('[data-edge="redis-worker"]')).not.toBeNull();
    expect(within(canvas).getByTestId("staged-count")).toHaveTextContent("2 staged changes");

    const diff = screen.getByRole("list", { name: "Staged changes" });
    expect(diff).toHaveTextContent("debug");
    expect(diff).toHaveTextContent("REDIS_URL");

    await user.click(screen.getByRole("button", { name: "Deploy" }));
    await waitFor(
      () => {
        expect(canvas.querySelector('[data-node="api"]')).toHaveAttribute("data-status", "active");
        expect(canvas.querySelector('[data-node="worker"]')).toHaveAttribute(
          "data-status",
          "active",
        );
      },
      { timeout: 5000 },
    );
    expect(within(canvas).getByTestId("staged-count")).toHaveTextContent("Everything deployed");
  });
});

describe("cost calculator", () => {
  it("states the fleet and recomputes the Railway estimate from the workload", async () => {
    await renderLanding();
    const calculator = screen.getByTestId("calculator");
    expect(within(calculator).getByTestId("self-total")).toHaveTextContent("$65.00");
    expect(calculator).toHaveTextContent(/2 rented servers with 8 vCPU and 16 GB RAM/);
    const paas = within(calculator).getByTestId("paas-total");
    const before = paas.textContent;
    fireEvent.change(screen.getByLabelText("Average vCPU in use"), { target: { value: "8" } });
    expect(paas.textContent).not.toBe(before);
    expect(within(calculator).getByTestId("self-total")).toHaveTextContent("$65.00");
    expect(within(calculator).getByTestId("difference")).toHaveTextContent(/Railway list price/);
  });
});

describe("Product menu keyboard", () => {
  it("opens with ArrowDown, moves between groups, traps Tab and closes with Escape", async () => {
    const { user } = await renderLanding();
    const trigger = screen.getByRole("button", { name: /^Product$/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByRole("region", { name: "Product" });
    const items = within(panel).getAllByRole("link");
    await waitFor(() => expect(items[0]).toHaveFocus());

    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toHaveTextContent(/^Data/);

    await user.keyboard("{End}");
    expect(items.at(-1)).toHaveFocus();
    await user.keyboard("{Tab}");
    expect(items[0]).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("region", { name: "Product" })).not.toBeInTheDocument();
  });

  it("opens the full-screen sheet on small screens and closes it with Escape", async () => {
    const { user } = await renderLanding();
    await user.click(screen.getByRole("button", { name: "Menu" }));
    const sheet = screen.getByRole("dialog", { name: "Menu" });
    const data = within(sheet).getByRole("button", { name: "Data" });
    await user.click(data);
    expect(data).toHaveAttribute("aria-expanded", "true");
    expect(within(sheet).getByRole("link", { name: /Backups/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Menu" })).not.toBeInTheDocument();
  });
});

describe("in-app entry points", () => {
  it("offers the landing page in the command palette when wired", () => {
    const openLanding = vi.fn();
    const commands = buildCommands({
      navigate: vi.fn(),
      can: () => true,
      openAddServer: vi.fn(),
      openInviteMember: vi.fn(),
      toggleTheme: vi.fn(),
      signOut: vi.fn(),
      openLanding,
    });
    const command = commands.find((candidate) => candidate.id === "prototype:landing");
    expect(command?.group).toBe("Prototype");
    command?.onSelect();
    expect(openLanding).toHaveBeenCalled();
  });

  it("links to the landing page from the dashboard sidebar", async () => {
    renderApp(`/w/${WORKSPACE_ID}`);
    const links = await screen.findAllByRole("link", { name: "Landing page" });
    expect(links[0]).toHaveAttribute("href", "/");
  });
});
