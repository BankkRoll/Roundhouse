import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingPage } from "./landing-page";
import { PAGE_SECTIONS } from "./sections/header";

const fetchSpy = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  fetchSpy.mockReset();
  vi.unstubAllGlobals();
});

async function renderLanding() {
  const user = userEvent.setup();
  render(<LandingPage />);
  await screen.findByRole("heading", { level: 1, name: /deploy to servers you own/i });
  return { user };
}

describe("public site", () => {
  it("renders without any network request", async () => {
    await renderLanding();
    expect(fetchSpy).not.toHaveBeenCalled();
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
  it("compares your servers with each hosted platform and recomputes from the workload", async () => {
    await renderLanding();
    const calculator = screen.getByTestId("calculator");
    expect(within(calculator).getByTestId("self-total")).toHaveTextContent("$65.00");
    expect(calculator).toHaveTextContent(/2 rented servers with 8 vCPU and 16 GB RAM/);
    const render = within(calculator).getByTestId("hosted-render");
    expect(within(calculator).getByTestId("hosted-railway")).toHaveTextContent("$205");
    expect(within(calculator).getByTestId("hosted-fly")).toHaveTextContent("$170");
    const before = render.textContent;
    fireEvent.change(screen.getByLabelText("Average vCPU in use"), { target: { value: "24" } });
    expect(render.textContent).not.toBe(before);
    expect(within(calculator).getByTestId("self-total")).toHaveTextContent("$95.00");
    expect(within(calculator).getByTestId("difference")).toHaveTextContent(
      /less than these hosted platforms/,
    );
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
