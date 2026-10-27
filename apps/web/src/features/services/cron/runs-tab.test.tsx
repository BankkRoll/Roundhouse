import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CRON_SEED } from "../../../mocks/cron-db";
import { db, signInAs, USERS } from "../../../mocks/db";
import { pushRealtime, servicePath } from "../../../test/phase1";
import { renderApp } from "../../../test/render";

const RUNS = servicePath(CRON_SEED.service, "runs");

async function openRuns() {
  const app = renderApp(RUNS);
  const table = await screen.findByRole("table", { name: "Runs" });
  return { ...app, table };
}

const run = (id: string) => db.cron.runs.find((row) => row.id === id)!;

describe("cron runs tab", () => {
  it("shows the schedule state and the runs, missed records and agent errors in words", async () => {
    const { table } = await openRuns();
    expect(screen.getByText("Active", { selector: "dd span" })).toBeInTheDocument();
    expect(screen.getByText("0 3 * * * (Europe/Berlin)")).toBeInTheDocument();
    expect(screen.getByText(/\(Europe\/Berlin\)$/, { selector: "time" })).toBeInTheDocument();
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.dataset.status)).toEqual([
      "running",
      "succeeded",
      "failed",
      "missed",
      "failed",
      "succeeded",
    ]);
    expect(rows[3]).toHaveTextContent("1 run missed (control plane unavailable at 03:00)");
    expect(rows[3]).not.toHaveTextContent("1 run missed at");
    expect(rows[2]).toHaveTextContent(/No server runs an agent that can run jobs/);
    expect(rows[4]).toHaveTextContent("3");
  });

  it("offers to replace a run in progress when Run now is refused", async () => {
    const { user } = await openRuns();
    await user.click(screen.getByRole("button", { name: "Run now" }));
    const confirm = await screen.findByRole("dialog", { name: "A run is in progress" });
    await user.click(
      within(confirm).getByRole("button", { name: "Cancel the running one and run" }),
    );
    expect(await screen.findByText("Run queued")).toBeInTheDocument();
    expect(run(CRON_SEED.running).status).toBe("cancelled");
    expect(db.cron.runs.at(-1)).toMatchObject({ status: "queued", trigger: "manual" });
    await waitFor(() =>
      expect(screen.getByRole("table", { name: "Runs" }).querySelector("tbody tr")).toHaveAttribute(
        "data-status",
        "queued",
      ),
    );
  });

  it("opens a run's output and cancels it from the panel", async () => {
    const { user, table } = await openRuns();
    await user.click(within(table).getByRole("button", { name: /Running$/ }));
    const panel = await screen.findByRole("dialog", { name: `Run ${CRON_SEED.running}` });
    expect(await within(panel).findByText("report: counting orders…")).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Cancel run" }));
    expect(await screen.findByText("Run cancelled")).toBeInTheDocument();
    expect(run(CRON_SEED.running)).toMatchObject({ status: "cancelled" });
    await waitFor(() =>
      expect(within(panel).queryByRole("button", { name: "Cancel run" })).not.toBeInTheDocument(),
    );
  });

  it("pauses and resumes the schedule", async () => {
    const { user } = await openRuns();
    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(await screen.findByText("Schedule paused")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(db.cron.states[0]?.paused).toBe(true);
    await user.click(screen.getByRole("button", { name: "Resume" }));
    expect(await screen.findByText("Schedule resumed")).toBeInTheDocument();
    expect(db.cron.states[0]?.paused).toBe(false);
  });

  it("adds runs that arrive over the realtime socket", async () => {
    const { table } = await openRuns();
    const now = Date.now();
    pushRealtime({
      type: "cron_run.updated",
      run: {
        ...run(CRON_SEED.lastSucceeded),
        id: "crn_zlive",
        status: "starting",
        trigger: "retry",
        scheduled_for: now,
        created_at: now,
        updated_at: now,
      },
    });
    await waitFor(() =>
      expect(within(table).getAllByRole("row")[1]).toHaveAttribute("data-status", "starting"),
    );
  });

  it("shows viewers the history without actions", async () => {
    signInAs(USERS.viewer.id);
    await openRuns();
    expect(screen.queryByRole("button", { name: "Run now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
  });

  it("asks for a schedule on a cron service whose config has none", async () => {
    for (const config of db.deploy.configs) {
      if (config.service_id === CRON_SEED.service) config.cron = null;
    }
    const { user, router } = renderApp(RUNS);
    const banner = await screen.findByText("This cron job needs a schedule before it can deploy.");
    await user.click(within(banner.parentElement!).getByRole("link", { name: "Set a schedule" }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/\/settings$/));
    expect(router.state.location.hash).toBe("cron");
  });
});
