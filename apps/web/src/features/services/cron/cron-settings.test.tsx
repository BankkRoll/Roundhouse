import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CRON_SEED } from "../../../mocks/cron-db";
import { db } from "../../../mocks/db";
import { servicePath } from "../../../test/phase1";
import { renderApp } from "../../../test/render";

const SETTINGS = servicePath(CRON_SEED.service, "settings");

function latest() {
  return db.deploy.configs
    .filter((c) => c.service_id === CRON_SEED.service)
    .sort((a, b) => b.version - a.version)[0]!;
}

/** The line under the schedule input, which describes it. */
function previewOf(input: HTMLElement): HTMLElement {
  return document.getElementById(input.getAttribute("aria-describedby")!)!;
}

async function openCron() {
  const app = renderApp(SETTINGS);
  const form = await screen.findByRole("form", { name: "Cron" });
  return { ...app, form };
}

describe("cron settings", () => {
  it("shows the cron part and leaves out what a job doesn't use", async () => {
    const { form } = await openCron();
    expect(within(form).getByLabelText("Schedule")).toHaveValue(CRON_SEED.schedule);
    expect(within(form).getByLabelText("Time zone")).toHaveValue(CRON_SEED.timezone);
    expect(previewOf(within(form).getByLabelText("Schedule"))).toHaveTextContent(
      /^At 03:00, every day \(Europe\/Berlin\) · next: \w{3} \d{1,2} \w{3} 03:00$/,
    );
    for (const name of ["Healthcheck", "Networking", "Domains"]) {
      expect(screen.queryByRole("form", { name })).not.toBeInTheDocument();
    }
    const deploy = screen.getByRole("form", { name: "Deploy" });
    expect(within(deploy).getByLabelText("Start command")).toHaveValue("node report.js");
    expect(within(deploy).queryByLabelText("Replicas")).not.toBeInTheDocument();
    expect(within(deploy).queryByLabelText("Restart policy")).not.toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Service settings" });
    expect(within(nav).getByRole("link", { name: "Cron" })).toHaveAttribute("href", "#cron");
    expect(within(nav).queryByRole("link", { name: "Healthcheck" })).not.toBeInTheDocument();
  });

  it("previews the schedule as it is typed and points at the error", async () => {
    const { form, user } = await openCron();
    const schedule = within(form).getByLabelText("Schedule");
    await user.clear(schedule);
    await user.type(schedule, "*/15 9-17 * * MON-FRI");
    expect(
      within(form).getByText("Every 15 minutes from 09:00 to 17:59, on weekdays"),
    ).toBeInTheDocument();
    await user.selectOptions(within(form).getByLabelText("Time zone"), "UTC");
    expect(previewOf(schedule)).toHaveTextContent(/\(UTC\) · next:/);

    await user.clear(schedule);
    await user.type(schedule, "0 25 * * *");
    expect(schedule).toHaveAttribute("aria-invalid", "true");
    expect(within(form).getByRole("alert")).toHaveTextContent(/Hour "25" is out of range 0-23/i);
    expect(within(form).getByTestId("schedule-error-span")).toHaveTextContent("25");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(latest().version).toBe(1);
  });

  it("saves the cron part as a new version", async () => {
    const { form, user } = await openCron();
    const schedule = within(form).getByLabelText("Schedule");
    await user.clear(schedule);
    await user.type(schedule, "@hourly");
    await user.selectOptions(within(form).getByLabelText("Concurrency"), "replace");
    expect(within(form).getByText(/The running run is cancelled/)).toBeInTheDocument();
    const retries = within(form).getByLabelText("Retries");
    await user.clear(retries);
    await user.type(retries, "9");
    expect(within(form).getByText("Enter a whole number from 0 to 5.")).toBeInTheDocument();
    await user.clear(retries);
    await user.type(retries, "3");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved as version 2")).toBeInTheDocument();
    expect(latest()).toMatchObject({
      version: 2,
      cron: {
        schedule: "@hourly",
        timezone: CRON_SEED.timezone,
        concurrency: "replace",
        retries: 3,
        timeout_s: 3600,
      },
    });
  });

  it("warns when Allow lets runs pile up past the interval", async () => {
    const { form, user } = await openCron();
    const schedule = within(form).getByLabelText("Schedule");
    await user.clear(schedule);
    await user.type(schedule, "*/10 * * * *");
    await user.selectOptions(within(form).getByLabelText("Concurrency"), "allow");
    expect(within(form).getByRole("status")).toHaveTextContent(
      "Runs can pile up: the timeout (1h) is longer than the 10m between slots",
    );
    const timeout = within(form).getByLabelText("Timeout (seconds)");
    await user.clear(timeout);
    await user.type(timeout, "300");
    expect(within(form).queryByRole("status")).not.toBeInTheDocument();
  });

  it("asks for a schedule on a cron service whose config has none, and takes one", async () => {
    for (const config of db.deploy.configs) {
      if (config.service_id === CRON_SEED.service) config.cron = null;
    }
    const { form, user } = await openCron();
    expect(
      screen.getByText("This cron job needs a schedule before it can deploy."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set a schedule" })).toHaveAttribute("href", "#cron");
    expect(within(form).getByLabelText("Schedule")).toHaveValue("");
    await user.type(within(form).getByLabelText("Schedule"), "0 6 * * 1");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(latest().cron).toMatchObject({ schedule: "0 6 * * 1", concurrency: "forbid" }),
    );
  });
});
