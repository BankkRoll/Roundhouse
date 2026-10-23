/**
 * One theme store for the whole page. Every {@link useTheme} caller reads the same
 * snapshot, so toggling from the command palette updates the sidebar button too. While
 * the preference is `system`, the store follows OS light/dark changes, and it picks up
 * changes made in other tabs.
 *
 * @module
 */
import {
  readThemePreference,
  resolveTheme,
  storeThemePreference,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "@openrail/ui";
import { useSyncExternalStore } from "react";

/** The theme as the page is currently showing it. */
export interface ThemeSnapshot {
  /** What the user chose. */
  preference: ThemePreference;
  /** The palette on screen; `system` resolved against `prefers-color-scheme`. */
  resolved: "dark" | "light";
}

const LIGHT_QUERY = "(prefers-color-scheme: light)";

const listeners = new Set<() => void>();
let snapshot: ThemeSnapshot = { preference: "system", resolved: "dark" };

/** Recomputes the snapshot, keeping its identity when nothing changed. */
function refresh(preference: ThemePreference = readThemePreference()): boolean {
  const resolved = resolveTheme(preference);
  if (snapshot.preference === preference && snapshot.resolved === resolved) return false;
  snapshot = { preference, resolved };
  return true;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function onSystemChange(): void {
  if (refresh()) emit();
}

function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
  if (refresh()) emit();
}

let media: MediaQueryList | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    media = typeof window.matchMedia === "function" ? window.matchMedia(LIGHT_QUERY) : undefined;
    media?.addEventListener?.("change", onSystemChange);
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    media?.removeEventListener?.("change", onSystemChange);
    media = undefined;
    window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): ThemeSnapshot {
  // NOTE: With no subscribers nothing keeps the snapshot current, so re-read storage
  // before the first render that subscribes again.
  if (listeners.size === 0) refresh();
  return snapshot;
}

/**
 * Stores and applies a theme preference, updating every subscriber.
 *
 * @param preference - `dark`, `light`, or `system` to follow the OS.
 */
export function setThemePreference(preference: ThemePreference): void {
  storeThemePreference(preference);
  refresh(preference);
  emit();
}

/** Flips between the dark and light palettes, pinning the result as the preference. */
export function toggleTheme(): void {
  setThemePreference(getSnapshot().resolved === "dark" ? "light" : "dark");
}

/**
 * The current theme, shared by every caller.
 *
 * @returns The preference, the palette on screen, a setter and a dark/light toggle.
 * @example
 * const theme = useTheme();
 * <button onClick={theme.toggle}>{theme.resolved === "dark" ? "Light" : "Dark"}</button>
 */
export function useTheme() {
  const { preference, resolved } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { preference, resolved, setPreference: setThemePreference, toggle: toggleTheme };
}
