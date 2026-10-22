import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/**
 * Log-style data table: dense rows separated by hairlines. Wrapped in a horizontally
 * scrollable container so wide tables never break the layout.
 *
 * @param props - Table props.
 * @returns The rendered table.
 */
export function Table({ className, ...props }: ComponentProps<"table">) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table
        className={cn("w-full caption-bottom border-collapse text-sm", className)}
        {...props}
      />
    </div>
  );
}

/**
 * Table header group.
 *
 * @param props - Thead props.
 * @returns The rendered header group.
 */
export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={cn("[&_tr]:border-b", className)} {...props} />;
}

/**
 * Table body.
 *
 * @param props - Tbody props.
 * @returns The rendered body.
 */
export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

/**
 * Table row with a hairline separator and hover tint.
 *
 * @param props - Tr props.
 * @returns The rendered row.
 */
export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      className={cn("border-b border-border transition-colors hover:bg-muted/40", className)}
      {...props}
    />
  );
}

/**
 * Column header cell in the small uppercase mono label style.
 *
 * @param props - Th props.
 * @returns The rendered header cell.
 */
export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "h-8 px-3 text-left align-middle font-mono text-[10px] font-medium uppercase tracking-[0.1em] whitespace-nowrap text-subtle-foreground",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Body cell.
 *
 * @param props - Td props.
 * @returns The rendered cell.
 */
export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("px-3 py-2 align-middle", className)} {...props} />;
}
