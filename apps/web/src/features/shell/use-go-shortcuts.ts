import { createShortcutHandler, isOverlayOpen } from "@openrail/ui";
import { useEffect, useRef } from "react";
import { NAV_ITEMS, type NavPath } from "./nav";

/**
 * Binds the "G then <key>" navigation shortcuts listed in {@link NAV_ITEMS}. They are
 * ignored while a dialog, menu or listbox is open, so typing there never navigates away.
 *
 * @param navigate - Called with the target route when a sequence completes.
 */
export function useGoShortcuts(navigate: (to: NavPath) => void): void {
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    const handler = createShortcutHandler(
      NAV_ITEMS.flatMap((item) =>
        item.shortcut
          ? [{ keys: ["g", item.shortcut], run: () => navigateRef.current(item.to) }]
          : [],
      ),
      { isSuspended: isOverlayOpen },
    );
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
