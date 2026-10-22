import { Switch as SwitchPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/**
 * On/off toggle (`role="switch"`). Label it with a `<Label htmlFor>` or `aria-label`.
 *
 * @param props - Radix switch props (`checked`, `onCheckedChange`, `disabled`, …).
 * @returns The rendered switch.
 * @example
 * <Switch id="domain" checked={on} onCheckedChange={setOn} />
 */
export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "peer inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border border-border-strong bg-muted p-px transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-accent-text data-[state=checked]:bg-accent",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-3.5 rounded-full bg-muted-foreground shadow transition-transform data-[state=checked]:translate-x-3.5 data-[state=checked]:bg-accent-foreground" />
    </SwitchPrimitive.Root>
  );
}
