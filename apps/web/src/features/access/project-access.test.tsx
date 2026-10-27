import type { Role } from "@roundhouse/shared";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ACCESS_SEED } from "../../mocks/access-db";
import { db, PASSWORD, signInAs, USERS } from "../../mocks/db";
import { PROJECT_PATH, SEED } from "../../test/phase1";
import { renderApp } from "../../test/render";

const ACCESS = `${PROJECT_PATH}/settings/access`;

function renderAs(role: Role, path = ACCESS) {
  signInAs(USERS[role].id);
  return renderApp(path);
}

function rowOf(table: HTMLElement, text: string) {
  const row = within(table).getByText(text).closest("tr");
  if (!row) throw new Error(`No row for ${text}`);
  return within(row);
}

describe("project access", () => {
  it("grants a team a role, changes it, and revokes it", async () => {
    const { user } = renderAs("owner");
    expect(
      await screen.findByText("No grants yet. Everyone has their default role."),
    ).toBeVisible();
    const form = screen.getByRole("form", { name: "Grant access" });
    await user.click(within(form).getByRole("button", { name: "Grant" }));
    expect(within(form).getByRole("alert")).toHaveTextContent("Choose a member or a team.");
    await user.selectOptions(
      within(form).getByLabelText("Member or team"),
      `team:${ACCESS_SEED.platformTeam}`,
    );
    await user.selectOptions(within(form).getByLabelText("Project role"), "deployer");
    expect(within(form).getByText(/Deploys, rolls back/)).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Grant" }));

    const grants = await screen.findByRole("table", { name: "Grants" });
    expect(rowOf(grants, "Platform").getByRole("link", { name: "Platform" })).toBeInTheDocument();
    expect(db.access.grants).toMatchObject([
      { team_id: ACCESS_SEED.platformTeam, role: "deployer" },
    ]);

    await user.selectOptions(
      within(grants).getByRole("combobox", { name: "Project role for Platform" }),
      "developer",
    );
    await waitFor(() => expect(db.access.grants[0]?.role).toBe("developer"));

    await user.click(within(grants).getByRole("button", { name: "Revoke access of Platform" }));
    const dialog = await screen.findByRole("dialog", { name: "Revoke access of Platform?" });
    await user.click(within(dialog).getByRole("button", { name: "Revoke access" }));
    await waitFor(() => expect(db.access.grants).toHaveLength(0));
  });

  it("doesn't offer owners and admins, who are always project admins", async () => {
    renderAs("owner");
    const select = await screen.findByLabelText("Member or team");
    const names = within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(names).toContain("Cara Mel");
    expect(names).not.toContain("Ada Lovelace");
    expect(names).not.toContain("Bob Builder");
  });

  it("asks for the password before granting with a stale session", async () => {
    db.sessionStale = true;
    const { user } = renderAs("owner");
    const form = await screen.findByRole("form", { name: "Grant access" });
    await user.selectOptions(
      within(form).getByLabelText("Member or team"),
      `user:${USERS.viewer.id}`,
    );
    await user.click(within(form).getByRole("button", { name: "Grant" }));
    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    expect(within(reauth).getByLabelText("Password")).toHaveFocus();
    await user.type(within(reauth).getByLabelText("Password"), PASSWORD);
    await user.click(within(reauth).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(db.access.grants).toMatchObject([{ user_id: USERS.viewer.id }]));
  });

  it("explains who can do what, and why, including protection", async () => {
    db.access.grants.push({
      id: "pag_seed",
      project_id: SEED.project,
      principal_type: "team",
      user_id: null,
      team_id: ACCESS_SEED.platformTeam,
      role: "viewer",
      created_by: USERS.owner.id,
      created_at: 1,
      updated_at: 1,
    });
    const production = db.deploy.environments.find((row) => row.id === SEED.production)!;
    production.protected = true;
    renderAs("owner");
    const table = await screen.findByRole("table", { name: "Effective access in production" });
    const ada = rowOf(table, "Ada Lovelace");
    expect(ada.getByText("Project admin")).toBeInTheDocument();
    expect(ada.getByText("Workspace owner")).toBeInTheDocument();
    const cara = rowOf(table, "Cara Mel");
    expect(cara.getByText("Developer")).toBeInTheDocument();
    expect(cara.getByText("Default for members")).toBeInTheDocument();
    expect(cara.getByText(/viewer via Team Platform/)).toBeInTheDocument();
    expect(cara.getAllByText("Allowed")).toHaveLength(2);
    expect(cara.getByText("Blocked by protection")).toBeInTheDocument();
    const dan = rowOf(table, "Dan Viewer");
    expect(dan.getAllByText("Not with this role")).toHaveLength(3);
    expect(screen.getByText(/is protected: its rules narrow/)).toBeInTheDocument();
  });

  it("tells non-admins why they can't manage access and hides the link", async () => {
    renderAs("member");
    expect(
      await screen.findByRole("heading", { name: "Only project admins manage access" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Your role here is developer/)).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Project settings" });
    expect(within(nav).queryByRole("link", { name: "Access" })).not.toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Environments" })).toBeInTheDocument();
  });

  it("lets a workspace member with a project admin grant manage access", async () => {
    db.access.grants.push({
      id: "pag_cara",
      project_id: SEED.project,
      principal_type: "user",
      user_id: USERS.member.id,
      team_id: null,
      role: "project_admin",
      created_by: USERS.owner.id,
      created_at: 1,
      updated_at: 1,
    });
    renderAs("member");
    expect(await screen.findByRole("table", { name: "Grants" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Project settings" });
    expect(within(nav).getByRole("link", { name: "Access" })).toBeInTheDocument();
  });
});
