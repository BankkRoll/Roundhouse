import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DATA_SEED } from "../../mocks/data-db";
import { db, makeNode, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { servicePath } from "../../test/phase1";
import { findPageHeading, renderApp } from "../../test/render";
import { isAllowlistEntry, parseAllowlist } from "./allowlist";
import { enginePrincipals } from "./credential-rotation";
import { defaultRestoreSlug, variableReference } from "./database-meta";

const DB = DATA_SEED.database;

async function openService(tab: string) {
  const app = renderApp(servicePath(DB, tab));
  await findPageHeading("postgres");
  return app;
}

describe("allowlist parsing", () => {
  it("accepts IPv4 and IPv6 addresses and blocks, and flags open ones", () => {
    for (const entry of ["203.0.113.7", "10.0.0.0/8", "2001:db8::/48", "::1", "::ffff:1.2.3.4"]) {
      expect(isAllowlistEntry(entry)).toBe(true);
    }
    for (const entry of ["10.0.0.0/33", "256.1.1.1", "2001:db8::/129", "1::2::3", "host", ""]) {
      expect(isAllowlistEntry(entry)).toBe(false);
    }
    expect(parseAllowlist("203.0.113.7, 10.0.0.0/8\n203.0.113.7\nnope")).toEqual({
      entries: ["203.0.113.7", "10.0.0.0/8", "nope"],
      invalid: ["nope"],
      open: false,
      error: null,
    });
    expect(parseAllowlist("::/0").open).toBe(true);
    expect(parseAllowlist(" \n").error).toMatch(/at least one/);
  });

  it("names the restored copy and the principals as the API does", () => {
    expect(defaultRestoreSlug("db", Date.UTC(2026, 9, 27))).toBe("db-restore-20261027");
    expect(enginePrincipals("postgres")).toEqual(["admin", "readonly"]);
    expect(enginePrincipals("mysql")).toEqual(["admin", "app", "readonly"]);
  });
});

describe("restoring into a new service", () => {
  it("is the default, shows the default name, then follows the restore to the new service", async () => {
    const { user } = await openService("backups");
    const table = await screen.findByRole("table", { name: "Backups" });
    await user.click(within(table).getAllByRole("button", { name: "Restore" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Restore postgres?" });
    expect(within(dialog).getByRole("radio", { name: /A new service/ })).toBeChecked();
    const slug = within(dialog).getByLabelText("New service slug");
    expect(slug).toHaveAttribute("placeholder", defaultRestoreSlug("postgres", Date.now()));
    await user.type(slug, "Bad Slug");
    expect(within(dialog).getByText(/Lowercase letters, digits and dashes/)).toBeInTheDocument();
    await user.clear(slug);
    await user.type(within(dialog).getByLabelText(/to confirm/), "postgres");
    await user.click(within(dialog).getByRole("button", { name: "Restore into a new service" }));

    expect(await screen.findByText("Restore started")).toBeInTheDocument();
    const restore = db.data.restores[0]!;
    expect(restore).toMatchObject({ mode: "new_service", safety_backup_id: null });
    const created = db.deploy.services.find((row) => row.id === restore.target_service_id)!;
    expect(created.slug).toBe(defaultRestoreSlug("postgres", Date.now()));
    const link = await screen.findByRole("link", { name: `Open ${created.name}` });
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining(`/s/${restore.target_service_id}`),
    );
    expect(screen.getByText(/Restor(e queued|ing into|ed into)/)).toBeInTheDocument();
  });

  it("shows why a new service is refused, and keeps in place as the alternative", async () => {
    db.data.backups.find((row) => row.id === DATA_SEED.manualBackup)!.method = "snapshot";
    const { user } = await openService("backups");
    const table = await screen.findByRole("table", { name: "Backups" });
    await user.click(within(table).getAllByRole("button", { name: "Restore" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Restore postgres?" });
    expect(within(dialog).getByRole("radio", { name: /A new service/ })).toBeDisabled();
    expect(within(dialog).getByText(/Only a dump can go into a new service/)).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /in place/ })).toBeChecked();
    expect(within(dialog).getByLabelText(/Skip the safety backup/)).toBeInTheDocument();
  });
});

describe("moving a volume", () => {
  it("lists targets with reasons, warns about downtime, and follows the move phase by phase", async () => {
    db.nodes.push({
      ...makeNode({ id: "node_nbg1", name: "nbg-1", hostname: "nbg-1.example.com" }),
      workspace_id: WORKSPACE_ID,
    });
    const { user, queryClient } = await openService("settings");
    const section = await screen.findByRole("region", { name: "Volume" });
    await user.click(await within(section).findByRole("button", { name: "Move to server…" }));
    const dialog = await screen.findByRole("dialog", { name: "Move postgres's volume?" });
    const nbg = await within(dialog).findByRole("radio", { name: /nbg-1/ });
    expect(nbg).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /hel-1/ })).toBeDisabled();
    expect(within(dialog).getByText("It already holds the volume")).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /fsn-1/ })).toBeDisabled();
    expect(within(dialog).getByText("It isn't online")).toBeInTheDocument();
    expect(within(dialog).getByText("postgres is stopped for the whole copy")).toBeInTheDocument();
    expect(within(dialog).getByText(/Expected downtime: about/)).toHaveTextContent(/\d+m/);

    const confirm = within(dialog).getByRole("button", { name: "Move volume" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), "postgres");
    await user.click(confirm);
    expect(await screen.findByText("Moving postgres's volume")).toBeInTheDocument();
    expect(db.data.migrations[0]).toMatchObject({ target_node_id: "node_nbg1" });

    const progress = await within(section).findByRole("list", { name: "Move progress" });
    expect(within(progress).getAllByRole("listitem")).toHaveLength(5);
    expect(await within(section).findByText("Moving")).toBeInTheDocument();
    expect(within(section).getByLabelText("Size (GiB)")).toBeDisabled();
    expect(within(section).queryByRole("button", { name: "Delete volume" })).toBeNull();
    expect(within(section).queryByRole("button", { name: "Move to server…" })).toBeNull();

    await waitFor(async () => {
      await queryClient.refetchQueries({ queryKey: ["volume-migrations"] });
      expect(db.data.migrations[0]!.status).toBe("succeeded");
    });
    expect(await within(section).findByText(/postgres runs on nbg-1/)).toBeInTheDocument();
    await waitFor(() => expect(within(section).getByText("nbg-1")).toBeInTheDocument());
    expect(db.data.volumes[0]).toMatchObject({ node_id: "node_nbg1", status: "ready" });
  });

  it("explains a rolled-back move and lists it among the recent moves", async () => {
    db.nodes.push({
      ...makeNode({ id: "node_nbg1", name: "nbg-1" }),
      workspace_id: WORKSPACE_ID,
    });
    db.data.migrations.push({
      id: "mig_old",
      volume_id: DATA_SEED.volume,
      service_id: DB,
      environment_id: "env_store_prod",
      source_node_id: "node_hel1",
      target_node_id: "node_nbg1",
      status: "failed",
      phase: "rolling_back",
      backup_id: null,
      deployment_id: null,
      copied_bytes: null,
      error: "The copy on the target didn't match its SHA-256",
      requested_by: USERS.owner.id,
      cleanup_after: null,
      started_at: Date.now() - 600_000,
      finished_at: Date.now() - 540_000,
      created_at: Date.now() - 600_000,
    });
    await openService("settings");
    const section = await screen.findByRole("region", { name: "Volume" });
    const moves = await within(section).findByRole("list", { name: "Recent moves" });
    expect(moves).toHaveTextContent(/hel-1 → nbg-1.*SHA-256.*Failed/);
  });

  it("hides the move from viewers", async () => {
    signInAs(USERS.viewer.id);
    await openService("settings");
    const section = await screen.findByRole("region", { name: "Volume" });
    await within(section).findByText("hel-1");
    expect(within(section).queryByRole("button", { name: "Move to server…" })).toBeNull();
  });
});

describe("TCP proxy", () => {
  it("is off by default, warns, needs an acknowledgement for an open list, and publishes", async () => {
    db.data.knobs.reauthRequired = true;
    const { user } = await openService("settings");
    const section = await screen.findByRole("region", { name: "TCP proxy" });
    const toggle = await within(section).findByRole("switch", { name: "Public TCP port" });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    const form = within(section).getByRole("form", { name: "TCP allowlist" });
    expect(
      within(form).getByText("This port becomes reachable from the internet"),
    ).toBeInTheDocument();
    expect(
      within(form).getByText(/unencrypted unless the client and the database/),
    ).toBeInTheDocument();

    const field = within(form).getByLabelText("Allowed sources");
    await user.type(field, "nope{Enter}0.0.0.0/0");
    await user.click(within(form).getByRole("button", { name: "Publish port" }));
    expect(within(form).getByText("Not an address or CIDR block: nope")).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, "0.0.0.0/0{Enter}2001:db8::/48");
    await user.click(within(form).getByRole("button", { name: "Publish port" }));
    expect(within(form).getByRole("alert")).toHaveTextContent(/Confirm that the port is open/);
    await user.click(within(form).getByLabelText(/opens the port to every address/));
    await user.click(within(form).getByRole("button", { name: "Publish port" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent(/Sign in again, then retry/);

    db.data.knobs.reauthRequired = false;
    await user.click(within(form).getByRole("button", { name: "Publish port" }));
    expect(await screen.findByText("Publishing postgres on port 24101")).toBeInTheDocument();
    expect(db.data.tcpProxies[0]).toMatchObject({
      allowed_cidrs: ["0.0.0.0/0", "2001:db8::/48"],
    });
    expect(await within(section).findByText("hel-1.example.com:24101")).toBeInTheDocument();
    expect(within(section).getByRole("button", { name: "Copy Endpoint" })).toBeInTheDocument();
    expect(within(section).getByText("Open to the internet")).toBeInTheDocument();
    expect(
      within(section).getByText(variableReference("postgres", "DATABASE_PUBLIC_URL")),
    ).toBeInTheDocument();
    expect(within(section).getByRole("switch", { name: "Public TCP port" })).toBeChecked();
  });

  it("says when the agent can't enforce an allowlist, and turns the port off", async () => {
    db.data.tcpProxies.push({
      id: "tcp_1",
      service_id: DB,
      environment_id: "env_store_prod",
      container_port: 5432,
      public_port: 24101,
      allowed_cidrs: ["203.0.113.7/32"],
      host: null,
      node_id: null,
      status: "pending",
      open_to_all: false,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    db.data.knobs.tcpProxyUnsupported = true;
    const { user } = await openService("settings");
    const section = await screen.findByRole("region", { name: "TCP proxy" });
    expect(
      await within(section).findByText(/can't enforce a source allowlist/),
    ).toBeInTheDocument();
    expect(within(section).getByRole("list", { name: "Allowed sources" })).toHaveTextContent(
      "203.0.113.7/32",
    );
    await user.click(within(section).getByRole("switch", { name: "Public TCP port" }));
    const dialog = await screen.findByRole("dialog", { name: "Stop publishing this port?" });
    await user.click(within(dialog).getByRole("button", { name: "Stop publishing" }));
    expect(await screen.findByText("TCP port closed")).toBeInTheDocument();
    expect(db.data.tcpProxies).toHaveLength(0);
    expect(within(section).getByRole("switch", { name: "Public TCP port" })).not.toBeChecked();
  });
});

describe("credential rotation", () => {
  it("rotates the engine's principals after the typed slug and lists the result", async () => {
    const { user } = await openService("settings");
    const section = await screen.findByRole("region", { name: "Database" });
    await user.click(within(section).getByRole("button", { name: "Rotate credentials…" }));
    const dialog = await screen.findByRole("dialog", { name: "Rotate postgres's credentials?" });
    expect(within(dialog).getByLabelText(/Admin/)).toBeChecked();
    expect(within(dialog).getByLabelText(/Read-only/)).toBeChecked();
    expect(within(dialog).queryByLabelText(/App user/)).toBeNull();
    expect(
      within(dialog).getByText(/are redeployed, so each restarts briefly/),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByLabelText(/Read-only/));
    await user.type(within(dialog).getByLabelText(/to confirm/), "postgres");
    await user.click(within(dialog).getByRole("button", { name: "Rotate and redeploy" }));

    expect(await screen.findByText("Credentials rotated")).toBeInTheDocument();
    expect(db.data.rotations[0]).toMatchObject({ principals: ["admin"], status: "succeeded" });
    const list = await within(section).findByRole("list", { name: "Recent rotations" });
    expect(list).toHaveTextContent(/admin.*redeploy.*Rotated/);
  });

  it("offers to finish a rotation that was interrupted", async () => {
    db.data.knobs.interruptRotation = true;
    const { user } = await openService("settings");
    const section = await screen.findByRole("region", { name: "Database" });
    await user.click(within(section).getByRole("button", { name: "Rotate credentials…" }));
    let dialog = await screen.findByRole("dialog", { name: "Rotate postgres's credentials?" });
    await user.type(within(dialog).getByLabelText(/to confirm/), "postgres");
    await user.click(within(dialog).getByRole("button", { name: "Rotate and redeploy" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/next request finishes it/);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(await within(section).findByText("A rotation didn't finish")).toBeInTheDocument();
    await user.click(within(section).getByRole("button", { name: "Finish rotation" }));
    dialog = await screen.findByRole("dialog", {
      name: "Finish rotating postgres's credentials?",
    });
    await user.type(within(dialog).getByLabelText(/to confirm/), "postgres");
    await user.click(within(dialog).getByRole("button", { name: "Finish rotation" }));
    expect(await screen.findByText("Credentials rotated")).toBeInTheDocument();
    expect(db.data.rotations).toHaveLength(1);
    expect(db.data.rotations[0]).toMatchObject({
      status: "succeeded",
      applied: ["readonly", "admin"],
    });
    await waitFor(() =>
      expect(within(section).queryByText("A rotation didn't finish")).not.toBeInTheDocument(),
    );
  });

  it("is not offered to members, who can't write data", async () => {
    signInAs(USERS.member.id);
    await openService("settings");
    const section = await screen.findByRole("region", { name: "Database" });
    expect(within(section).queryByRole("button", { name: "Rotate credentials…" })).toBeNull();
  });
});
