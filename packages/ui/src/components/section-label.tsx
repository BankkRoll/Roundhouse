import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/**
 * Small uppercase, letter-spaced mono label used above groups ("FLEET", "PROJECTS").
 *
 * @param props - Paragraph props.
 * @returns The rendered label.
 */
export function SectionLabel({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      className={cn(
        "font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-subtle-foreground",
        className,
      )}
      {...props}
    />
  );
}
