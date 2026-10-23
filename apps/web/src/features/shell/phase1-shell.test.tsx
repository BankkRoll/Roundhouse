import { can, type Role } from "@roundhouse/shared";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { db, signInAs, USERS } from "../../mocks/db";
import { realtimeLink } from "../../mocks/deploy-handlers";
import { server } from "../../mocks/server";
import { PROJECT_PATH, SEED, servicePath } from "../../test/phase1";
import { expectPath, findPageHeading, renderApp } from "../../test/render";
import { buildCommands } from "./commands";

function commandsFor(role: Role) {
  const deps = {
    navigate: vi.fn(),
    can: (action: Parameters<typeof can>[1]) => can(role, action),
    openAddServer: vi.fn(),
    openInviteMember: vi.fn(),
    toggleTheme: vi.fn(),
    signOut: vi.fn(),
    openNewProject: vi.fn(),
    openProject: vi.fn(),
    openNewService: vi.fn(),
    openService: vi.fn(),
    deployService: vi.fn(),
    openLogs: vi.fn(),
    projects: [{ id: "prj_1", name: "storefront" }],
    project: { id: "prj_1", name: "storefront", services: [{ id: "svc_1", name: "web" }] },
  };
  return { deps, commands: buildCommands(deps) };
}

describe("project commands", () => {
  it("offers project, service and deploy actions, current project first", () => {
    const { deps, commands } = commandsFor("member");
    expect(commands[0]?.group).toBe("storefront");
    const byLabel = (label: string) => commands.find((c) => c.label === label);
    byLabel("Deploy web")?.onSelect();
    expect(deps.deployService).toHaveBeenCalledWith("prj_1", "svc_1");
    byLabel("Open logs · web")?.onSelect();
    expect(deps.openLogs).toHaveBeenCalledWith("prj_1", "svc_1");
    byLabel("New service")?.onSelect();
    expect(deps.openNewService).toHaveBeenCalledWith("prj_1");
    byLabel("Open project storefront")?.onSelect();
    expect(deps.openProject).toHaveBeenCalledWith("prj_1");
    expect(byLabel("New project")).toBeUndefined();
  });

  it("gives viewers navigation but no deploy or create actions", () => {
    const labels = commandsFor("viewer").commands.map((c) => c.label);
    expect(labels).toContain("Open logs · web");
    expect(labels).not.toContain("Deploy web");
    expect(labels).not.toContain("New service");
    expect(commandsFor("admin").commands.map((c) => c.label)).toContain("New project");
  });
});

describe("palette and shortcuts in a project", () => {
  it("deploys a service from the palette", async () => {
    const { user, router } = renderApp(PROJECT_PATH);
    await findPageHeading("storefront");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await user.type(await screen.findByRole("combobox", { name: "Search commands" }), "deploy api");
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Deploying api")).toBeInTheDocument();
    await expectPath(router, servicePath(SEED.api));
    expect(db.deploy.deployments.at(-1)).toMatchObject({ service_id: SEED.api });
  });

  it("opens logs and the new-service flow from the palette", async () => {
    const { user, router } = renderApp(PROJECT_PATH);
    await findPageHeading("storefront");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await user.type(await screen.findByRole("combobox"), "open logs web");
    await user.keyboard("{Enter}");
    await expectPath(router, servicePath(SEED.web, "logs"));
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await user.type(await screen.findByRole("combobox"), "new service");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "New service" })).toBeInTheDocument();
  });

  it("creates a project from the palette", async () => {
    const { user } = renderApp(`/w/ws_acme`);
    await findPageHeading("Home");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await user.type(await screen.findByRole("combobox"), "new project");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "New project" })).toBeInTheDocument();
  });

  it("binds G D, G V and G L to the open service's tabs", async () => {
    const { router } = renderApp(servicePath(SEED.web));
    await findPageHeading("web");
    for (const [key, tab] of [
      ["v", "variables"],
      ["l", "logs"],
      ["d", "deployments"],
    ] as const) {
      fireEvent.keyDown(window, { key: "g" });
      fireEvent.keyDown(window, { key });
      await expectPath(router, servicePath(SEED.web, tab));
    }
  });

  it("keeps focus on a service tab when switching tabs, with arrow-free tab order", async () => {
    const { user } = renderApp(servicePath(SEED.web));
    await findPageHeading("web");
    const tabs = screen.getByRole("navigation", { name: "Service" });
    const links = within(tabs).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Deployments",
      "Logs",
      "Variables",
      "Settings",
      "Domains",
    ]);
    expect(links[0]).toHaveAttribute("aria-current", "page");
    links[2]?.focus();
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(within(tabs).getByRole("link", { name: "Variables" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    expect(within(tabs).getByRole("link", { name: "Variables" })).toHaveFocus();
  });

  it("titles the tab with the page, service, project and workspace", async () => {
    renderApp(servicePath(SEED.web, "logs"));
    await findPageHeading("web");
    await waitFor(() => expect(document.title).toBe("Logs · web · storefront · Acme · Roundhouse"));
  });
});

describe("realtime session handling", () => {
  it("sends the user to sign in when the socket is refused for an expired session", async () => {
    const { router } = renderApp(PROJECT_PATH);
    await findPageHeading("storefront");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Live"));
    server.use(
      realtimeLink.addEventListener("connection", ({ client }) => client.close(4401, "expired")),
    );
    signInAs(null);
    act(() => {
      for (const client of realtimeLink.clients) client.close(1001, "going away");
    });
    await expectPath(router, "/login");
    expect(router.state.location.search).toEqual({ redirect: PROJECT_PATH });
  });

  it("leaves the project when membership is revoked (4003)", async () => {
    const { router } = renderApp(PROJECT_PATH);
    await findPageHeading("storefront");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Live"));
    act(() => {
      for (const client of realtimeLink.clients) client.close(4003, "no longer a member");
    });
    expect(
      await screen.findByText("You no longer have access to this project"),
    ).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).not.toBe(PROJECT_PATH));
  });

  it("hides deploy controls from viewers everywhere", async () => {
    signInAs(USERS.viewer.id);
    renderApp(servicePath(SEED.web));
    await findPageHeading("web");
    expect(screen.queryByRole("button", { name: "Deploy" })).not.toBeInTheDocument();
  });
});
