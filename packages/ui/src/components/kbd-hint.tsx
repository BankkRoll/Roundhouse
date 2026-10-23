import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/** Props for {@link KbdHint}. */
export interface KbdHintProps extends Omit<ComponentProps<"span">, "children"> {
  /** Keys shown in order, e.g. `["G", "S"]` or `["⌘", "K"]`. */
  keys: readonly string[];
}

/**
 * Mono keyboard hint ("G S"). Decorative: the action it describes must be reachable some
 * other way, so it is hidden from assistive tech.
 *
 * @param props - Span props plus the `keys` to show.
 * @returns The rendered hint.
 */
export function KbdHint({ keys, className, ...props }: KbdHintProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex items-center gap-1 font-mono text-[11px] text-subtle-foreground",
        className,
      )}
      {...props}
    >
      {keys.map((key, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: keys can repeat and never reorder
        <kbd key={index} className="font-mono">
          {key}
        </kbd>
      ))}
    </span>
  );
}
