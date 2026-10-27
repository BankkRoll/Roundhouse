import type { Role } from "@roundhouse/shared";
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ACCESS_SEED } from "../../mocks/access-db";
import { db, PASSWORD, signInAs, USERS } from "../../mocks/db";
import { PROJECT_PATH, SEED } from "../../test/phase1";
import { renderApp } from "../../test/render";

const ENVIRONMENTS = `${PROJECT_PATH}/settings/environments`;

function renderAs(role: Role) {
  signInAs(USERS[role].id);
  return renderApp(ENVIRONMENTS);
}

const production = () => db.deploy.environments.find((row) => row.id === SEED.production)!;

describe("environment protection", () => {
  it("offers project admins a one-click fix for unprotected production", async () => {
    const { user } = renderAs("owner");
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent("Production isn't protected");
    await user.click(within(note).getByRole("button", { name: "Protect production" }));
    await waitFor(() => expect(production().protected).toBe(true));
    await waitFor(() => expect(screen.queryByRole("note")).not.toBeInTheDocument());
    expect(screen.getByText("Protected")).toBeInTheDocument();
  });

  it("edits the rules and explains each one in a sentence", async () => {
    production().protected = true;
    const { user } = renderAs("owner");
    const variables = await screen.findByRole("group", { name: "Variables rule" });
    expect(
      screen.getByText("Only project admins can change variables in production."),
    ).toBeVisible();
    expect(
      screen.getByText(/Project admins, developers and deployers can deploy to production/),
    ).toBeInTheDocument();

    await user.click(within(variables).getByRole("checkbox", { name: "Developers" }));
    await user.selectOptions(within(variables).getByLabelText("Teams"), ACCESS_SEED.platformTeam);
    await user.click(
      within(variables).getByRole("button", { name: "Add team to the variables rule" }),
    );
    expect(
      within(variables).getByRole("button", { name: "Remove Platform from the variables rule" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Project admins, developers and team Platform can change variables in production/,
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(db.access.rules[SEED.production]?.variables).toEqual({
        roles: ["developer"],
        userIds: [],
        teamIds: [ACCESS_SEED.platformTeam],
      }),
    );
    expect(db.access.rules[SEED.production]?.deploy.roles).toEqual(["developer", "deployer"]);
  });

  it("requires approval for staged changes once switched on", async () => {
    production().protected = true;
    const { user } = renderAs("owner");
    const toggle = await screen.findByRole("switch", {
      name: "Require approval for staged changes",
    });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(db.changes.requireApproval[SEED.production]).toBe(true));
    expect(production().protected).toBe(true);
  });

  it("turns protection off after confirming the password", async () => {
    production().protected = true;
    db.sessionStale = true;
    const { user } = renderAs("owner");
    await user.click(await screen.findByRole("switch", { name: "Protect production" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.type(within(reauth).getByLabelText("Password"), PASSWORD);
    await user.click(within(reauth).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(production().protected).toBe(false));
  });

  it("keeps protection unchanged when the password prompt is cancelled", async () => {
    production().protected = true;
    db.sessionStale = true;
    const { user } = renderAs("owner");
    await user.click(await screen.findByRole("switch", { name: "Protect production" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    const reauth = await screen.findByRole("dialog", { name: "Confirm it's you" });
    await user.click(within(reauth).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Confirm your password");
    expect(production().protected).toBe(true);
  });

  it("shows everyone else the rules without controls", async () => {
    production().protected = true;
    renderAs("member");
    expect(await screen.findByText(/Only project admins can change protection/)).toBeVisible();
    expect(screen.getByRole("switch", { name: "Protect production" })).toBeDisabled();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Add (person|team) to the/ }),
    ).not.toBeInTheDocument();
  });
});
