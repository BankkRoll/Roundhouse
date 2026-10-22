import { Label as LabelPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/**
 * Form label.
 *
 * @param props - Radix label props (`htmlFor`, children, ...).
 * @returns The rendered label.
 */
export function Label({ className, ...props }: ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn("text-xs font-medium text-muted-foreground select-none", className)}
      {...props}
    />
  );
}
