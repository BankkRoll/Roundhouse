import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DATA_SEED } from "../../mocks/data-db";
import { db, makeNode, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { servicePath } from "../../test/phase1";
import { findPageHeading, renderApp } from "../../test/render";

async function openSettings() {
  const app = renderApp(servicePath(DATA_SEED.database, "settings"));
  await findPageHeading("postgres");
  return { ...app, section: await screen.findByRole("region", { name: "Volume" }) };
}

/** The seed's heartbeat ages with the run; a stale one would read as offline. */
function addNbg() {
  db.nodes.find((node) => node.id === "node_hel1")!.last_heartbeat_at = Date.now();
  db.nodes.push({
    ...makeNode({ id: "node_nbg1", name: "nbg-1", hostname: "nbg-1.example.com" }),
    workspace_id: WORKSPACE_ID,
  });
}

const loseHel = () => {
  db.nodes.find((node) => node.id === "node_hel1")!.status = "offline";
};

describe("recovering a volume whose server is lost", () => {
  it("offers only a move while the server is online", async () => {
    addNbg();
    const { section } = await openSettings();
    expect(await within(section).findByRole("button", { name: "Move to server…" })).toBeVisible();
    expect(within(section).queryByRole("button", { name: /Recover/ })).toBeNull();
  });

  it("rebuilds the volume on the chosen server from the latest backup, saying what is lost", async () => {
    addNbg();
    loseHel();
    const { user, section } = await openSettings();
    expect(
      await within(section).findByText(/hel-1 is offline; the data can.t be read/),
    ).toBeVisible();
    expect(within(section).queryByRole("button", { name: "Move to server…" })).toBeNull();
    await user.click(
      await within(section).findByRole("button", { name: "Recover on another server…" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Recover postgres on another server?",
    });
    const nbg = await within(dialog).findByRole("radio", { name: /nbg-1/ });
    expect(nbg).toBeChecked();
    expect(within(dialog).queryByRole("radio", { name: /hel-1/ })).toBeNull();
    expect(within(dialog).getByRole("radio", { name: /fsn-1/ })).toBeDisabled();
    const note = within(dialog).getByRole("note");
    expect(note).toHaveTextContent(/Writes after .+ are lost/);
    const latest = db.data.backups
      .filter((b) => b.status === "succeeded")
      .sort((a, b) => b.created_at - a.created_at)[0]!;
    expect(note).toHaveTextContent(`Restores backup ${latest.id}`);

    const confirm = within(dialog).getByRole("button", { name: "Recover volume" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), "postgres");
    await user.click(confirm);

    expect(await screen.findByText("Recovering postgres")).toBeInTheDocument();
    expect(db.data.restores.at(-1)).toMatchObject({
      backup_id: latest.id,
      mode: "in_place",
      target_node_id: "node_nbg1",
      safety_backup_id: null,
    });
    expect(db.data.volumes.find((v) => v.id === DATA_SEED.volume)?.status).toBe("abandoned");
    expect(await within(section).findByRole("status")).toHaveTextContent(/onto nbg-1/);
    await waitFor(() => expect(within(section).getByText("nbg-1")).toBeInTheDocument());
    expect(within(section).queryByRole("button", { name: /Recover/ })).toBeNull();
  });

  it("is not offered to members who can't restore backups", async () => {
    addNbg();
    loseHel();
    signInAs(USERS.member.id);
    const { section } = await openSettings();
    await within(section).findByText(/hel-1 is offline/);
    expect(within(section).queryByRole("button", { name: /Recover/ })).toBeNull();
  });
});
