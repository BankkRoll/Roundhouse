import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DATA_SEED } from "../../mocks/data-db";
import { db, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { PROJECT_PATH, SEED, servicePath } from "../../test/phase1";
import { findPageHeading, renderApp } from "../../test/render";

const DB = DATA_SEED.database;

async function openService(tab: string) {
  const app = renderApp(servicePath(DB, tab));
  await findPageHeading("postgres");
  return app;
}

describe("adding a database", () => {
  it("picks an engine, previews what is created with masked credentials, and applies", async () => {
    const { user, router } = renderApp(PROJECT_PATH);
    await findPageHeading("storefront");
    await user.click(screen.getByRole("button", { name: "New service" }));
    const dialog = await screen.findByRole("dialog", { name: "New service" });
    await user.click(within(dialog).getByRole("radio", { name: /Database/ }));
    await user.click(within(dialog).getByRole("radio", { name: /^Valkey/ }));
    expect(within(dialog).getByLabelText("Version")).toHaveValue("valkey-9");
    expect(
      within(dialog).getByRole("option", { name: "Valkey 9.1 (default)" }),
    ).toBeInTheDocument();
    const size = within(dialog).getByLabelText("Volume (GiB)");
    await user.clear(size);
    await user.type(size, "0.1");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(within(dialog).getByText(/Enter a size from 0.25/)).toBeInTheDocument();
    await user.clear(size);
    await user.type(size, "2");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));

    expect(within(dialog).getByLabelText("Name")).toHaveValue("Valkey");
    expect(within(dialog).getByLabelText("Environment")).toHaveValue(SEED.production);
    const variables = within(dialog).getByRole("list", { name: "Variables to create" });
    expect(within(variables).getByText("REDIS_URL").parentElement).toHaveTextContent(
      "generated, write-only",
    );
    expect(within(dialog).getByText(/2 GiB/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Add and deploy" }));

    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/\/s\/svc_mock\d+\/deployments$/),
    );
    const service = db.deploy.services.at(-1)!;
    expect(service).toMatchObject({
      kind: "database",
      slug: "valkey",
      database: { engine: "redis", version: "valkey-9" },
    });
    expect(db.data.volumes.at(-1)).toMatchObject({ service_id: service.id, size_mb: 2048 });
    expect(await screen.findByText("Deploying Valkey")).toBeInTheDocument();
  });
});

describe("database service pages", () => {
  it("shows Data and Backups tabs instead of Domains", async () => {
    await openService("deployments");
    const tabs = screen.getByRole("navigation", { name: "Service" });
    expect(
      within(tabs)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Deployments", "Logs", "Metrics", "Data", "Backups", "Variables", "Settings"]);
  });

  it("hides the Data tab from viewers", async () => {
    signInAs(USERS.viewer.id);
    await openService("deployments");
    const tabs = screen.getByRole("navigation", { name: "Service" });
    expect(within(tabs).queryByRole("link", { name: "Data" })).not.toBeInTheDocument();
    expect(within(tabs).getByRole("link", { name: "Backups" })).toBeInTheDocument();
  });

  it("shows connection details as references and fingerprints, never secret values", async () => {
    await openService("settings");
    const section = await screen.findByRole("region", { name: "Database" });
    expect(within(section).getByText("PostgreSQL 18")).toBeInTheDocument();
    expect(within(section).getByText("postgres.production.internal:5432")).toBeInTheDocument();
    const list = within(section).getByRole("list", { name: "Connection variables" });
    expect(
      within(list).getByRole("button", { name: "Copy DATABASE_URL reference" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(within(list).getAllByText(/fp [0-9a-f]{8}/).length).toBeGreaterThan(0),
    );
    const secret = db.deploy.variables.find(
      (v) => v.owner_id === DB && v.key === "POSTGRES_PASSWORD",
    )!.value;
    expect(document.body.textContent).not.toContain(secret);
    expect(
      within(section).getByRole("button", { name: "Rotate credentials…" }),
    ).toBeInTheDocument();
  });
});

describe("volume", () => {
  it("shows usage and quota, grows the volume and refuses to shrink it", async () => {
    const { user } = await openService("settings");
    const section = await screen.findByRole("region", { name: "Volume" });
    expect(await within(section).findByText("1.3 GB of 5 GiB")).toBeInTheDocument();
    expect(within(section).getByRole("meter", { name: "Volume usage" })).toBeInTheDocument();
    expect(within(section).getByText("Enforced by an XFS project quota")).toBeInTheDocument();
    expect(within(section).getByText("hel-1")).toBeInTheDocument();

    const size = within(section).getByLabelText("Size (GiB)");
    await user.clear(size);
    await user.type(size, "4");
    await user.click(within(section).getByRole("button", { name: "Grow" }));
    expect(within(section).getByText("Volumes only grow; it is 5 GiB.")).toBeInTheDocument();
    await user.clear(size);
    await user.type(size, "8");
    await user.click(within(section).getByRole("button", { name: "Grow" }));
    expect(await screen.findByText("Volume grown to 8 GiB")).toBeInTheDocument();
    expect(db.data.volumes[0]).toMatchObject({ id: DATA_SEED.volume, size_mb: 8192 });
  });

  it("warns when the quota isn't enforced, and undeletes a deleted volume", async () => {
    Object.assign(db.data.volumes[0]!, {
      quota_mode: "none",
      status: "pending_deletion",
      delete_after: Date.now() + 50 * 3_600_000,
    });
    const { user } = await openService("settings");
    const section = await screen.findByRole("region", { name: "Volume" });
    expect(await within(section).findByText("Not enforced")).toBeInTheDocument();
    expect(within(section).getByText(/can grow past its size/)).toBeInTheDocument();
    expect(within(section).getByText(/removed from hel-1 in 2d/)).toBeInTheDocument();
    expect(within(section).getByLabelText("Size (GiB)")).toBeDisabled();
    await user.click(within(section).getByRole("button", { name: "Undelete" }));
    expect(await screen.findByText("Volume restored")).toBeInTheDocument();
    expect(db.data.volumes[0]).toMatchObject({ status: "ready", delete_after: null });
  });
});

describe("backups tab", () => {
  it("lists backups, previews the schedule, and backs up now", async () => {
    const { user } = await openService("backups");
    const table = await screen.findByRole("table", { name: "Backups" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent(/Manual.*Succeeded.*98 MB/);
    expect(rows[1]).toHaveTextContent(/Scheduled.*Failed/);
    const policy = screen.getByRole("form", { name: "Backup policy" });
    expect(within(policy).getByLabelText("Schedule (cron, UTC)")).toHaveValue("0 3 * * *");
    expect(within(policy).getByText(/^Next: /)).toHaveTextContent(/03:00/);

    await user.click(screen.getByRole("button", { name: "Back up now" }));
    expect(await screen.findByText("Backup queued")).toBeInTheDocument();
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(6));
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent(/Manual.*(Queued|Running)/);
  });

  it("saves the policy and validates the cron expression", async () => {
    const { user } = await openService("backups");
    const policy = await screen.findByRole("form", { name: "Backup policy" });
    const cron = within(policy).getByLabelText("Schedule (cron, UTC)");
    await user.clear(cron);
    await user.type(cron, "every night");
    expect(within(policy).getByText(/Enter a five-field cron expression/)).toBeInTheDocument();
    await user.clear(cron);
    await user.type(cron, "30 1 * * *");
    expect(within(policy).getByText(/^Next: /)).toHaveTextContent(/01:30/);
    const keep = within(policy).getByLabelText("Keep the last");
    await user.clear(keep);
    await user.type(keep, "14");
    await user.click(within(policy).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Backup policy saved")).toBeInTheDocument();
    expect(db.data.policies[0]).toMatchObject({ schedule: "30 1 * * *", keep_last: 14 });
  });

  it("restores in place after the typed slug, asking for a fresh sign-in when needed", async () => {
    db.data.knobs.reauthRequired = true;
    const { user } = await openService("backups");
    const table = await screen.findByRole("table", { name: "Backups" });
    await user.click(within(table).getAllByRole("button", { name: "Restore" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Restore postgres?" });
    await user.click(within(dialog).getByRole("radio", { name: /postgres, in place/ }));
    const confirm = within(dialog).getByRole("button", { name: "Restore in place" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), "postgres");
    await user.click(confirm);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Confirm your password to continue Sign in again, then retry.",
    );
    db.data.knobs.reauthRequired = false;
    await user.click(confirm);
    expect(await screen.findByText("Restore started")).toBeInTheDocument();
    expect(await screen.findByText(/Restor(e queued|ing…|e finished)/)).toBeInTheDocument();
    expect(db.data.restores).toHaveLength(1);
    expect(db.data.restores[0]).toMatchObject({
      backup_id: DATA_SEED.manualBackup,
      mode: "in_place",
      safety_backup_id: expect.any(String),
    });
  });

  it("downloads a backup through a presigned link", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { user } = await openService("backups");
    const table = await screen.findByRole("table", { name: "Backups" });
    await user.click(within(table).getAllByRole("button", { name: /^Download backup/ })[0]!);
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        expect.stringContaining(DATA_SEED.manualBackup),
        "_blank",
        "noopener,noreferrer",
      ),
    );
    open.mockRestore();
  });

  it("says when backup storage isn't configured and links admins to it", async () => {
    db.data.storage = null;
    await openService("backups");
    const notice = (await screen.findByText(/nothing can be backed up yet/)).closest(
      "[role=status]",
    ) as HTMLElement;
    expect(within(notice).getByRole("link", { name: "Set up storage" })).toHaveAttribute(
      "href",
      `/w/${WORKSPACE_ID}/platform#backup-storage`,
    );
  });

  it("shows the notice to others once an action answers backup_storage_not_configured", async () => {
    db.data.storage = null;
    signInAs(USERS.member.id);
    const { user } = await openService("backups");
    await user.click(await screen.findByRole("button", { name: "Back up now" }));
    expect(await screen.findByText("Could not start a backup")).toBeInTheDocument();
    expect(screen.getByText(/nothing can be backed up yet/)).toBeInTheDocument();
    expect(screen.getByText("An instance admin can set a bucket.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore" })).not.toBeInTheDocument();
  });
});

describe("data browser", () => {
  it("pages through a table's rows and copies them as CSV", async () => {
    const { user } = await openService("data");
    const schema = await screen.findByRole("navigation", { name: "Schema" });
    const tables = await within(schema).findByRole("list", { name: "Tables in public" });
    await user.click(within(tables).getByRole("button", { name: "customers" }));
    const grid = await screen.findByRole("table", { name: "public.customers rows" });
    expect(within(grid).getAllByRole("row")).toHaveLength(101);
    expect(screen.getByText("Rows 1–100")).toBeInTheDocument();
    expect(screen.getByText("truncated")).toBeInTheDocument();
    expect(within(grid).getAllByText("NULL").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Rows 101–200")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("Rows 201–240")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await user.click(screen.getByRole("button", { name: "Copy as CSV" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toMatch(
      /^id,email,name,credit_cents,created_at\r\n201,/,
    );
    expect(db.audit.some((row) => row.action === "database.browser_opened")).toBe(true);
  });

  it("runs read-only queries and shows engine errors", async () => {
    const { user } = await openService("data");
    await screen.findByRole("navigation", { name: "Schema" });
    await user.click(screen.getByRole("radio", { name: "Query" }));
    const box = screen.getByLabelText("Read-only query");
    await user.type(box, "SELECT * FROM orders");
    await user.click(screen.getByRole("button", { name: "Run" }));
    const grid = await screen.findByRole("table", { name: "Query result" });
    expect(within(grid).getAllByRole("row")).toHaveLength(13);
    expect(screen.getByText("12 rows")).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, "DELETE FROM orders{Control>}{Enter}{/Control}");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "cannot execute DELETE in a read-only transaction",
    );
    expect(screen.queryByRole("radio", { name: /Write/ })).not.toBeInTheDocument();
  });

  it("explains a database that isn't running", async () => {
    for (const row of db.deploy.deployments) {
      if (row.service_id === DB) row.status = "removed";
    }
    await openService("data");
    expect(await screen.findByText("The database isn't running here")).toBeInTheDocument();
  });

  it("refuses viewers who open the URL directly", async () => {
    signInAs(USERS.viewer.id);
    await openService("data");
    expect(await screen.findByText("You can't browse this database")).toBeInTheDocument();
  });
});

describe("backup storage settings", () => {
  it("keeps the secret write-only and saves a new bucket", async () => {
    const { user } = renderApp(`/w/${WORKSPACE_ID}/platform`);
    const form = await screen.findByRole("form", { name: "Backup storage" });
    expect(within(form).getByLabelText("Bucket")).toHaveValue("roundhouse-backups");
    const secret = within(form).getByLabelText("Secret access key");
    expect(secret).toHaveValue("");
    expect(within(form).getByText(/Leave empty to keep it/)).toBeInTheDocument();
    const bucket = within(form).getByLabelText("Bucket");
    await user.clear(bucket);
    await user.type(bucket, "Bad_Bucket");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(within(form).getByText("Enter an S3 bucket name.")).toBeInTheDocument();
    await user.clear(bucket);
    await user.type(bucket, "acme-backups");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Backup storage saved")).toBeInTheDocument();
    expect(db.data.storage).toMatchObject({
      bucket: "acme-backups",
      secret_access_key: "mock-secret-access-key",
    });
  });
});
