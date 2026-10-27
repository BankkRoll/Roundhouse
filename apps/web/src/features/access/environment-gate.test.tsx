import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ACCESS_SEED } from "../../mocks/access-db";
import { db, signInAs, USERS } from "../../mocks/db";
import { PROJECT_PATH, SEED, servicePath } from "../../test/phase1";
import { renderApp } from "../../test/render";

const production = () => db.deploy.environments.find((row) => row.id === SEED.production)!;

/** Protects production with rules that list nobody besides project admins. */
function lockProduction() {
  production().protected = true;
  db.access.rules[SEED.production] = {
    deploy: { roles: [], userIds: [], teamIds: [] },
    config: { roles: [], userIds: [], teamIds: [] },
    variables: { roles: [], userIds: [], teamIds: [] },
  };
}

describe("protected environments where people act", () => {
  it("shows a locked Deploy with the reason, reachable by keyboard", async () => {
    lockProduction();
    signInAs(USERS.member.id);
    const { user } = renderApp(servicePath(SEED.web));
    await waitFor(() => expect(screen.getByRole("button", { name: "Deploy" })).toBeDisabled());
    const deploy = screen.getByRole("button", { name: "Deploy" });
    expect(screen.getByText("Protected")).toBeInTheDocument();
    const reason =
      /^production is protected: only project admins and people its rules list can deploy here./;
    await user.tab();
    const wrapper = deploy.parentElement!;
    while (document.activeElement !== wrapper) await user.tab();
    expect(wrapper).toHaveAccessibleDescription(reason);
    expect(db.deploy.deployments.filter((row) => row.service_id === SEED.web)).toHaveLength(4);
  });

  it("lets someone the rule lists through, via their team", async () => {
    lockProduction();
    db.access.rules[SEED.production]!.deploy.teamIds = [ACCESS_SEED.platformTeam];
    signInAs(USERS.member.id);
    const { user } = renderApp(servicePath(SEED.web));
    await screen.findByText("Protected");
    await waitFor(() => expect(screen.getByRole("button", { name: "Deploy" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Deploy" }));
    expect(await screen.findByText("Deploying web")).toBeInTheDocument();
  });

  it("makes service settings read-only and keeps deletion locked, with reasons", async () => {
    lockProduction();
    signInAs(USERS.member.id);
    renderApp(servicePath(SEED.web, "settings"));
    expect(await screen.findByRole("note")).toHaveTextContent(
      "production is protected: only project admins and people its rules list can change service settings here.",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Delete service" })).toBeDisabled(),
    );
    const remove = screen.getByRole("button", { name: "Delete service" });
    expect(remove.parentElement).toHaveAccessibleDescription(
      /Deleting removes the service from every environment\. production is protected/,
    );
  });

  it("refuses a protected deploy in the API mock even if the UI is bypassed", async () => {
    lockProduction();
    signInAs(USERS.member.id);
    const res = await fetch(
      `http://localhost/v1/services/${SEED.web}/deployments?environment_id=${SEED.production}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(res.status).toBe(403);
  });

  it("leaves project admins every control in a protected environment", async () => {
    lockProduction();
    renderApp(servicePath(SEED.web));
    expect(await screen.findByText("Protected")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Deploy" })).toBeEnabled());
  });

  it("marks protected environments in the environment switcher", async () => {
    production().protected = true;
    renderApp(PROJECT_PATH);
    const trigger = await screen.findByRole("button", {
      name: "Environment: production (protected). Switch environment",
    });
    expect(within(trigger).getByText("production")).toBeInTheDocument();
  });
});
