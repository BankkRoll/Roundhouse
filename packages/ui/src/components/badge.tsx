import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/** Class recipe for {@link Badge}. */
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-sm border px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-wider whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "border-border-strong bg-muted text-muted-foreground",
        accent: "border-accent/40 bg-accent-subtle text-accent-text",
        success: "border-success/30 bg-success/10 text-success",
        warning: "border-warning/30 bg-warning/10 text-warning",
        danger: "border-danger/30 bg-danger/10 text-danger",
        info: "border-info/30 bg-info/10 text-info",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

/** Props for {@link Badge}. */
export interface BadgeProps extends ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

/**
 * Compact uppercase mono label, e.g. a role or a `STAGED` marker.
 *
 * @param props - Span props plus `tone`.
 * @returns The rendered badge.
 */
export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
