import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/** Props for {@link Tooltip}. */
export interface TooltipProps {
  /** Tooltip text. */
  content: ReactNode;
  /** The element that shows the tooltip on hover/focus. Must accept a ref. */
  children: ReactNode;
  /** Preferred side. Defaults to `top`. */
  side?: "top" | "right" | "bottom" | "left";
  /** Extra classes for the tooltip bubble. */
  className?: string;
}

/**
 * Hover/focus tooltip. Includes its own provider so it can be dropped in anywhere.
 *
 * Disabled buttons do not emit pointer events, so wrap them in a focusable `<span>` when
 * the tooltip explains why the control is disabled.
 *
 * @param props - Tooltip content, trigger and placement.
 * @returns The trigger with an attached tooltip.
 * @example
 * <Tooltip content="Projects arrive in Phase 1">
 *   <span tabIndex={0}><Button disabled>New project</Button></span>
 * </Tooltip>
 */
export function Tooltip({ content, children, side = "top", className }: TooltipProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={200}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            sideOffset={6}
            className={cn(
              "z-50 rounded-md border border-border-strong bg-surface-raised px-2 py-1 text-xs text-foreground shadow-lg",
              className,
            )}
          >
            {content}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
