import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { PROJECT_PATH, pushRealtime, SEED } from "../../test/phase1";
import { expectPath, findPageHeading, renderApp } from "../../test/render";

const BASE = `/w/${WORKSPACE_ID}`;

describe("projects in the shell and on Home", () => {
  it("lists projects in the sidebar with status dots and service counts", async () => {
    renderApp(BASE);
    const nav = await screen.findByRole("navigation", { name: "Projects" });
    await waitFor(() =>
      expect(
        within(nav)
          .getAllByRole("link")
          .map((link) => link.textContent),
      ).toEqual(["internal-tools1", "storefront3"]),
    );
    const links = within(nav).getAllByRole("link");
    await waitFor(() =>
      expect(within(links[1]!).getByRole("img", { name: "Deploying" })).toBeInTheDocument(),
    );
    expect(within(links[0]!).getByRole("img", { name: "All services live" })).toBeInTheDocument();
  });

  it("shows project cards with services, environment and last deploy from real data", async () => {
    renderApp(BASE);
    await findPageHeading("Home");
    const card = (await screen.findByRole("link", { name: "storefront" })).closest("li")!;
    await waitFor(() => expect(card).toHaveTextContent("3 services · production"));
    await waitFor(() => expect(card).toHaveTextContent(/worker deployed (just now|\d+s ago)/));
    expect(card).toHaveTextContent("Customer-facing shop");
    expect(card.textContent).not.toMatch(/\$/);
  });

  it("offers the one next step when there are no projects", async () => {
    db.deploy.projects = [];
    renderApp(BASE);
    expect(await screen.findByRole("heading", { name: "No projects yet" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New project" }).length).toBeGreaterThan(0);
  });

  it("creates a project from the dialog and opens it", async () => {
    const { router, user } = renderApp(BASE);
    await findPageHeading("Home");
    await user.click(screen.getByRole("button", { name: "New project" }));
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    expect(within(dialog).getByText("Enter a project name.")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Project name"), "Data Lake");
    expect(within(dialog).getByText("Slug: data-lake")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Description/), "ETL jobs");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() =>
      expect(router.state.location.pathname).toMatch(/^\/w\/ws_acme\/p\/prj_mock\d+$/),
    );
    expect(await screen.findByRole("heading", { name: "No services yet" })).toBeInTheDocument();
    expect(db.deploy.projects.at(-1)).toMatchObject({ name: "Data Lake", description: "ETL jobs" });
  });

  it("shows the API's conflict in the dialog", async () => {
    const { user } = renderApp(BASE);
    await findPageHeading("Home");
    await user.click(screen.getByRole("button", { name: "New project" }));
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    await user.type(within(dialog).getByLabelText("Project name"), "Storefront");
    await user.click(within(dialog).getByRole("button", { name: "Create project" }));
    expect(await within(dialog).findByText(/already exists/)).toBeInTheDocument();
  });
});

describe("project page", () => {
  it("lists services with source, status and config, and shows who is here", async () => {
    renderApp(PROJECT_PATH);
    expect(await findPageHeading("storefront")).toBeInTheDocument();
    const list = await screen.findByRole("list", { name: "Services" });
    const web = within(list).getByRole("link", { name: "web" }).closest("li")!;
    await waitFor(() => expect(web).toHaveTextContent("acme/storefront@main · apps/web"));
    await waitFor(() => expect(web).toHaveTextContent(/active/i));
    expect(web).toHaveTextContent("v3");
    expect(
      await screen.findByRole("button", { name: "Viewing now: Ada Lovelace, Bob Builder" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Live");
  });

  it("puts the environment switcher in the breadcrumb", async () => {
    const { user } = renderApp(PROJECT_PATH);
    const crumbs = await screen.findByRole("navigation", { name: "Breadcrumb" });
    await waitFor(() => expect(crumbs).toHaveTextContent("Acme/storefront/production/Services"));
    await user.click(within(crumbs).getByRole("button", { name: /Environment: production/ }));
    expect(await screen.findByRole("menuitemradio", { name: /production/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("deploys a service from its card", async () => {
    const { user } = renderApp(PROJECT_PATH);
    await user.click(await screen.findByRole("button", { name: "Deploy api" }));
    expect(await screen.findByText("Deploying api")).toBeInTheDocument();
    expect(db.deploy.deployments.at(-1)).toMatchObject({ service_id: SEED.api, status: "queued" });
  });

  it("updates a card when the socket reports a deployment change", async () => {
    renderApp(PROJECT_PATH);
    const list = await screen.findByRole("list", { name: "Services" });
    const worker = within(list).getByRole("link", { name: "worker" }).closest("li")!;
    await waitFor(() => expect(worker).toHaveTextContent(/deploying/i));
    const row = db.deploy.deployments.find((entry) => entry.id === SEED.workerDeploying)!;
    pushRealtime({
      type: "deployment.updated",
      deployment: { ...row, build: null, status: "active", updated_at: Date.now() + 1 },
    });
    await waitFor(() => expect(worker).toHaveTextContent(/active/i));
  });

  it("shows a not-found state for a missing project", async () => {
    renderApp(`${BASE}/p/prj_nope`);
    expect(await screen.findByRole("heading", { name: "Project not found" })).toBeInTheDocument();
  });
});

describe("project settings", () => {
  it("renames the project and updates the sidebar", async () => {
    const { user } = renderApp(`${PROJECT_PATH}/settings`);
    const name = await screen.findByLabelText("Project name");
    await user.clear(name);
    await user.type(name, "shop");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Project saved")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Projects" });
    await waitFor(() =>
      expect(within(nav).getByRole("link", { name: /shop/ })).toBeInTheDocument(),
    );
  });

  it("deletes only after the name is typed", async () => {
    const { router, user } = renderApp(`${PROJECT_PATH}/settings`);
    await user.click(await screen.findByRole("button", { name: "Delete project" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete storefront?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete project" });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), "storefron");
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/to confirm/), "t");
    await user.click(confirm);
    await expectPath(router, BASE);
    expect(db.deploy.projects.find((p) => p.id === SEED.project)?.deleted).toBe(true);
    expect(await screen.findByText("storefront deleted")).toBeInTheDocument();
  });

  it("is read-only for members", async () => {
    signInAs(USERS.member.id);
    renderApp(`${PROJECT_PATH}/settings`);
    expect(await screen.findByLabelText("Project name")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Delete project" })).not.toBeInTheDocument();
  });
});
