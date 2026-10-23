import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import themeInit from "../../public/theme-init.js?raw";
import {
  applyPreferences,
  DENSITY_STORAGE_KEY,
  MOTION_STORAGE_KEY,
  readPreferences,
  setPreference,
  usePreferences,
} from "./preferences";

function Probe({ id }: { id: string }) {
  const { density, motion } = usePreferences();
  return (
    <span data-testid={id}>
      {density}:{motion}
    </span>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.density;
  delete document.documentElement.dataset.motion;
});

describe("display preferences", () => {
  it("defaults to comfortable rows and the OS motion setting", () => {
    expect(readPreferences()).toEqual({ density: "comfortable", motion: "system" });
  });

  it("ignores unknown stored values", () => {
    localStorage.setItem(DENSITY_STORAGE_KEY, "tiny");
    localStorage.setItem(MOTION_STORAGE_KEY, "fast");
    expect(readPreferences()).toEqual({ density: "comfortable", motion: "system" });
  });

  it("stores, applies and shares a change with every consumer", () => {
    render(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>,
    );
    act(() => setPreference("density", "compact"));
    act(() => setPreference("motion", "reduce"));
    expect(screen.getByTestId("b")).toHaveTextContent("compact:reduce");
    expect(localStorage.getItem(DENSITY_STORAGE_KEY)).toBe("compact");
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(document.documentElement.dataset.motion).toBe("reduce");

    act(() => setPreference("motion", "system"));
    expect(localStorage.getItem(MOTION_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.dataset.motion).toBeUndefined();
  });

  it("still applies when storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readPreferences()).toEqual({ density: "comfortable", motion: "system" });
    expect(() => setPreference("motion", "allow")).not.toThrow();
    expect(document.documentElement.dataset.motion).toBe("allow");
    act(() => setPreference("motion", "system"));
  });

  it("picks up a change made in another tab", () => {
    render(<Probe id="a" />);
    act(() => {
      localStorage.setItem(DENSITY_STORAGE_KEY, "compact");
      window.dispatchEvent(new StorageEvent("storage", { key: DENSITY_STORAGE_KEY }));
    });
    expect(screen.getByTestId("a")).toHaveTextContent("compact:system");
    expect(document.documentElement.dataset.density).toBe("compact");
    act(() => setPreference("density", "comfortable"));
  });

  it("removes attributes for the defaults", () => {
    const root = document.createElement("html");
    applyPreferences({ density: "compact", motion: "allow" }, root);
    applyPreferences({ density: "comfortable", motion: "system" }, root);
    expect(root.dataset.density).toBeUndefined();
    expect(root.dataset.motion).toBeUndefined();
  });
});

describe("theme-init.js", () => {
  it("reads the same storage keys as the preference store", () => {
    expect(themeInit).toContain(`localStorage.getItem("${DENSITY_STORAGE_KEY}")`);
    expect(themeInit).toContain(`localStorage.getItem("${MOTION_STORAGE_KEY}")`);
  });
});
