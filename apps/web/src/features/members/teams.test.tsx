import type { Role } from "@roundhouse/shared";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ACCESS_SEED } from "../../mocks/access-db";
import { db, PASSWORD, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { expectPath, renderApp } from "../../test/render";

const TEAMS = `/w/${WORKSPACE_ID}/teams`;
const PLATFORM = `${TEAMS}/${ACCESS_SEED.platformTeam}`;

function renderAs(role: Role, path: string) {
  signInAs(USERS[role].id);
  return renderApp(path);
}

describe("teams", () => {
  it("lists teams and creates one with members, then opens it", async () => {
    const { user, router } = renderAs("owner", TEAMS);
    const table = await screen.findByRole("table");
    expect(within(table).getByRole("link", { name: "Platform" })).toBeInTheDocument();
    expect(within(table).getByText("@platform", { exact: false })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New team" }));
    const dialog = await screen.findByRole("dialog", { name: "New team" });
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Create team" }));
    expect(within(dialog).getByText("Enter a team name.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Name"), "Support");
    await user.click(within(dialog).getByRole("checkbox", { name: /Dan Viewer/ }));
    await user.click(within(dialog).getByRole("button", { name: "Create team" }));

    await waitFor(() => expect(db.access.teams.some((team) => team.name === "Support")).toBe(true));
    const team = db.access.teams.find((row) => row.name === "Support")!;
    expect(db.access.teamMembers.filter((row) => row.team_id === team.id)).toHaveLength(1);
    await expectPath(router, `${TEAMS}/${team.id}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Support" })).toBeInTheDocument();
  });

  it("explains a duplicate name", async () => {
    const { user } = renderAs("owner", TEAMS);
    await user.click(await screen.findByRole("button", { name: "New team" }));
    const dialog = await screen.findByRole("dialog", { name: "New team" });
    await user.type(within(dialog).getByLabelText("Name"), "Platform");
    await user.click(within(dialog).getByRole("button", { name: "Create team" }));
    expect(await within(dialog).findByText(/already exists/)).toBeInTheDocument();
  });

  it("asks for the password when creating needs a fresh session, then retries", async () => {
    db.sessionStale = true;
    const { user } = renderAs("owner", TEAMS);
    await user.click(await screen.findByRole("button", { name: "New team" }));
    const dialog = await screen.findByRole("dialog", { name: "New team" });
    await user.type(within(dialog).getByLabelText("Name"), "Ops");
    await user.click(within(dialog).getByRole("button", { name: "Create team" }));
    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.type(within(reauth).getByLabelText("Password"), PASSWORD);
    await user.click(within(reauth).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(db.access.teams.some((team) => team.name === "Ops")).toBe(true));
  });

  it("shows members a read-only list and hides it from viewers", async () => {
    renderAs("member", TEAMS);
    expect(await screen.findByRole("link", { name: "Platform" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New team" })).not.toBeInTheDocument();
  });

  it("hides teams from viewers", async () => {
    renderAs("viewer", TEAMS);
    expect(
      await screen.findByRole("heading", { name: "Teams are hidden for your role" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Teams" })).not.toBeInTheDocument();
  });
});

describe("team detail", () => {
  it("adds and removes members", async () => {
    const { user } = renderAs("admin", PLATFORM);
    const table = await screen.findByRole("table", { name: "Members of Platform" });
    expect(within(table).getByText("Cara Mel")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Add a member"), USERS.viewer.id);
    await user.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(
        db.access.teamMembers.some(
          (row) => row.team_id === ACCESS_SEED.platformTeam && row.user_id === USERS.viewer.id,
        ),
      ).toBe(true),
    );
    expect(await within(table).findByText("Dan Viewer")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove Cara Mel from Platform" }));
    const confirm = await screen.findByRole("dialog");
    await user.click(within(confirm).getByRole("button", { name: "Remove from team" }));
    await waitFor(() =>
      expect(
        db.access.teamMembers.some(
          (row) => row.team_id === ACCESS_SEED.platformTeam && row.user_id === USERS.member.id,
        ),
      ).toBe(false),
    );
    await waitFor(() => expect(confirm).not.toBeInTheDocument());
  });

  it("renames a team and rejects a taken handle", async () => {
    db.access.teams.push({
      ...db.access.teams[0]!,
      id: "team_support",
      name: "Support",
      slug: "support",
    });
    const { user } = renderAs("owner", PLATFORM);
    const form = await screen.findByRole("form", { name: "General" });
    const handle = within(form).getByLabelText("Handle");
    await user.clear(handle);
    await user.type(handle, "support");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await within(form).findByText("Another team already uses this handle.")).toBeVisible();
    await user.clear(handle);
    await user.type(handle, "platform-eng");
    const name = within(form).getByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Platform Engineering");
    await user.click(within(form).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(db.access.teams[0]).toMatchObject({
        name: "Platform Engineering",
        slug: "platform-eng",
      }),
    );
  });

  it("deletes a team after typing its handle", async () => {
    const { user, router } = renderAs("owner", PLATFORM);
    await user.click(await screen.findByRole("button", { name: "Delete team" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Platform?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete team" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), "platform");
    await user.click(confirm);
    await expectPath(router, TEAMS);
    expect(db.access.teams).toHaveLength(0);
  });

  it("is read-only for members", async () => {
    renderAs("member", PLATFORM);
    const form = await screen.findByRole("form", { name: "General" });
    expect(within(form).getByLabelText("Name")).toBeDisabled();
    expect(screen.queryByRole("button", { name: /^Remove / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete team" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Add a member")).not.toBeInTheDocument();
  });

  it("explains a team that doesn't exist", async () => {
    renderAs("owner", `${TEAMS}/team_gone`);
    expect(await screen.findByRole("heading", { name: "Team not found" })).toBeInTheDocument();
  });
});
