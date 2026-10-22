import { can, type Role } from "@openrail/shared";
import { describe, expect, it, vi } from "vitest";
import { buildCommands } from "./commands";
import { activeNavId, NAV_ITEMS } from "./nav";

describe("activeNavId", () => {
  it.each([
    ["/w/ws_1", "home"],
    ["/w/ws_1/", "home"],
    ["/w/ws_1/servers", "servers"],
    ["/w/ws_1/servers/node_1", "servers"],
    ["/w/ws_1/canvas", "canvas"],
    ["/w/ws_1/settings", "settings"],
    ["/w/ws_1/members", "settings"],
    ["/w/ws_1/audit", "settings"],
  ])("%s highlights %s", (path, id) => {
    expect(activeNavId(path)).toBe(id);
  });

  it("returns undefined outside a workspace or for unknown sections", () => {
    expect(activeNavId("/login")).toBeUndefined();
    expect(activeNavId("/w/ws_1/unknown")).toBeUndefined();
  });
});

describe("NAV_ITEMS", () => {
  it("has unique shortcuts matching the documented G-key map", () => {
    const shortcuts = NAV_ITEMS.flatMap((item) =>
      item.shortcut ? [`${item.label}:${item.shortcut}`] : [],
    );
    expect(shortcuts).toEqual([
      "Home:h",
      "Canvas:c",
      "Servers:s",
      "Logs:l",
      "Templates:t",
      "Usage:u",
    ]);
  });
});

function commandsFor(role: Role) {
  const deps = {
    navigate: vi.fn(),
    can: (action: Parameters<typeof can>[1]) => can(role, action),
    openAddServer: vi.fn(),
    openInviteMember: vi.fn(),
    toggleTheme: vi.fn(),
    signOut: vi.fn(),
  };
  return { deps, commands: buildCommands(deps) };
}

describe("buildCommands", () => {
  it("offers every action to owners", () => {
    const ids = commandsFor("owner").commands.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "nav:home",
        "nav:servers",
        "nav:members",
        "nav:audit",
        "action:add-server",
        "action:invite",
        "action:theme",
        "account:sign-out",
      ]),
    );
  });

  it("hides management actions from members", () => {
    const ids = commandsFor("member").commands.map((c) => c.id);
    expect(ids).toContain("nav:members");
    expect(ids).not.toContain("nav:audit");
    expect(ids).not.toContain("action:add-server");
    expect(ids).not.toContain("action:invite");
    expect(ids).toContain("action:theme");
  });

  it("hides members and audit navigation from viewers", () => {
    const ids = commandsFor("viewer").commands.map((c) => c.id);
    expect(ids).not.toContain("nav:members");
    expect(ids).not.toContain("nav:audit");
  });

  it("wires each command to its callback", () => {
    const { deps, commands } = commandsFor("owner");
    const byId = (id: string) => commands.find((c) => c.id === id);
    byId("nav:servers")?.onSelect();
    expect(deps.navigate).toHaveBeenCalledWith("/w/$workspaceId/servers");
    byId("action:add-server")?.onSelect();
    expect(deps.openAddServer).toHaveBeenCalled();
    byId("action:invite")?.onSelect();
    expect(deps.openInviteMember).toHaveBeenCalled();
    byId("action:theme")?.onSelect();
    expect(deps.toggleTheme).toHaveBeenCalled();
    byId("account:sign-out")?.onSelect();
    expect(deps.signOut).toHaveBeenCalled();
  });

  it("shows G-key hints on navigation commands", () => {
    const servers = commandsFor("owner").commands.find((c) => c.id === "nav:servers");
    expect(servers?.hint).toEqual(["G", "S"]);
  });
});
