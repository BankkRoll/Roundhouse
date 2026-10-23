import { createShortcutHandler, isOverlayOpen, type ShortcutBinding } from "@roundhouse/ui";
import { useEffect, useRef } from "react";
import { NAV_ITEMS, type NavPath } from "./nav";

/** A "G then <key>" shortcut that only exists on some pages, e.g. a service's tabs. */
export interface ContextShortcut {
  /** Second key, lowercase. */
  key: string;
  /** What the shortcut opens, for the palette hint and tests. */
  label: string;
  run: () => void;
}

/**
 * Binds the "G then <key>" navigation shortcuts listed in {@link NAV_ITEMS}, plus
 * page-specific ones that take precedence (on a service page, G L opens that service's
 * logs instead of the workspace Logs page). They are ignored while a dialog, menu or
 * listbox is open, so typing there never navigates away.
 *
 * @param navigate - Called with the target route when a sequence completes.
 * @param context - Shortcuts of the current page; may change between renders.
 */
export function useGoShortcuts(
  navigate: (to: NavPath) => void,
  context: readonly ContextShortcut[] = [],
): void {
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const contextRef = useRef(context);
  contextRef.current = context;
  const contextKeys = context.map((shortcut) => shortcut.key).join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: rebinding only when the set of keys changes; handlers are read through refs
  useEffect(() => {
    const contextual: ShortcutBinding[] = contextRef.current.map((shortcut) => ({
      keys: ["g", shortcut.key],
      run: () => contextRef.current.find((entry) => entry.key === shortcut.key)?.run(),
    }));
    const handler = createShortcutHandler(
      [
        ...contextual,
        ...NAV_ITEMS.flatMap((item) =>
          item.shortcut
            ? [{ keys: ["g", item.shortcut], run: () => navigateRef.current(item.to) }]
            : [],
        ),
      ],
      { isSuspended: isOverlayOpen },
    );
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [contextKeys]);
}
