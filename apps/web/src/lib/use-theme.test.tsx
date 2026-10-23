import { THEME_STORAGE_KEY } from "@roundhouse/ui";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import themeInit from "../../public/theme-init.js?raw";
import { setThemePreference, useTheme } from "./use-theme";

function Probe({ id }: { id: string }) {
  const theme = useTheme();
  return (
    <button type="button" data-testid={id} onClick={theme.toggle}>
      {theme.preference}:{theme.resolved}
    </button>
  );
}

/** A controllable `prefers-color-scheme` media query. */
function stubSystemTheme(initial: "dark" | "light") {
  let prefersLight = initial === "light";
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query.includes("light") ? prefersLight : !prefersLight;
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  return {
    set(next: "dark" | "light") {
      prefersLight = next === "light";
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useTheme", () => {
  it("shares one state between every consumer", async () => {
    render(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>,
    );
    expect(screen.getByTestId("b")).toHaveTextContent("system:dark");
    act(() => screen.getByTestId("a").click());
    expect(screen.getByTestId("a")).toHaveTextContent("light:light");
    expect(screen.getByTestId("b")).toHaveTextContent("light:light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("follows OS changes while the preference is system", () => {
    const system = stubSystemTheme("dark");
    render(<Probe id="a" />);
    expect(screen.getByTestId("a")).toHaveTextContent("system:dark");
    act(() => system.set("light"));
    expect(screen.getByTestId("a")).toHaveTextContent("system:light");
  });

  it("ignores OS changes once a theme is pinned", () => {
    const system = stubSystemTheme("dark");
    render(<Probe id="a" />);
    act(() => setThemePreference("dark"));
    act(() => system.set("light"));
    expect(screen.getByTestId("a")).toHaveTextContent("dark:dark");
  });

  it("stops listening to the OS when the last consumer unmounts", () => {
    const system = stubSystemTheme("dark");
    const { unmount } = render(<Probe id="a" />);
    expect(system.listenerCount()).toBe(1);
    unmount();
    expect(system.listenerCount()).toBe(0);
  });

  it("picks up a preference changed in another tab", () => {
    render(<Probe id="a" />);
    act(() => {
      localStorage.setItem(THEME_STORAGE_KEY, "light");
      window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
    });
    expect(screen.getByTestId("a")).toHaveTextContent("light:light");
  });
});

describe("theme-init.js", () => {
  it("reads the same storage key as the theme store", () => {
    expect(themeInit).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`);
  });
});
