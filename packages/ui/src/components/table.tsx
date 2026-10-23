import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/** Props for {@link Table}. */
export interface TableProps extends ComponentProps<"table"> {
  /**
   * Below 640px, lay each row out as a two-line item instead of scrolling sideways. Mark
   * the identity cell with `cell="primary"` and the row action with `cell="action"`; the
   * other cells move to line 2.
   */
  stack?: boolean;
}

/**
 * Data table: rows split by hairlines, no header band. Wide tables scroll inside their
 * own box so they never push the page sideways; pass `stack` to turn rows into stacked
 * items on phones instead.
 *
 * @param props - Table props plus `stack`.
 * @returns The rendered table.
 * @example
 * <Table stack>
 *   <TableBody>
 *     <TableRow>
 *       <TableCell cell="primary">web</TableCell>
 *       <TableCell>2h ago</TableCell>
 *       <TableCell cell="action"><Button size="sm">Logs</Button></TableCell>
 *     </TableRow>
 *   </TableBody>
 * </Table>
 */
export function Table({ className, stack = false, ...props }: TableProps) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table
        className={cn(
          "w-full caption-bottom border-collapse text-sm",
          stack && "table-stack",
          className,
        )}
        {...props}
      />
    </div>
  );
}

/**
 * Table header group. The header row carries the table's one strong rule.
 *
 * @param props - Thead props.
 * @returns The rendered header group.
 */
export function TableHeader({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={cn("[&_tr]:border-b [&_tr]:border-border", className)} {...props} />;
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
 * Table row with a hairline separator and a faint hover tint.
 *
 * @param props - Tr props.
 * @returns The rendered row.
 */
export function TableRow({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      className={cn(
        "border-b border-border/70 transition-colors hover:bg-muted/30 [thead_&]:hover:bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Column header cell: small grey sentence-case label. Right-align numeric columns with
 * `text-right` so the header sits flush with its figures.
 *
 * @param props - Th props.
 * @returns The rendered header cell.
 */
export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "h-9 px-3 text-left align-middle text-xs font-normal whitespace-nowrap text-muted-foreground first:pl-0 last:pr-0",
        className,
      )}
      {...props}
    />
  );
}

/** Props for {@link TableCell}. */
export interface TableCellProps extends ComponentProps<"td"> {
  /**
   * Role of the cell when a {@link Table} with `stack` collapses on a phone: `primary`
   * leads line 1, `action` sits at its right, `hide-mobile` drops out.
   */
  cell?: "primary" | "action" | "hide-mobile";
}

/**
 * Body cell. Its vertical padding follows the table density preference.
 *
 * @param props - Td props plus `cell`.
 * @returns The rendered cell.
 */
export function TableCell({ className, cell, ...props }: TableCellProps) {
  return (
    <td
      data-cell={cell}
      className={cn("px-3 py-(--cell-py) align-middle first:pl-0 last:pr-0", className)}
      {...props}
    />
  );
}
