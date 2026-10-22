import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  readThemePreference,
  resolveTheme,
  storeThemePreference,
  THEME_STORAGE_KEY,
} from "./theme";

afterEach(() => {
  localStorage.clear();
  document.documentElement.className = "";
  vi.unstubAllGlobals();
});

describe("applyTheme", () => {
  it("toggles exactly one of the dark/light classes", () => {
    const root = document.documentElement;
    applyTheme("dark");
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.classList.contains("light")).toBe(false);
    applyTheme("light");
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.classList.contains("light")).toBe(true);
    applyTheme("system");
    expect(root.className).toBe("");
  });
});

describe("theme preference storage", () => {
  it("defaults to system", () => {
    expect(readThemePreference()).toBe("system");
  });

  it("round-trips a stored preference and applies it", () => {
    storeThemePreference("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(readThemePreference()).toBe("light");
    expect(document.documentElement.classList.contains("light")).toBe(true);
  });

  it("removes the key when switching back to system", () => {
    storeThemePreference("dark");
    storeThemePreference("system");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("ignores garbage values", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    expect(readThemePreference()).toBe("system");
  });
});

describe("resolveTheme", () => {
  it("returns explicit preferences unchanged", () => {
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("light")).toBe("light");
  });

  it("follows the media query for system", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("light") }));
    expect(resolveTheme("system")).toBe("light");
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(resolveTheme("system")).toBe("dark");
  });
});
