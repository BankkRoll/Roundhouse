// Applies a stored dark/light preference before first paint. Loaded as a classic script
// from index.html because the CSP forbids inline scripts.
// NOTE: The key must match THEME_STORAGE_KEY in packages/ui/src/lib/theme.ts; this file
// cannot import it, so src/lib/use-theme.test.tsx asserts they agree.
try {
  const theme = localStorage.getItem("roundhouse.theme");
  if (theme === "dark" || theme === "light") document.documentElement.classList.add(theme);
} catch {
  // Storage blocked: fall back to the OS preference.
}
