import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/**
 * Small grey sentence-case label above a group ("Projects", "Pending invites").
 *
 * @param props - Paragraph props.
 * @returns The rendered label.
 */
export function SectionLabel({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("text-xs font-medium text-muted-foreground", className)} {...props} />;
}
