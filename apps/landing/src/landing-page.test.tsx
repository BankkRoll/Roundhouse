import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingPage } from "./landing-page";
import { ADVISORIES, CLASS_ORDER, CLASSES, SEVERITY_RANK, type Severity } from "./model/cves";
import { DEFENCES } from "./model/defences";
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

  it("announces that the project is under development above the header bar", async () => {
    await renderLanding();
    const banner = screen.getByTestId("dev-banner");
    expect(banner).toHaveTextContent(/under active development/i);
    expect(banner.closest("header")).not.toBeNull();
  });

  it("points every GitHub link at the project repository", async () => {
    await renderLanding();
    // Advisories for other platforms link to their own repositories on purpose.
    const advisories = screen.getByTestId("advisories");
    const external = screen
      .getAllByRole("link")
      .filter((link) => !advisories.contains(link))
      .map((link) => link.getAttribute("href") ?? "")
      .filter((href) => href.includes("github.com"));
    expect(external.length).toBeGreaterThan(0);
    for (const href of external) {
      expect(href).toMatch(/^https:\/\/github\.com\/BankkRoll\/Roundhouse/);
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

describe("security section", () => {
  it("names a heading for every block and links every claim to its code", async () => {
    await renderLanding();
    const section = document.getElementById("security");
    expect(section).toBeInstanceOf(HTMLElement);
    const scope = within(section as HTMLElement);
    expect(scope.getByRole("heading", { level: 2 })).toHaveTextContent(/secure by the way/i);
    expect(scope.getAllByRole("heading", { level: 3 }).length).toBeGreaterThanOrEqual(5);
    const code = scope.getAllByRole("link", { name: /^See the code/ });
    expect(code.length).toBe(DEFENCES.length);
    for (const link of code) {
      expect(link.getAttribute("href")).toMatch(
        /^https:\/\/github\.com\/BankkRoll\/Roundhouse\/blob\/main\//,
      );
    }
    expect(scope.getByRole("link", { name: /security policy/i })).toHaveAttribute(
      "href",
      expect.stringMatching(/SECURITY\.md$/),
    );
    expect(scope.getByRole("link", { name: /october 2026 review/i })).toHaveAttribute(
      "href",
      expect.stringMatching(/review-2026-10\.md$/),
    );
  });

  it("lists every advisory in a captioned table, linked to its official advisory", async () => {
    const { user } = await renderLanding();
    const explorer = screen.getByTestId("advisories");
    const table = within(explorer).getByRole("table");
    expect(table).toHaveAccessibleDescription(/published security advisories/i);
    expect(within(table).getAllByRole("row").length).toBeLessThan(ADVISORIES.length + 1);
    await user.click(
      within(explorer).getByRole("button", { name: `Show all ${ADVISORIES.length} advisories` }),
    );
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(ADVISORIES.length);
    for (const row of rows) {
      const link = within(row).getByRole("link", { name: /^(CVE|GHSA)-/ });
      expect(link.textContent).toMatch(/^(CVE-\d{4}-\d{4,}|GHSA(-[23456789cfghjmpqrvwx]{4}){3})$/);
      expect(link.getAttribute("href")).toMatch(/^https:\/\//);
      expect(link).toHaveAttribute("target", "_blank");
    }
  });

  it("sorts newest first, or most severe first", async () => {
    const { user } = await renderLanding();
    const table = within(screen.getByTestId("advisories")).getByRole("table");
    const dates = () =>
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.getAttribute("data-published") ?? "");
    expect(dates()).toEqual([...dates()].sort().reverse());
    await user.click(within(table).getByRole("button", { name: /severity/i }));
    const severities = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => SEVERITY_RANK[row.getAttribute("data-severity") as Severity]);
    expect(severities).toEqual([...severities].sort((a, b) => a - b));
  });

  it("filters by kind of flaw and names what blocks it here", async () => {
    const { user } = await renderLanding();
    const explorer = screen.getByTestId("advisories");
    const group = within(explorer).getByRole("group", { name: /kind of flaw/i });
    const kinds = within(group).getAllByRole("button");
    expect(kinds[0]).toHaveAttribute("aria-pressed", "true");
    const kind = CLASS_ORDER.find((value) => ADVISORIES.some((a) => a.kind === value));
    if (!kind) throw new Error("no advisory classes");
    await user.click(
      within(group).getByRole("button", { name: new RegExp(`^${CLASSES[kind].label}`) }),
    );
    const rows = within(within(explorer).getByRole("table")).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(ADVISORIES.filter((a) => a.kind === kind).length);
    for (const row of rows) expect(row).toHaveAttribute("data-class", kind);
    const verdict = within(explorer).getByTestId("class-verdict");
    for (const id of CLASSES[kind].defences) {
      expect(verdict).toHaveTextContent(DEFENCES.find((d) => d.id === id)?.title ?? id);
    }
    await user.click(kinds[0] as HTMLElement);
    expect(kinds[0]).toHaveAttribute("aria-pressed", "true");
    expect(within(explorer).getByTestId("class-verdict")).toHaveTextContent(
      `${ADVISORIES.length} advisories`,
    );
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
