import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/**
 * Bordered surface one step lighter than the page.
 *
 * @param props - Div props.
 * @returns The rendered card.
 */
export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-lg border border-border bg-surface", className)} {...props} />;
}

/**
 * Card header row. Lays out a title block and an optional trailing action.
 *
 * @param props - Div props.
 * @returns The rendered header.
 */
export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex items-start justify-between gap-3 px-4 pt-4 pb-3", className)}
      {...props}
    />
  );
}

/**
 * Card title.
 *
 * @param props - Heading props.
 * @returns The rendered title.
 */
export function CardTitle({ className, ...props }: ComponentProps<"h3">) {
  return <h3 className={cn("text-sm font-semibold text-foreground", className)} {...props} />;
}

/**
 * Secondary text under a card title.
 *
 * @param props - Paragraph props.
 * @returns The rendered description.
 */
export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("mt-0.5 text-xs text-muted-foreground", className)} {...props} />;
}

/**
 * Card body.
 *
 * @param props - Div props.
 * @returns The rendered content area.
 */
export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-4 pb-4", className)} {...props} />;
}

/**
 * Card footer separated by a hairline.
 *
 * @param props - Div props.
 * @returns The rendered footer.
 */
export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex items-center gap-2 border-t border-border px-4 py-3", className)}
      {...props}
    />
  );
}
