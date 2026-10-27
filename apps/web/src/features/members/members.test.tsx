import type { Role } from "@roundhouse/shared";
import { screen, waitFor, within } from "@testing-library/react";
import { http } from "msw";
import { describe, expect, it } from "vitest";
import { db, PASSWORD, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { apiError } from "../../mocks/handlers";
import { server } from "../../mocks/server";
import { renderApp } from "../../test/render";

const MEMBERS = `/w/${WORKSPACE_ID}/members`;

function rowFor(name: string) {
  const [membersTable] = screen.getAllByRole("table");
  const row = within(membersTable as HTMLElement)
    .getByText(name)
    .closest("tr");
  if (!row) throw new Error(`No row for ${name}`);
  return within(row);
}

async function renderAs(role: Role) {
  signInAs(USERS[role].id);
  const utils = renderApp(MEMBERS);
  await screen.findByRole("navigation", { name: "Settings" });
  return utils;
}

describe("members page permission gating", () => {
  it("gives owners every control, including owner rows other than their own", async () => {
    await renderAs("owner");
    await screen.findByText("Bob Builder");
    expect(screen.getByRole("button", { name: "Invite member" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Role for Bob Builder" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Bob Builder" })).toBeInTheDocument();
    expect(rowFor("Ada Lovelace").queryByRole("combobox")).not.toBeInTheDocument();
    expect(rowFor("Ada Lovelace").getByText("(you)")).toBeInTheDocument();
    expect(await screen.findByText("erin@example.com")).toBeInTheDocument();
    const roleSelect = screen.getByRole("combobox", { name: "Role for Cara Mel" });
    expect(within(roleSelect).getByRole("option", { name: "Owner" })).not.toBeDisabled();
  });

  it("lets admins manage but not grant or touch ownership", async () => {
    await renderAs("admin");
    await screen.findByText("Cara Mel");
    expect(screen.getByRole("button", { name: "Invite member" })).toBeInTheDocument();
    expect(rowFor("Ada Lovelace").queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Ada Lovelace" })).not.toBeInTheDocument();
    expect(rowFor("Bob Builder").queryByRole("combobox")).not.toBeInTheDocument();
    const roleSelect = screen.getByRole("combobox", { name: "Role for Cara Mel" });
    expect(within(roleSelect).getByRole("option", { name: "Owner" })).toBeDisabled();
    expect(within(roleSelect).getByRole("option", { name: "Viewer" })).not.toBeDisabled();
  });

  it("shows members a read-only list without invites", async () => {
    await renderAs("member");
    await screen.findByText("Ada Lovelace");
    expect(screen.queryByRole("button", { name: "Invite member" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove / })).not.toBeInTheDocument();
    expect(screen.queryByText("Pending invites")).not.toBeInTheDocument();
    expect(rowFor("Ada Lovelace").getByText("Owner")).toBeInTheDocument();
  });

  it("hides the list from viewers without requesting it", async () => {
    let requested = false;
    server.use(
      http.get("*/v1/workspaces/:ws/members", () => {
        requested = true;
        return undefined;
      }),
    );
    await renderAs("viewer");
    expect(
      await screen.findByRole("heading", { name: "Members are hidden for your role" }),
    ).toBeInTheDocument();
    expect(requested).toBe(false);
    expect(screen.queryByRole("link", { name: "Members" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Audit log" })).not.toBeInTheDocument();
  });
});

describe("member management", () => {
  it("changes a role", async () => {
    const { user } = await renderAs("owner");
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Role for Cara Mel" }),
      "admin",
    );
    await waitFor(() =>
      expect(db.memberships.find((m) => m.id === "mem_member")?.role).toBe("admin"),
    );
    expect(await screen.findByText("Cara Mel is now admin")).toBeInTheDocument();
  });

  it("asks for the password before changing a role with a stale session, then retries", async () => {
    db.sessionStale = true;
    const { user } = await renderAs("owner");
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Role for Cara Mel" }),
      "viewer",
    );
    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(within(reauth).getByLabelText("Password")).toHaveFocus();
    await user.type(within(reauth).getByLabelText("Password"), PASSWORD);
    await user.click(within(reauth).getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(db.memberships.find((m) => m.id === "mem_member")?.role).toBe("viewer"),
    );
  });

  it("leaves the role unchanged when the password prompt is cancelled", async () => {
    db.sessionStale = true;
    const { user } = await renderAs("owner");
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Role for Cara Mel" }),
      "viewer",
    );
    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.click(within(reauth).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Could not change role")).toBeInTheDocument();
    expect(db.memberships.find((m) => m.id === "mem_member")?.role).toBe("member");
  });

  it("asks for the password before removing someone with a stale session", async () => {
    db.sessionStale = true;
    const { user } = await renderAs("owner");
    await user.click(await screen.findByRole("button", { name: "Remove Dan Viewer" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Dan Viewer?" });
    await user.click(within(dialog).getByRole("button", { name: "Remove member" }));
    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.type(within(reauth).getByLabelText("Password"), PASSWORD);
    await user.click(within(reauth).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(db.memberships.some((m) => m.id === "mem_viewer")).toBe(false));
  });

  it("reports a failed role change", async () => {
    server.use(
      http.patch("*/v1/workspaces/:ws/members/:id", () =>
        apiError(409, "last_owner", "A workspace needs an owner."),
      ),
    );
    const { user } = await renderAs("owner");
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Role for Bob Builder" }),
      "viewer",
    );
    expect(await screen.findByText("A workspace needs an owner.")).toBeInTheDocument();
  });

  it("removes a member after confirmation", async () => {
    const { user } = await renderAs("owner");
    await user.click(await screen.findByRole("button", { name: "Remove Dan Viewer" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Dan Viewer?" });
    await user.click(within(dialog).getByRole("button", { name: "Remove member" }));
    await waitFor(() => expect(screen.queryByText("Dan Viewer")).not.toBeInTheDocument());
    expect(db.memberships.some((m) => m.id === "mem_viewer")).toBe(false);
  });

  it("creates an invite and shows the link to share", async () => {
    const { user } = await renderAs("owner");
    await user.click(await screen.findByRole("button", { name: "Invite member" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite a member" });
    await user.click(within(dialog).getByRole("button", { name: "Create invite" }));
    expect(within(dialog).getByText("Enter a valid email address.")).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Email"), "Frank@Example.com");
    await user.selectOptions(within(dialog).getByLabelText("Role"), "viewer");
    await user.click(within(dialog).getByRole("button", { name: "Create invite" }));

    expect(await within(dialog).findByText(/\/invite#token=inv_\w+$/)).toBeInTheDocument();
    expect(within(dialog).getByText("frank@example.com")).toBeInTheDocument();
    expect(db.invites.at(-1)).toMatchObject({ email: "frank@example.com", role: "viewer" });

    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(await screen.findByText("frank@example.com")).toBeInTheDocument();
  });

  it("asks for the password before creating an invite with a stale session, then retries", async () => {
    db.sessionStale = true;
    const { user } = await renderAs("owner");
    await user.click(await screen.findByRole("button", { name: "Invite member" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite a member" });
    await user.type(within(dialog).getByLabelText("Email"), "frank@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Create invite" }));
    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(db.invites.some((i) => i.email === "frank@example.com")).toBe(false);
    await user.type(within(reauth).getByLabelText("Password"), PASSWORD);
    await user.click(within(reauth).getByRole("button", { name: "Confirm" }));
    expect(
      await within(await screen.findByRole("dialog", { name: "Invite a member" })).findByText(
        /\/invite#token=inv_\w+$/,
      ),
    ).toBeInTheDocument();
    expect(db.invites.filter((i) => i.email === "frank@example.com")).toHaveLength(1);
  });

  it("creates no invite when the password prompt is cancelled", async () => {
    db.sessionStale = true;
    const { user } = await renderAs("owner");
    await user.click(await screen.findByRole("button", { name: "Invite member" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite a member" });
    await user.type(within(dialog).getByLabelText("Email"), "frank@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Create invite" }));
    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.click(within(reauth).getByRole("button", { name: "Cancel" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/password/i);
    expect(db.invites.some((i) => i.email === "frank@example.com")).toBe(false);
  });

  it("shows API errors in the invite dialog, such as inviting an existing member", async () => {
    const { user } = await renderAs("admin");
    await user.click(await screen.findByRole("button", { name: "Invite member" }));
    const dialog = await screen.findByRole("dialog", { name: "Invite a member" });
    await user.type(within(dialog).getByLabelText("Email"), "Cara@example.com");
    await user.click(within(dialog).getByRole("button", { name: "Create invite" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "cara@example.com is already a member",
    );
  });

  it("lists only invites that are neither accepted nor expired", async () => {
    const now = Date.now();
    const base = db.invites[0];
    if (!base) throw new Error("seed changed");
    db.invites.push(
      { ...base, id: "inv_used", token: "inv_used", email: "used@example.com", accepted_at: now },
      { ...base, id: "inv_old", token: "inv_old", email: "old@example.com", expires_at: now - 1 },
    );
    await renderAs("owner");
    expect(await screen.findByText("erin@example.com")).toBeInTheDocument();
    expect(screen.queryByText("used@example.com")).not.toBeInTheDocument();
    expect(screen.queryByText("old@example.com")).not.toBeInTheDocument();
  });

  it("shows an error with retry when pending invites fail to load", async () => {
    let fail = true;
    server.use(
      http.get("*/v1/workspaces/:ws/invites", () =>
        fail ? apiError(500, "internal", "Invites unavailable") : undefined,
      ),
    );
    const { user } = await renderAs("owner");
    expect(await screen.findByText("Invites unavailable")).toBeInTheDocument();
    expect(screen.getByText("Could not load pending invites")).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("erin@example.com")).toBeInTheDocument();
  });

  it("revokes a pending invite", async () => {
    const { user } = await renderAs("owner");
    await user.click(
      await screen.findByRole("button", { name: "Revoke invite for erin@example.com" }),
    );
    await waitFor(() => expect(screen.queryByText("erin@example.com")).not.toBeInTheDocument());
    expect(db.invites).toHaveLength(0);
    expect(await screen.findByText("Invite revoked")).toBeInTheDocument();
  });
});
