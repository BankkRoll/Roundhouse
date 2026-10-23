import { PRODUCT_NAME } from "@roundhouse/shared";
import { THEME_STORAGE_KEY } from "@roundhouse/ui";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { expectPath, findPageHeading, renderApp } from "../../test/render";

const BASE = `/w/${WORKSPACE_ID}`;

function pressSequence(...keys: string[]) {
  for (const key of keys) fireEvent.keyDown(window, { key });
}

describe("app shell", () => {
  it("shows the brand, workspace, navigation and user", async () => {
    renderApp(BASE);
    await findPageHeading("Home");
    expect(screen.getAllByText(PRODUCT_NAME)[0]).toBeInTheDocument();
    expect(screen.getAllByText("self-host")[0]).toBeInTheDocument();
    const switcher = screen.getByRole("button", { name: /^Acme .*, switch workspace$/ });
    await waitFor(() => expect(switcher).toHaveTextContent("4 members"));

    const nav = screen.getByRole("navigation", { name: "Main" });
    const labels = within(nav)
      .getAllByRole("link")
      .map((link) => link.textContent);
    expect(labels).toEqual([
      "HomeGH",
      "CanvasGC",
      "ServersGS",
      "LogsGL",
      "TemplatesGT",
      "UsageGU",
      "Settings",
    ]);
    expect(within(nav).getByRole("link", { name: /Home/ })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: /Servers/ })).not.toHaveAttribute("aria-current");
    expect(
      screen.getByRole("button", { name: /^Ada Lovelace, account menu$/ }),
    ).toBeInTheDocument();
  });

  it("shows the breadcrumb for the current page", async () => {
    renderApp(`${BASE}/servers`);
    const crumbs = await screen.findByRole("navigation", { name: "Breadcrumb" });
    await waitFor(() => expect(crumbs).toHaveTextContent("Acme/Servers"));
  });

  it.each([
    ["servers", /Servers/],
    ["servers/node_hel1", /Servers/],
    ["canvas", /Canvas/],
    ["audit", /Settings/],
  ])("marks only the current section, never Home, on /%s", async (suffix, current) => {
    renderApp(`${BASE}/${suffix}`);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    await waitFor(() =>
      expect(within(nav).getByRole("link", { name: current })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
    expect(within(nav).getByRole("link", { name: /Home/ })).not.toHaveAttribute("aria-current");
    expect(
      within(nav)
        .getAllByRole("link")
        .filter((link) => link.hasAttribute("aria-current")),
    ).toHaveLength(1);
  });

  it("highlights Settings on members and audit pages", async () => {
    renderApp(`${BASE}/members`);
    const nav = await screen.findByRole("navigation", { name: "Main" });
    await waitFor(() =>
      expect(within(nav).getByRole("link", { name: "Settings" })).toHaveAttribute(
        "aria-current",
        "page",
      ),
    );
  });

  it.each([
    [["g", "s"], "/servers", "Servers"],
    [["g", "c"], "/canvas", "Canvas"],
    [["g", "l"], "/logs", "Logs"],
    [["g", "t"], "/templates", "Templates"],
    [["g", "u"], "/usage", "Usage"],
  ])("navigates with %j", async (keys, suffix, heading) => {
    const { router } = renderApp(BASE);
    await findPageHeading("Home");
    pressSequence(...keys);
    await expectPath(router, `${BASE}${suffix}`);
    expect(await findPageHeading(heading)).toBeInTheDocument();
    pressSequence("g", "h");
    await expectPath(router, BASE);
  });

  it("ignores G-key shortcuts while a dialog is open", async () => {
    const { router, user } = renderApp(BASE);
    await findPageHeading("Home");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await user.type(await screen.findByRole("combobox"), "add server");
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Add a server" });
    fireEvent.keyDown(dialog, { key: "g" });
    fireEvent.keyDown(dialog, { key: "s" });
    expect(router.state.location.pathname).toBe(BASE);
  });

  it("ignores G-key shortcuts while a menu is open", async () => {
    const { router, user } = renderApp(BASE);
    await findPageHeading("Home");
    await user.click(screen.getByRole("button", { name: /^Ada Lovelace, account menu$/ }));
    await screen.findByRole("menu");
    pressSequence("g", "s");
    expect(router.state.location.pathname).toBe(BASE);
  });

  it("ignores G-key shortcuts during IME composition", async () => {
    const { router } = renderApp(BASE);
    await findPageHeading("Home");
    fireEvent.keyDown(window, { key: "g", isComposing: true });
    fireEvent.keyDown(window, { key: "s", isComposing: true });
    expect(router.state.location.pathname).toBe(BASE);
  });

  it("does not open the command palette over another dialog", async () => {
    const { user } = renderApp(BASE);
    await findPageHeading("Home");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await user.type(await screen.findByRole("combobox"), "invite");
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog", { name: "Invite a member" });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.queryByRole("combobox", { name: "Search commands" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Invite a member" })).toBeInTheDocument();
  });

  it("offers a skip link and moves focus to the page after navigating", async () => {
    const { user } = renderApp(BASE);
    await findPageHeading("Home");
    const main = screen.getByRole("main");
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main");
    expect(main).toHaveAttribute("id", "main");
    await user.click(screen.getByRole("link", { name: /Servers/ }));
    await findPageHeading("Servers");
    await waitFor(() => expect(main).toHaveFocus());
  });

  it("titles the tab with the page and workspace", async () => {
    const { user } = renderApp(BASE);
    await findPageHeading("Home");
    await waitFor(() => expect(document.title).toBe(`Home · Acme · ${PRODUCT_NAME}`));
    await user.click(screen.getByRole("link", { name: /Servers/ }));
    await waitFor(() => expect(document.title).toBe(`Servers · Acme · ${PRODUCT_NAME}`));
  });

  it("does not trigger shortcuts while typing", async () => {
    const { router, user } = renderApp(`${BASE}/settings`);
    const input = await screen.findByLabelText("Name");
    await user.type(input, "gs");
    expect(router.state.location.pathname).toBe(`${BASE}/settings`);
  });

  it("opens the command palette with Ctrl+K and runs Add server", async () => {
    const { user } = renderApp(BASE);
    await findPageHeading("Home");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = await screen.findByRole("combobox", { name: "Search commands" });
    await user.type(input, "add server");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Add a server" })).toBeInTheDocument();
    expect(await screen.findByText(/curl -fsSL/)).toBeInTheDocument();
  });

  it("opens the palette from the top bar and navigates", async () => {
    const { router, user } = renderApp(BASE);
    await findPageHeading("Home");
    const [topBarSearch] = screen.getAllByRole("button", { name: /Search or run a command/ });
    await user.click(topBarSearch as HTMLElement);
    await user.type(await screen.findByRole("combobox"), "audit");
    await user.keyboard("{Enter}");
    await expectPath(router, `${BASE}/audit`);
  });

  it("runs Invite member from the palette", async () => {
    const { user } = renderApp(BASE);
    await findPageHeading("Home");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await user.type(await screen.findByRole("combobox"), "invite");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Invite a member" })).toBeInTheDocument();
  });

  it("omits management commands for viewers", async () => {
    signInAs(USERS.viewer.id);
    const { user } = renderApp(BASE);
    await findPageHeading("Home");
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await user.type(await screen.findByRole("combobox"), "add server");
    expect(screen.getByText("No matching commands.")).toBeInTheDocument();
  });

  it("toggles the theme from the sidebar and remembers it", async () => {
    const { user } = renderApp(BASE);
    await findPageHeading("Home");
    await user.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(document.documentElement).toHaveClass("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    await user.click(screen.getByRole("button", { name: "Switch to dark theme" }));
    expect(document.documentElement).toHaveClass("dark");
  });

  it("toggles the theme from the palette and the sidebar button follows", async () => {
    const { user } = renderApp(BASE);
    await findPageHeading("Home");
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    await user.type(await screen.findByRole("combobox"), "toggle theme");
    await user.keyboard("{Enter}");
    expect(document.documentElement).toHaveClass("light");
    expect(await screen.findByRole("button", { name: "Switch to dark theme" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Switch to light theme" })).not.toBeInTheDocument();
  });

  it("signs out from the user menu", async () => {
    const { router, user } = renderApp(BASE);
    await findPageHeading("Home");
    await user.click(screen.getByRole("button", { name: /^Ada Lovelace, account menu$/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Sign out" }));
    await expectPath(router, "/login");
    expect(db.sessionUserId).toBeNull();
  });

  it("switches workspaces from the switcher", async () => {
    db.workspaces.push({ id: "ws_two", name: "Second", slug: "second", created_at: Date.now() });
    db.memberships.push({
      id: "mem_two",
      workspace_id: "ws_two",
      user_id: USERS.owner.id,
      role: "viewer",
      created_at: Date.now(),
    });
    const { router, user } = renderApp(BASE);
    await findPageHeading("Home");
    await user.click(screen.getByRole("button", { name: /^Acme .*, switch workspace$/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: /Second/ }));
    await expectPath(router, "/w/ws_two");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Second .*, switch workspace$/ }),
      ).toHaveTextContent("viewer"),
    );
  });

  it("only offers New workspace to instance admins, as the API requires", async () => {
    signInAs(USERS.member.id);
    const { user } = renderApp(BASE);
    await findPageHeading("Home");
    await user.click(screen.getByRole("button", { name: /^Acme .*, switch workspace$/ }));
    expect(await screen.findByRole("menuitemradio", { name: /Acme/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "New workspace" })).not.toBeInTheDocument();
  });

  it("creates a workspace from the switcher", async () => {
    const { router, user } = renderApp(BASE);
    await findPageHeading("Home");
    await user.click(screen.getByRole("button", { name: /^Acme .*, switch workspace$/ }));
    await user.click(await screen.findByRole("menuitem", { name: "New workspace" }));
    const dialog = await screen.findByRole("dialog", { name: "New workspace" });
    await user.type(within(dialog).getByLabelText("Workspace name"), "Lab");
    await user.click(within(dialog).getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/w\/ws_mock\d+$/));
    expect(
      await screen.findByRole("button", { name: /^Lab .*, switch workspace$/ }),
    ).toBeInTheDocument();
  });

  it("sends the user to login when the session expires mid-use", async () => {
    const { router, user, queryClient } = renderApp(BASE);
    await findPageHeading("Home");
    // Home loads project summaries in the background; let them finish so the 401 comes
    // from opening Settings, not from a summary still in flight.
    const services = await screen.findByRole("region", { name: "Services" });
    await waitFor(() => expect(services).toHaveTextContent("live"));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    signInAs(null);
    await user.click(screen.getByRole("link", { name: "Settings" }));
    await expectPath(router, "/login");
    expect(router.state.location.search).toEqual({ redirect: `${BASE}/settings` });
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });
});
