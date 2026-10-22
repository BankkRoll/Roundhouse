/**
 * Copies text to the clipboard.
 *
 * @param text - Text to copy.
 * @returns Resolves to `true` when the copy succeeded.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }
  // COMPAT: The async clipboard API only exists in secure contexts. Self-hosted dashboards
  // are often reached over plain http on a LAN IP, so fall back to execCommand there.
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand?.("copy") ?? false;
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}
