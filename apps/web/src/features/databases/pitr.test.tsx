import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { addPitrHistory, DATA_SEED, PITR_SEED } from "../../mocks/data-db";
import { db, PASSWORD, signInAs, USERS } from "../../mocks/db";
import { servicePath } from "../../test/phase1";
import { findPageHeading, renderApp } from "../../test/render";
import { earliestIn, formatInZone, latestIn, toInputValue } from "./pitr-time";

const DB = DATA_SEED.database;
const HOUR = 3_600_000;
const OLDER_WINDOW = /^Window from .+ \(1 of 2\)$/;

async function openBackups() {
  const app = renderApp(servicePath(DB, "backups"));
  await findPageHeading("postgres");
  const policy = await screen.findByRole("form", { name: "Backup policy" });
  return { ...app, policy };
}

async function openPitr() {
  const app = await openBackups();
  const section = await screen.findByRole("region", { name: "Point-in-time recovery" });
  return { ...app, section };
}

/** Opens the restore dialog with times entered in UTC, so the test doesn't depend on TZ. */
async function openRestore(app: Awaited<ReturnType<typeof openPitr>>) {
  await app.user.click(
    await within(app.section).findByRole("button", { name: "Restore to a point in time…" }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Restore postgres to a point in time?",
  });
  await app.user.click(within(dialog).getByRole("radio", { name: "UTC" }));
  return dialog;
}

function pick(dialog: HTMLElement, ms: number) {
  fireEvent.change(within(dialog).getByLabelText("Restore to"), {
    target: { value: toInputValue(ms, "utc") },
  });
}

describe("point-in-time recovery setting", () => {
  it("explains itself, needs the schedule, and turns scheduled backups into base backups", async () => {
    const { user, policy } = await openBackups();
    const toggle = within(policy).getByRole("switch", { name: "Point-in-time recovery" });
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
    expect(toggle).toHaveAccessibleDescription(
      /restored to any second since its oldest base backup/,
    );
    expect(within(policy).getByText("Logical dump")).toBeInTheDocument();

    await user.click(within(policy).getByRole("switch", { name: "Scheduled backups" }));
    expect(toggle).toBeDisabled();
    expect(
      within(policy).getByText(
        "Turn on scheduled backups first: base backups follow the schedule.",
      ),
    ).toBeInTheDocument();
    await user.click(within(policy).getByRole("switch", { name: "Scheduled backups" }));
    expect(toggle).toBeEnabled();

    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(within(policy).getByText("Base backup")).toBeInTheDocument();
    await user.click(within(policy).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Backup policy saved")).toBeInTheDocument();
    expect(db.data.policies[0]).toMatchObject({ pitr: true, method: "base" });
    expect(db.data.walStreams).toEqual([expect.objectContaining({ status: "active" })]);

    const section = screen.getByRole("region", { name: "Point-in-time recovery" });
    await waitFor(() => expect(within(section).getByText("Starting")).toBeInTheDocument());
    expect(within(section).getByText(/the first base backup is being taken/)).toBeInTheDocument();
    expect(within(section).getByText(/Nothing to restore to yet/)).toBeInTheDocument();
    expect(
      within(section).getByRole("button", { name: "Restore to a point in time…" }),
    ).toBeDisabled();
  });

  it("turns off with the schedule, saying so first", async () => {
    addPitrHistory(db.data);
    const { user, policy } = await openBackups();
    const toggle = within(policy).getByRole("switch", { name: "Point-in-time recovery" });
    expect(toggle).toBeChecked();
    await user.click(within(policy).getByRole("switch", { name: "Scheduled backups" }));
    expect(toggle).not.toBeChecked();
    expect(
      within(policy).getByText(/Turning off scheduled backups turns this off too/),
    ).toBeVisible();
    await user.click(within(policy).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Backup policy saved")).toBeInTheDocument();
    expect(db.data.policies[0]).toMatchObject({ enabled: false, pitr: false, method: "dump" });
    expect(db.data.walStreams.find((row) => row.id === PITR_SEED.stream)?.status).toBe("retired");
  });

  it("is disabled with the reason when the database can't archive", async () => {
    db.deploy.configs.find((row) => row.service_id === DB)!.deploy.start_command =
      "postgres -c shared_buffers=1GB";
    const { policy } = await openBackups();
    const reason = await within(policy).findByText(
      "The database has a custom start command; point-in-time recovery sets its own",
    );
    expect(reason).toBeVisible();
    expect(within(policy).getByRole("switch", { name: "Point-in-time recovery" })).toBeDisabled();
  });

  it("is hidden for engines without it", async () => {
    db.deploy.services.find((row) => row.id === DB)!.database = { engine: "mysql", version: "8.4" };
    const { policy } = await openBackups();
    expect(within(policy).queryByRole("switch", { name: "Point-in-time recovery" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Point-in-time recovery" })).toBeNull();
  });
});

describe("restoring to a point in time", () => {
  it("lists the windows and their archive in words, in local time or UTC", async () => {
    const windows = addPitrHistory(db.data);
    const { user, section } = await openPitr();
    expect(await within(section).findByText("Archiving")).toBeInTheDocument();
    expect(within(section).getByText(/segments, \d/)).toBeInTheDocument();
    expect(within(section).getByText(/^Last archived/)).toBeInTheDocument();
    const list = within(section).getByRole("list", { name: "Restorable windows" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent(formatInZone(earliestIn(windows[0]!), "local"));
    expect(items[1]).toHaveTextContent(/still growing/);
    await user.click(within(section).getByRole("radio", { name: "UTC" }));
    expect(items[0]).toHaveTextContent(formatInZone(earliestIn(windows[0]!), "utc"));
    expect(within(items[0]!).getAllByRole("time")[0]).toHaveAttribute(
      "title",
      formatInZone(earliestIn(windows[0]!), "local"),
    );
  });

  it("validates the time against the window and the clock before anything is sent", async () => {
    const windows = addPitrHistory(db.data);
    const app = await openPitr();
    const dialog = await openRestore(app);
    const input = within(dialog).getByLabelText("Restore to");
    expect(input).toHaveAttribute("type", "datetime-local");
    expect(input).toHaveAttribute("min", toInputValue(earliestIn(windows[1]!), "utc"));
    expect(within(dialog).getByText(/^UTC, to the second\. That is /)).toBeInTheDocument();
    await app.user.type(within(dialog).getByLabelText(/to confirm/), "postgres");
    const confirm = within(dialog).getByRole("button", { name: "Restore into a new service" });

    pick(dialog, windows[1]!.from - HOUR);
    expect(
      within(dialog).getByText(/^Outside the restorable window\. Pick a time from /),
    ).toBeVisible();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(confirm).toBeDisabled();

    pick(dialog, Date.now() + 24 * HOUR);
    expect(within(dialog).getByText(/^That time is in the future\./)).toBeVisible();
    expect(confirm).toBeDisabled();

    fireEvent.change(input, { target: { value: "" } });
    expect(within(dialog).getByText("Enter a date and a time, to the second.")).toBeVisible();

    await app.user.click(within(dialog).getByRole("button", { name: "Earliest" }));
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(confirm).toBeEnabled();

    await app.user.click(within(dialog).getByRole("radio", { name: OLDER_WINDOW }));
    expect(input).toHaveAttribute("max", toInputValue(latestIn(windows[0]!, Date.now()), "utc"));
    expect(db.data.restores).toHaveLength(0);
  });

  it("restores in place after the typed slug, asking for the password when the session is stale", async () => {
    const windows = addPitrHistory(db.data);
    db.sessionStale = true;
    const app = await openPitr();
    const dialog = await openRestore(app);
    const target = Math.floor((windows[1]!.from + 3 * HOUR) / 1000) * 1000;
    pick(dialog, target);
    await app.user.click(within(dialog).getByRole("radio", { name: /postgres, in place/ }));
    expect(within(dialog).getByLabelText(/Skip the safety backup/)).toBeInTheDocument();
    const confirm = within(dialog).getByRole("button", { name: "Restore in place" });
    expect(confirm).toBeDisabled();
    await app.user.type(within(dialog).getByLabelText(/to confirm/), "postgres");
    await app.user.click(confirm);

    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await app.user.type(within(reauth).getByLabelText("Password"), PASSWORD);
    await app.user.click(within(reauth).getByRole("button", { name: "Confirm" }));

    expect(await screen.findByText("Point-in-time restore started")).toBeInTheDocument();
    expect(db.data.restores.at(-1)).toMatchObject({
      mode: "in_place",
      backup_id: PITR_SEED.base,
      target_time: target,
      safety_backup_id: expect.any(String),
    });
    const status = await screen.findByText(/^Restor(e to .+ queued|ing to .+|ed to .+)$/);
    expect(status).toHaveTextContent(new Date(target).toISOString().slice(0, 19).replace("T", " "));
  });

  it("restores an older window into a new service", async () => {
    const windows = addPitrHistory(db.data);
    const app = await openPitr();
    const dialog = await openRestore(app);
    await app.user.click(within(dialog).getByRole("radio", { name: OLDER_WINDOW }));
    pick(dialog, windows[0]!.from + HOUR);
    await app.user.type(within(dialog).getByLabelText("New service slug"), "postgres-tuesday");
    await app.user.type(within(dialog).getByLabelText(/to confirm/), "postgres");
    await app.user.click(
      within(dialog).getByRole("button", { name: "Restore into a new service" }),
    );
    expect(await screen.findByText("Point-in-time restore started")).toBeInTheDocument();
    const restore = db.data.restores.at(-1)!;
    expect(restore).toMatchObject({ mode: "new_service", backup_id: PITR_SEED.olderBase });
    expect(db.deploy.services.find((row) => row.id === restore.target_service_id)?.slug).toBe(
      "postgres-tuesday",
    );
    expect(await screen.findByRole("link", { name: /^Open postgres restore/ })).toBeInTheDocument();
  });

  it("shows the API's refusal when the window has gone in the meantime", async () => {
    addPitrHistory(db.data);
    const app = await openPitr();
    const dialog = await openRestore(app);
    for (const row of db.data.backups) if (row.method === "base") row.status = "deleted";
    await app.user.type(within(dialog).getByLabelText(/to confirm/), "postgres");
    await app.user.click(
      within(dialog).getByRole("button", { name: "Restore into a new service" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      /Nothing is restorable to a point in time yet/,
    );
    expect(db.data.restores).toHaveLength(0);
  });

  it("keeps the restore locked for those who can't restore, saying why", async () => {
    addPitrHistory(db.data);
    signInAs(USERS.viewer.id);
    const { section, policy } = await openPitr();
    expect(within(policy).getByRole("switch", { name: "Point-in-time recovery" })).toBeDisabled();
    expect(await within(section).findByRole("list", { name: "Restorable windows" })).toBeVisible();
    const button = within(section).getByRole("button", { name: "Restore to a point in time…" });
    expect(button).toBeDisabled();
    expect(button.parentElement).toHaveAccessibleDescription(
      "Restoring to a point in time needs permission to restore backups. Ask a project admin for more access.",
    );
  });
});
