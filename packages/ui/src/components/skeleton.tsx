import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/**
 * Loading placeholder block. Hidden from assistive tech; announce loading at the region
 * level when it matters.
 *
 * @param props - Div props; size it with classes.
 * @returns The rendered skeleton.
 */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  );
}
