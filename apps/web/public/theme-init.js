// Applies stored display preferences (theme, table density, motion) before first paint.
// Loaded as a classic script from index.html because the CSP forbids inline scripts.
// NOTE: The keys must match THEME_STORAGE_KEY in packages/ui/src/lib/theme.ts and
// DENSITY_STORAGE_KEY / MOTION_STORAGE_KEY in src/lib/preferences.ts; this file cannot
// import them, so src/lib/use-theme.test.tsx and preferences.test.ts assert they agree.
try {
  const root = document.documentElement;
  const theme = localStorage.getItem("openrail.theme");
  if (theme === "dark" || theme === "light") root.classList.add(theme);
  if (localStorage.getItem("openrail.density") === "compact") root.dataset.density = "compact";
  const motion = localStorage.getItem("openrail.motion");
  if (motion === "reduce" || motion === "allow") root.dataset.motion = motion;
} catch {
  // Storage blocked: fall back to the defaults and the OS preferences.
}
