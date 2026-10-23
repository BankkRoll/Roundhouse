/** A user's theme preference. `system` follows `prefers-color-scheme`. */
export type ThemePreference = "system" | "dark" | "light";

/** localStorage key holding the user's theme preference. */
export const THEME_STORAGE_KEY = "roundhouse.theme";

/**
 * Applies a theme preference by toggling `.dark` / `.light` on the root element.
 *
 * @param preference - Theme to apply. `system` removes both classes so the stylesheet's
 *   media query decides.
 * @param root - Element to toggle classes on. Defaults to `<html>`.
 */
export function applyTheme(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement,
): void {
  root.classList.toggle("dark", preference === "dark");
  root.classList.toggle("light", preference === "light");
}

/**
 * Reads the stored theme preference.
 *
 * @returns The stored preference, or `system` when nothing valid is stored or storage is
 *   unavailable.
 */
export function readThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === "dark" || value === "light" ? value : "system";
  } catch {
    return "system";
  }
}

/**
 * Persists and applies a theme preference.
 *
 * @param preference - Theme to store and apply.
 */
export function storeThemePreference(preference: ThemePreference): void {
  try {
    if (preference === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // NOTE: Storage can throw in private mode; the theme still applies for this session.
  }
  applyTheme(preference);
}

/**
 * Resolves which palette is currently showing.
 *
 * @param preference - The user's preference.
 * @returns `dark` or `light`, consulting `prefers-color-scheme` for `system`.
 */
export function resolveTheme(preference: ThemePreference): "dark" | "light" {
  if (preference !== "system") return preference;
  const prefersLight =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches;
  return prefersLight ? "light" : "dark";
}
