import { THEME_STORAGE_KEY } from "@roundhouse/ui";
import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DENSITY_STORAGE_KEY, MOTION_STORAGE_KEY } from "../../lib/preferences";
import { WORKSPACE_ID } from "../../mocks/db";
import { expectPath, findPageHeading, renderApp } from "../../test/render";

const BASE = `/w/${WORKSPACE_ID}`;

afterEach(() => {
  delete document.documentElement.dataset.density;
  delete document.documentElement.dataset.motion;
});

describe("preferences", () => {
  it("opens from the account menu", async () => {
    const { router, user } = renderApp(BASE);
    await findPageHeading("Home");
    await user.click(screen.getByRole("button", { name: /^Ada Lovelace, account menu$/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Preferences" }));
    await expectPath(router, `${BASE}/preferences`);
    expect(await findPageHeading("Appearance")).toBeInTheDocument();
  });

  it("opens from the command palette", async () => {
    const { router, user } = renderApp(BASE);
    await findPageHeading("Home");
    await user.keyboard("{Control>}k{/Control}");
    await user.type(await screen.findByRole("combobox"), "preferences");
    await user.keyboard("{Enter}");
    await expectPath(router, `${BASE}/preferences`);
  });

  it("lists every preference page in the settings navigation", async () => {
    renderApp(`${BASE}/preferences`);
    const nav = await screen.findByRole("navigation", { name: "Settings" });
    for (const name of ["General", "Appearance", "Keyboard shortcuts", "Accessibility"]) {
      expect(within(nav).getByRole("link", { name })).toBeInTheDocument();
    }
    expect(within(nav).getByRole("link", { name: "Appearance" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(
      within(screen.getByRole("navigation", { name: "Main" })).getByRole("link", {
        name: "Settings",
      }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("switches the theme from the theme cards", async () => {
    const { user } = renderApp(`${BASE}/preferences`);
    const themes = await screen.findByRole("group", { name: "Interface theme" });
    expect(within(themes).getByRole("radio", { name: "System" })).toBeChecked();
    await user.click(within(themes).getByRole("radio", { name: "Light" }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement).toHaveClass("light");
    await user.click(within(themes).getByRole("radio", { name: "System" }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement).not.toHaveClass("light");
  });

  it("sets table density for the whole app", async () => {
    const { user } = renderApp(`${BASE}/preferences`);
    const density = await screen.findByRole("group", { name: "Table density" });
    await user.click(within(density).getByRole("radio", { name: /Compact/ }));
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe("compact");
    expect(document.documentElement.dataset.density).toBe("compact");
  });

  it("lists the real shortcuts", async () => {
    renderApp(`${BASE}/preferences/shortcuts`);
    expect(await findPageHeading("Keyboard shortcuts")).toBeInTheDocument();
    const goTo = screen.getByRole("region", { name: "Go to" });
    for (const label of ["Home", "Canvas", "Servers", "Logs", "Templates", "Usage"]) {
      expect(within(goTo).getByText(label)).toBeInTheDocument();
    }
    const service = screen.getByRole("region", { name: "On a service" });
    expect(service).toHaveTextContent("DeploymentsGthenD");
    expect(service).toHaveTextContent("LogsGthenL");
    expect(service).toHaveTextContent("VariablesGthenV");
    expect(screen.getByRole("region", { name: "Everywhere" })).toHaveTextContent(
      /Search or run a command.*(Ctrl|⌘)\+K/,
    );
  });

  it("overrides the device's motion setting", async () => {
    const { user } = renderApp(`${BASE}/preferences/accessibility`);
    const motion = await screen.findByRole("group", { name: "Interface motion" });
    expect(within(motion).getByRole("radio", { name: /Follow device/ })).toBeChecked();
    await user.click(within(motion).getByRole("radio", { name: /Reduce motion/ }));
    await waitFor(() => expect(document.documentElement.dataset.motion).toBe("reduce"));
    expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBe("reduce");
    await user.click(within(motion).getByRole("radio", { name: /Follow device/ }));
    expect(document.documentElement.dataset.motion).toBeUndefined();
  });
});
