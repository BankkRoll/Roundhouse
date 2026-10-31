import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import type { RecoveryPolicy } from "../../lib/api/backups-client";
import type { DbAbandonedCopy } from "../../mocks/data-db";
import { DATA_SEED } from "../../mocks/data-db";
import { db, makeNode, PASSWORD, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { SEED, servicePath } from "../../test/phase1";
import { findPageHeading, renderApp } from "../../test/render";

const HOUR = 3_600_000;

async function openVolume() {
  const app = renderApp(servicePath(DATA_SEED.database, "settings"));
  await findPageHeading("postgres");
  const section = await screen.findByRole("region", { name: "Volume" });
  return { ...app, section };
}

function addNode(id: string, name: string, status: "online" | "offline") {
  db.nodes.push({
    ...makeNode({ id, name, hostname: `${name}.example.com`, status }),
    workspace_id: WORKSPACE_ID,
  });
}

function savePolicy(fields: Partial<RecoveryPolicy>) {
  db.data.recoveryPolicies.push({
    id: "rcp_postgres",
    service_id: DATA_SEED.database,
    environment_id: SEED.production,
    enabled: true,
    grace_minutes: 30,
    enabled_by: USERS.owner.id,
    status: "idle",
    message: null,
    lost_node_id: null,
    restore_id: null,
    triggered_at: null,
    updated_at: Date.now(),
    ...fields,
  });
}

// NOTE: The seeded heartbeat ages with the run, and a silent server reads as offline.
beforeEach(() => {
  db.nodes.find((node) => node.id === "node_hel1")!.last_heartbeat_at = Date.now();
});

describe("automatic recovery", () => {
  it("is off by default and turns on with a grace period after confirming the password", async () => {
    db.sessionStale = true;
    const { user, section } = await openVolume();
    const form = await within(section).findByRole("form", { name: "Automatic recovery" });
    expect(within(section).getByText("Off")).toBeInTheDocument();
    expect(
      within(section).getByText("A lost server's volume is only recovered when someone starts it."),
    ).toBeInTheDocument();
    const toggle = within(form).getByRole("switch", { name: "Automatic recovery" });
    expect(toggle).not.toBeChecked();
    expect(toggle).toHaveAccessibleDescription(/rebuilt on another server from the latest backup/);
    expect(within(form).getByLabelText("Grace period")).toHaveValue("30");
    expect(within(form).getByLabelText("Grace period unit")).toHaveValue("minutes");

    await user.click(toggle);
    const grace = within(form).getByLabelText("Grace period");
    await user.clear(grace);
    await user.type(grace, "2");
    await user.selectOptions(within(form).getByLabelText("Grace period unit"), "hours");
    await user.click(within(form).getByRole("button", { name: "Save" }));

    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.type(within(reauth).getByLabelText("Password"), PASSWORD);
    await user.click(within(reauth).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("Automatic recovery on")).toBeInTheDocument();
    expect(db.data.recoveryPolicies[0]).toMatchObject({
      enabled: true,
      grace_minutes: 120,
      enabled_by: USERS.owner.id,
    });
    expect(await within(section).findByText("Standing by")).toBeInTheDocument();
    expect(
      within(section).getByText(
        "hel-1 is online. If it stays offline for 2 hours, recovery starts on its own.",
      ),
    ).toBeInTheDocument();
    expect(db.audit.at(-1)).toMatchObject({ action: "recovery.policy_updated" });
  });

  it("keeps it off when the password prompt is cancelled, and says why", async () => {
    db.sessionStale = true;
    const { user, section } = await openVolume();
    const form = await within(section).findByRole("form", { name: "Automatic recovery" });
    await user.click(within(form).getByRole("switch", { name: "Automatic recovery" }));
    await user.click(within(form).getByRole("button", { name: "Save" }));
    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.click(within(reauth).getByRole("button", { name: "Cancel" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "Confirm your password to continue Sign in again, then retry.",
    );
    expect(db.data.recoveryPolicies).toHaveLength(0);
  });

  it("checks the grace period is from 5 minutes to 7 days", async () => {
    const { user, section } = await openVolume();
    const form = await within(section).findByRole("form", { name: "Automatic recovery" });
    const grace = within(form).getByLabelText("Grace period");
    await user.clear(grace);
    await user.type(grace, "4");
    const error = "Enter a whole number from 5 minutes to 7 days.";
    expect(within(form).getByText(error)).toBeInTheDocument();
    expect(grace).toHaveAttribute("aria-invalid", "true");
    expect(grace).toHaveAccessibleDescription(error);
    await user.clear(grace);
    await user.type(grace, "8");
    await user.selectOptions(within(form).getByLabelText("Grace period unit"), "days");
    expect(within(form).getByText(error)).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(db.data.recoveryPolicies).toHaveLength(0);
    await user.clear(grace);
    await user.type(grace, "7");
    expect(within(form).queryByText(error)).toBeNull();
  });

  it("shows a server being watched with the time recovery starts", async () => {
    savePolicy({});
    const hel = db.nodes.find((node) => node.id === "node_hel1")!;
    hel.status = "offline";
    const { section } = await openVolume();
    expect(await within(section).findByText("Server offline")).toBeInTheDocument();
    expect(
      within(section).getByText(
        /^hel-1 is offline\. Recovery starts in \d+ minutes \(.+\) unless it comes back\.$/,
      ),
    ).toBeInTheDocument();
  });

  it("says in words why it is blocked or failed", async () => {
    savePolicy({
      status: "blocked",
      message: "The service has no succeeded backup to recover from",
      lost_node_id: "node_hel1",
    });
    db.nodes.find((node) => node.id === "node_hel1")!.status = "offline";
    const { section } = await openVolume();
    expect(await within(section).findByText("Blocked")).toBeInTheDocument();
    expect(
      within(section).getByText(
        "Can't recover: The service has no succeeded backup to recover from. It is retried every minute while hel-1 stays offline.",
      ),
    ).toBeInTheDocument();
  });

  it("reports a failed recovery with its error", async () => {
    savePolicy({
      status: "failed",
      message: "pg_restore exited 1",
      lost_node_id: "node_hel1",
      triggered_at: Date.now() - HOUR,
    });
    const { section } = await openVolume();
    expect(await within(section).findByText("Failed")).toBeInTheDocument();
    expect(
      within(section).getByText(/^The last automatic recovery failed: pg_restore exited 1\./),
    ).toBeInTheDocument();
  });

  it("follows an automatic recovery through to recovered", async () => {
    savePolicy({ grace_minutes: 5 });
    addNode("node_nbg1", "nbg-1", "online");
    const hel = db.nodes.find((node) => node.id === "node_hel1")!;
    hel.status = "offline";
    hel.last_heartbeat_at = Date.now() - 6 * 60_000;
    const { section } = await openVolume();
    expect(await within(section).findByText("Recovering")).toBeInTheDocument();
    expect(
      within(section).getByText(/^hel-1 went offline, so the volume is being rebuilt/),
    ).toBeInTheDocument();
    expect(db.data.restores.at(-1)).toMatchObject({ trigger: "automatic" });
    await waitFor(() => expect(within(section).getByText("Recovered")).toBeInTheDocument(), {
      timeout: 15_000,
    });
    expect(
      within(section).getByText(/^Recovered automatically .+ after hel-1 went offline/),
    ).toBeVisible();
  }, 30_000);

  it("is read-only with a locked button for those who can't recover", async () => {
    savePolicy({ grace_minutes: 1_440 });
    signInAs(USERS.member.id);
    const { section } = await openVolume();
    const form = await within(section).findByRole("form", { name: "Automatic recovery" });
    expect(within(form).queryByRole("switch")).toBeNull();
    expect(within(form).getByText("1 day")).toBeInTheDocument();
    const button = within(form).getByRole("button", { name: "Turn off" });
    expect(button).toBeDisabled();
    expect(button.parentElement).toHaveAccessibleDescription(
      "Automatic recovery needs permission to restore backups. Ask a project admin for more access.",
    );
    expect(within(section).getByText("Standing by")).toBeInTheDocument();
  });

  it("shows viewers the setting without controls", async () => {
    signInAs(USERS.viewer.id);
    const { section } = await openVolume();
    const form = await within(section).findByRole("form", { name: "Automatic recovery" });
    expect(within(form).getByRole("button", { name: "Turn on" })).toBeDisabled();
    expect(within(form).queryByRole("textbox")).toBeNull();
    expect(within(section).getByText("Off")).toBeInTheDocument();
  });
});

describe("abandoned copies", () => {
  function copy(fields: Partial<DbAbandonedCopy> & Pick<DbAbandonedCopy, "volume_id">) {
    db.data.abandonedCopies.push({
      service_id: DATA_SEED.database,
      environment_id: SEED.production,
      node_id: null,
      node_name: null,
      size_mb: 5120,
      used_bytes: 1_288 * 1024 * 1024,
      abandoned_at: Date.now() - 3 * HOUR,
      delete_after: Date.now() + 69 * HOUR,
      delete_sent_at: null,
      cleaned_at: null,
      ...fields,
    });
  }

  it("lists nothing while there are none", async () => {
    const { section } = await openVolume();
    await within(section).findByRole("form", { name: "Automatic recovery" });
    expect(within(section).queryByRole("list", { name: "Abandoned copies" })).toBeNull();
  });

  it("lists each server's copy with where its cleanup stands, in words", async () => {
    addNode("node_old1", "old-1", "online");
    addNode("node_lost2", "lost-2", "offline");
    addNode("node_gone3", "gone-3", "online");
    addNode("node_slow4", "slow-4", "offline");
    db.data.restores.push({
      id: "rst_recovered",
      trigger: "manual",
      target_time: null,
      backup_id: DATA_SEED.scheduledBackup,
      mode: "in_place",
      target_service_id: DATA_SEED.database,
      target_environment_id: SEED.production,
      safety_backup_id: null,
      target_node_id: "node_hel1",
      status: "succeeded",
      error: null,
      requested_by: USERS.owner.id,
      started_at: Date.now() - 2 * HOUR,
      finished_at: Date.now() - 2 * HOUR,
      created_at: Date.now() - 2 * HOUR,
    });
    copy({ volume_id: "vol_old1", node_id: "node_old1", node_name: "old-1" });
    copy({ volume_id: "vol_lost2", node_id: "node_lost2", node_name: "lost-2" });
    copy({
      volume_id: "vol_gone3",
      node_id: "node_gone3",
      node_name: "gone-3",
      delete_sent_at: Date.now() - HOUR,
      cleaned_at: Date.now() - HOUR,
    });
    copy({
      volume_id: "vol_slow4",
      node_id: "node_slow4",
      node_name: "slow-4",
      delete_sent_at: Date.now() - 10 * 60_000,
    });
    const { section } = await openVolume();
    const list = await within(section).findByRole("list", { name: "Abandoned copies" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    const item = (name: string) => items.find((row) => row.textContent?.startsWith(name))!;
    expect(item("old-1")).toHaveTextContent("Waiting for grace period");
    expect(item("old-1")).toHaveTextContent(/Deleted in 2 days, once the grace period ends/);
    expect(item("old-1")).toHaveTextContent(/1\.3 GB, left 3h ago/);
    expect(item("lost-2")).toHaveTextContent("Waiting for server");
    expect(item("lost-2")).toHaveTextContent(
      "lost-2 is offline; the copy is deleted once it is back",
    );
    expect(item("gone-3")).toHaveTextContent("Deleted");
    expect(item("gone-3")).toHaveTextContent("Removed from gone-3 1h ago.");
    expect(item("slow-4")).toHaveTextContent("Cleanup requested");
    expect(item("slow-4")).toHaveTextContent(
      /Delete sent to slow-4 10m ago; waiting for it to confirm/,
    );
  });

  it("says why a copy is kept", async () => {
    addNode("node_old1", "old-1", "online");
    copy({ volume_id: "vol_old1", node_id: "node_old1", node_name: "old-1" });
    signInAs(USERS.viewer.id);
    const { section } = await openVolume();
    const list = await within(section).findByRole("list", { name: "Abandoned copies" });
    expect(within(list).getByText("Kept")).toBeInTheDocument();
    expect(
      within(list).getByText(/No restore into the replacement volume has succeeded/),
    ).toBeInTheDocument();
  });
});
