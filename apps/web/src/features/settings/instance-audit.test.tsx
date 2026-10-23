import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { recordAudit } from "../../mocks/common";
import { db, PASSWORD, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { findPageHeading, renderApp } from "../../test/render";

const PAGE = `/w/${WORKSPACE_ID}/instance-audit`;
const PLATFORM = `/w/${WORKSPACE_ID}/platform`;

function seedInstanceEntries() {
  recordAudit({
    workspaceId: null,
    actorType: "user",
    actorId: USERS.owner.id,
    action: "instance.settings_updated",
    targetType: "instance",
    targetId: "instance",
  });
  recordAudit({
    workspaceId: null,
    actorType: "user",
    actorId: USERS.owner.id,
    action: "auth.reauthenticated",
    targetType: "session",
    targetId: "session",
  });
}

describe("instance audit log", () => {
  it("lists instance-level entries only, filters by action, and verifies the chain", async () => {
    seedInstanceEntries();
    const { user } = renderApp(PAGE);
    await findPageHeading("Instance audit log");
    const table = await screen.findByRole("table");
    await waitFor(() => expect(within(table).getAllByRole("row")).toHaveLength(3));
    expect(table).toHaveTextContent("auth.reauthenticated");
    expect(table).toHaveTextContent("instance.settings_updated");
    // Workspace entries stay in the workspace's own log.
    expect(table).not.toHaveTextContent("workspace.created");

    await user.selectOptions(screen.getByLabelText("Action"), "auth.reauthenticated");
    await waitFor(() =>
      expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2),
    );

    await user.click(screen.getByRole("button", { name: "Verify chain" }));
    expect(await screen.findByRole("status")).toHaveTextContent(/Chain intact/);
  });

  it("is listed under Instance settings for instance admins only", async () => {
    renderApp(PLATFORM);
    const nav = await screen.findByRole("navigation", { name: "Settings" });
    expect(within(nav).getByRole("link", { name: "Instance audit log" })).toHaveAttribute(
      "href",
      PAGE,
    );
  });

  it("tells workspace admins it isn't theirs", async () => {
    signInAs(USERS.admin.id);
    renderApp(PAGE);
    expect(
      await screen.findByRole("heading", { name: "The instance audit log is for instance admins" }),
    ).toBeInTheDocument();
    const nav = await screen.findByRole("navigation", { name: "Settings" });
    expect(within(nav).queryByRole("link", { name: "Instance audit log" })).not.toBeInTheDocument();
  });
});

describe("re-authentication prompt", () => {
  it("asks for the password when the session is stale, then retries the change", async () => {
    db.sessionStale = true;
    const { user } = renderApp(PLATFORM);
    await user.click(await screen.findByRole("switch", { name: "Allow coding agents" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.type(within(dialog).getByLabelText("Password"), "wrong password");
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(await within(dialog).findByText("Incorrect password")).toBeInTheDocument();
    expect(db.deploy.instance.mcp_enabled).toBe(false);

    await user.clear(within(dialog).getByLabelText("Password"));
    await user.type(within(dialog).getByLabelText("Password"), PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText("MCP enabled")).toBeInTheDocument();
    expect(db.deploy.instance.mcp_enabled).toBe(true);
    expect(db.sessionStale).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Confirm it's you" })).not.toBeInTheDocument();
  });

  it("leaves the change undone when the prompt is cancelled", async () => {
    db.sessionStale = true;
    const { user } = renderApp(PLATFORM);
    await user.click(await screen.findByRole("switch", { name: "Allow coding agents" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Confirm your password/);
    expect(db.deploy.instance.mcp_enabled).toBe(false);
  });
});
