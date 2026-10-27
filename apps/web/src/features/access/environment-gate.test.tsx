import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ACCESS_SEED } from "../../mocks/access-db";
import { db, signInAs, USERS } from "../../mocks/db";
import { PROJECT_PATH, SEED, servicePath } from "../../test/phase1";
import { renderApp } from "../../test/render";
import { LockedButton } from "./environment-gate";

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

describe("LockedButton", () => {
  const reason = "production is protected: only project admins can deploy here.";
  // NOTE: While open, Radix also references the bubble, whose text is aria-hidden; the
  // empty reference leaves a trailing space in the computed description, nothing more.
  const announcedOnce = /^production is protected: only project admins can deploy here\.\s*$/;

  /** Renders a locked Deploy and returns the focusable wrapper that carries the reason. */
  function renderLocked() {
    const user = userEvent.setup();
    render(<LockedButton reason={reason}>Deploy</LockedButton>);
    const button = screen.getByRole("button", { name: "Deploy" });
    return { user, button, wrapper: button.parentElement! };
  }

  it("describes itself with the reason exactly once while the tooltip is closed", () => {
    const { button, wrapper } = renderLocked();
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleName("Deploy");
    expect(wrapper).toHaveAccessibleDescription(reason);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("shows the reason on hover and still announces it once", async () => {
    const { user, button, wrapper } = renderLocked();
    await user.hover(wrapper);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(reason);
    expect(wrapper).toHaveAccessibleDescription(announcedOnce);
    expect(button).toHaveAccessibleName("Deploy");
  });

  it("shows the reason on keyboard focus and still announces it once", async () => {
    const { user, wrapper } = renderLocked();
    await user.tab();
    expect(wrapper).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(reason);
    expect(wrapper.getAttribute("aria-describedby")?.split(" ")).toHaveLength(2);
    expect(wrapper).toHaveAccessibleDescription(announcedOnce);
  });
});
