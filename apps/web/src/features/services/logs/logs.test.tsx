import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db } from "../../../mocks/db";
import { runtimeLogLines } from "../../../mocks/deploy-db";
import { pushRealtime, SEED, servicePath, subscriptions } from "../../../test/phase1";
import { renderApp } from "../../../test/render";
import { LOG_ROW_HEIGHT } from "./log-viewer";

const LOGS = servicePath(SEED.web, "logs");

async function openLogs(path = LOGS) {
  const app = renderApp(path);
  const log = await screen.findByRole("log");
  return { ...app, log };
}

const renderedRows = (log: HTMLElement) => log.querySelectorAll("[data-log-row]");

describe("logs tab", () => {
  it("loads the newest page of the serving deployment and subscribes to its live lines", async () => {
    const { log } = await openLogs();
    expect(log).toHaveAccessibleName("Runtime logs of 3f9c2b1");
    expect(screen.getByText("450 lines")).toBeInTheDocument();
    await waitFor(() => expect(subscriptions()).toEqual([`deployment_logs:${SEED.webActive}`]));
  });

  it("renders only the visible window of 10,000 lines, and follows the scroll", async () => {
    db.deploy.logs[`deployment:${SEED.webActive}`] = runtimeLogLines(10_000, Date.now());
    const { log, user } = await openLogs();
    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByText("500 lines")).toBeInTheDocument();
    db.deploy.logs[`deployment:${SEED.webActive}`] = runtimeLogLines(10_000, Date.now());
    pushRealtime({
      type: "log.lines",
      source: {
        type: "runtime",
        service_id: SEED.web,
        deployment_id: SEED.webActive,
        workload_id: "wl",
      },
      lines: Array.from({ length: 9_500 }, (_, i) => ({
        ts: Date.now() + i,
        stream: "stdout" as const,
        text: `live ${i}`,
      })),
    });
    await screen.findByText("10000 lines");
    const rows = renderedRows(log);
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.length).toBeLessThan(80);
    expect(Number(log.dataset.renderedRows)).toBe(rows.length);
    expect((log.firstElementChild as HTMLElement).style.height).toBe(
      `${10_000 * LOG_ROW_HEIGHT}px`,
    );

    log.scrollTop = 5_000 * LOG_ROW_HEIGHT;
    fireEvent.scroll(log);
    await waitFor(() => expect(within(log).getByText("live 4499")).toBeInTheDocument());
    const tops = [...renderedRows(log)].map((row) =>
      Number.parseInt((row as HTMLElement).style.top, 10),
    );
    expect(Math.min(...tops)).toBeLessThanOrEqual(5_000 * LOG_ROW_HEIGHT);
    expect(Math.max(...tops)).toBeGreaterThanOrEqual(5_020 * LOG_ROW_HEIGHT);
    expect(renderedRows(log).length).toBeLessThan(80);
  });

  it("appends live lines while following, and keeps them while paused", async () => {
    const { user } = await openLogs();
    await waitFor(() => expect(subscriptions()).toHaveLength(1));
    pushRealtime({
      type: "log.lines",
      source: {
        type: "runtime",
        service_id: SEED.web,
        deployment_id: SEED.webActive,
        workload_id: "wl",
      },
      lines: [{ ts: Date.now() + 1, stream: "stdout", text: "fresh line" }],
    });
    expect(await screen.findByText("451 lines")).toBeInTheDocument();
    expect(screen.getByText("live")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByRole("button", { name: "Follow" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("paused")).toBeInTheDocument();
    pushRealtime({
      type: "log.lines",
      source: {
        type: "runtime",
        service_id: SEED.web,
        deployment_id: SEED.webActive,
        workload_id: "wl",
      },
      lines: [{ ts: Date.now() + 2, stream: "stdout", text: "while paused" }],
    });
    expect(await screen.findByText("452 lines")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Follow" }));
    await user.type(screen.getByLabelText("Search loaded lines"), "paused");
    await waitFor(() => expect(screen.getByRole("log")).toHaveTextContent("while paused"));
  });

  it("pages back through older lines until the beginning", async () => {
    db.deploy.logs[`deployment:${SEED.webActive}`] = runtimeLogLines(1_200, Date.now());
    const { user } = await openLogs();
    expect(screen.getByText("500 lines")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load older" }));
    expect(await screen.findByText("1000 lines")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load older" }));
    expect(await screen.findByText("1200 lines")).toBeInTheDocument();
    expect(screen.getByText("Beginning of log")).toBeInTheDocument();
  });

  it("filters by stream and searches loaded lines with highlights", async () => {
    const { user, log } = await openLogs();
    await user.click(screen.getByRole("button", { name: "stdout" }));
    await user.click(screen.getByRole("button", { name: "system" }));
    expect(screen.getByText(/of 450 lines/)).toBeInTheDocument();
    for (const row of renderedRows(log)) expect(row).toHaveAttribute("data-stream", "stderr");
    await user.click(screen.getByRole("button", { name: "stdout" }));
    await user.type(screen.getByLabelText("Search loaded lines"), "/CART");
    await waitFor(() => expect(log.querySelectorAll("mark").length).toBeGreaterThan(0));
    for (const mark of log.querySelectorAll("mark"))
      expect(mark.textContent?.toLowerCase()).toBe("/cart");
    await user.clear(screen.getByLabelText("Search loaded lines"));
    await user.type(screen.getByLabelText("Search loaded lines"), "no such text");
    expect(await screen.findByText("No loaded lines match.")).toBeInTheDocument();
  });

  it("renders ANSI colors safely", async () => {
    db.deploy.logs[`deployment:${SEED.webActive}`] = [
      {
        ts: Date.now(),
        stream: "stdout",
        text: "\x1b[31m<img src=x onerror=alert(1)>\x1b[0m \x1b]8;;https://evil.example\x07phish\x1b]8;;\x07 \x1b[2Jdone",
      },
    ];
    const { log } = await openLogs();
    const row = renderedRows(log)[0] as HTMLElement;
    expect(row.querySelector("img")).toBeNull();
    expect(row.querySelector("a")).toBeNull();
    expect(row).toHaveTextContent("<img src=x onerror=alert(1)> phish done");
  });

  it("switches to build logs and copies visible text without escapes", async () => {
    const { user, log } = await openLogs();
    await user.click(screen.getByRole("radio", { name: "Build" }));
    await waitFor(() => expect(log).toHaveAccessibleName("Build logs of 3f9c2b1"));
    await waitFor(() => expect(subscriptions()).toEqual([`build_logs:${SEED.webBuild}`]));
    await user.click(screen.getByRole("switch", { name: "Timestamps" }));
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByText(/Copied \d+ lines/)).toBeInTheDocument();
    const copied = await navigator.clipboard.readText();
    expect(copied.split("\n")[0]).toBe(
      "==> Cloning https://github.com/acme/storefront.git (main @ 3f9c2b1)",
    );
    expect(copied).not.toContain("\x1b");
  });

  it("explains when a service has never been deployed", async () => {
    db.deploy.deployments = db.deploy.deployments.filter((d) => d.service_id !== SEED.api);
    renderApp(servicePath(SEED.api, "logs"));
    expect(await screen.findByRole("heading", { name: "No logs yet" })).toBeInTheDocument();
  });
});
