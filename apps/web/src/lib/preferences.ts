/**
 * Per-browser display preferences that are not the theme: table density and motion.
 * Stored in localStorage (every access guarded, since storage can throw in private
 * windows or when blocked) and applied as attributes on `<html>` that the stylesheet in
 * `@roundhouse/ui` reads. One store for the page, so every caller sees the same values and
 * changes from other tabs are picked up.
 *
 * The theme keeps its own store in `use-theme.ts`.
 *
 * @module
 */
import { useSyncExternalStore } from "react";

/** Row spacing in tables and data lists. */
export type Density = "comfortable" | "compact";

/** Motion: follow the OS, always reduce, or always allow. */
export type MotionPreference = "system" | "reduce" | "allow";

/** localStorage key for {@link Density}. Mirrored in `public/theme-init.js`. */
export const DENSITY_STORAGE_KEY = "roundhouse.density";

/** localStorage key for {@link MotionPreference}. Mirrored in `public/theme-init.js`. */
export const MOTION_STORAGE_KEY = "roundhouse.motion";

/** Every display preference. */
export interface Preferences {
  density: Density;
  motion: MotionPreference;
}

const DEFAULTS: Preferences = { density: "comfortable", motion: "system" };

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // NOTE: Storage blocked: the preference still applies until the page is closed.
  }
}

/**
 * Reads the stored preferences, falling back to the defaults for anything missing,
 * unknown or unreadable.
 *
 * @returns Density and motion.
 */
export function readPreferences(): Preferences {
  const density = read(DENSITY_STORAGE_KEY);
  const motion = read(MOTION_STORAGE_KEY);
  return {
    density: density === "compact" ? "compact" : DEFAULTS.density,
    motion: motion === "reduce" || motion === "allow" ? motion : DEFAULTS.motion,
  };
}

/**
 * Sets the attributes the stylesheet reads: `data-density="compact"` and
 * `data-motion="reduce" | "allow"`. Defaults remove the attribute.
 *
 * @param preferences - Values to apply.
 * @param root - Element to mark. Defaults to `<html>`.
 */
export function applyPreferences(
  preferences: Preferences,
  root: HTMLElement = document.documentElement,
): void {
  if (preferences.density === "compact") root.dataset.density = "compact";
  else delete root.dataset.density;
  if (preferences.motion === "system") delete root.dataset.motion;
  else root.dataset.motion = preferences.motion;
}

const listeners = new Set<() => void>();
let snapshot: Preferences = DEFAULTS;

function refresh(): boolean {
  const next = readPreferences();
  if (next.density === snapshot.density && next.motion === snapshot.motion) return false;
  snapshot = next;
  return true;
}

function onStorage(event: StorageEvent): void {
  if (event.key !== null && event.key !== DENSITY_STORAGE_KEY && event.key !== MOTION_STORAGE_KEY) {
    return;
  }
  if (refresh()) {
    applyPreferences(snapshot);
    for (const listener of listeners) listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot(): Preferences {
  // NOTE: With no subscribers nothing keeps the snapshot current, so re-read storage
  // before the first render that subscribes again.
  if (listeners.size === 0) refresh();
  return snapshot;
}

/**
 * Stores, applies and broadcasts one preference.
 *
 * @param key - Which preference.
 * @param value - Its new value.
 */
export function setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
  const storageKey = key === "density" ? DENSITY_STORAGE_KEY : MOTION_STORAGE_KEY;
  write(storageKey, value === DEFAULTS[key] ? null : value);
  snapshot = { ...getSnapshot(), [key]: value };
  applyPreferences(snapshot);
  for (const listener of listeners) listener();
}

/**
 * The display preferences, shared by every caller.
 *
 * @returns Current density and motion, and a setter.
 * @example
 * const { density, set } = usePreferences();
 * set("density", density === "compact" ? "comfortable" : "compact");
 */
export function usePreferences() {
  const preferences = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...preferences, set: setPreference };
}
