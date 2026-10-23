/**
 * Keyboard model for the header's Product menu: items are laid out in groups (columns), so
 * up and down walk the items in order and left and right jump between groups.
 *
 * @module
 */

/** Keys the menu handles; anything else is left to the browser. */
export type MenuKey = "ArrowDown" | "ArrowUp" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

/**
 * Index of the item a key moves focus to.
 *
 * @param key - The pressed key.
 * @param current - Index of the focused item, or -1 when focus is on the trigger.
 * @param groups - Group index of every item, in DOM order (e.g. `[0, 0, 1, 1, 1, 2]`).
 * @returns The next index, or `null` when the key is not a menu key or there are no items.
 * @example
 * nextMenuItem("ArrowRight", 0, [0, 0, 1, 1]); // 2
 */
export function nextMenuItem(
  key: string,
  current: number,
  groups: readonly number[],
): number | null {
  const count = groups.length;
  if (count === 0) return null;
  const from = current < 0 || current >= count ? -1 : current;
  switch (key) {
    case "ArrowDown":
      return (from + 1) % count;
    case "ArrowUp":
      return from <= 0 ? count - 1 : from - 1;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    case "ArrowRight":
    case "ArrowLeft": {
      const starts = groupStarts(groups);
      const group = from < 0 ? -1 : (groups[from] ?? 0);
      const position = starts.findIndex((start) => groups[start] === group);
      const step = key === "ArrowRight" ? 1 : -1;
      const nextPosition =
        position < 0
          ? step > 0
            ? 0
            : starts.length - 1
          : (position + step + starts.length) % starts.length;
      return starts[nextPosition] ?? 0;
    }
    default:
      return null;
  }
}

function groupStarts(groups: readonly number[]): number[] {
  const starts: number[] = [];
  groups.forEach((group, index) => {
    if (index === 0 || groups[index - 1] !== group) starts.push(index);
  });
  return starts;
}
