import {
  Button,
  copyText,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@roundhouse/ui";
import { ClipboardCopyIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { DatabaseQueryResult } from "../../lib/api/data-client";
import { formatCell, toCsv } from "./database-meta";

/** Props for {@link ResultGrid}. */
export interface ResultGridProps {
  result: DatabaseQueryResult;
  /** Accessible name of the grid, e.g. "public.customers rows". */
  label: string;
  /** Controls beside the summary, e.g. paging. */
  actions?: ReactNode;
  /** Number of the first row, for the summary of a page. Defaults to 1. */
  firstRow?: number;
}

/**
 * A query result: an engine error, or a grid of cells with a summary line (rows, time,
 * truncation, the server's notice) and "Copy as CSV", which only touches the clipboard.
 *
 * @param props - Result, label, extra controls and the first row's number.
 * @returns The result view.
 */
export function ResultGrid({ result, label, actions, firstRow = 1 }: ResultGridProps) {
  if (!result.ok) {
    return (
      <div role="alert" className="rounded-md border border-danger/40 bg-danger/5 px-3 py-2.5">
        <p className="font-mono text-sm text-danger">{result.error ?? "The query failed."}</p>
        <p className="mt-1 text-xs text-muted-foreground tabular-nums">{result.duration_ms} ms</p>
      </div>
    );
  }
  const columns = result.columns ?? [];
  const rows = result.rows ?? [];
  const count = result.row_count ?? rows.length;
  const summary = [
    columns.length === 0
      ? `${count} ${count === 1 ? "row" : "rows"} affected`
      : rows.length === 0
        ? "No rows"
        : firstRow === 1 && !actions
          ? `${rows.length} ${rows.length === 1 ? "row" : "rows"}`
          : `Rows ${firstRow}–${firstRow + rows.length - 1}`,
    `${result.duration_ms} ms`,
  ];

  return (
    <div className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
          {summary.map((part) => (
            <span key={part}>{part}</span>
          ))}
          {result.truncated ? (
            <span className="text-warning" title="More rows exist than were returned">
              truncated
            </span>
          ) : null}
          {result.notice ? <span className="font-mono">{result.notice}</span> : null}
        </p>
        <div className="flex items-center gap-2">
          {actions}
          {columns.length > 0 ? (
            <Button
              size="sm"
              onClick={() =>
                void copyText(toCsv(columns, rows)).then((ok) =>
                  toast({
                    title: ok ? `Copied ${rows.length} rows as CSV` : "Could not copy",
                    tone: ok ? "success" : "error",
                  }),
                )
              }
            >
              <ClipboardCopyIcon />
              Copy as CSV
            </Button>
          ) : null}
        </div>
      </div>
      {columns.length > 0 ? (
        <div className="max-h-[32rem] overflow-auto rounded-md border border-border">
          <Table aria-label={label} className="font-mono text-xs">
            <TableHeader className="sticky top-0 bg-surface">
              <TableRow>
                {columns.map((column) => (
                  <TableHead key={column.name} className="px-3 first:pl-3 last:pr-3">
                    <span className="text-foreground">{column.name}</span>{" "}
                    <span className="text-muted-foreground/80">{column.type}</span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: result rows have no identity of their own
                <TableRow key={index}>
                  {columns.map((column, cell) => {
                    const text = formatCell(row[cell]);
                    return (
                      <TableCell
                        key={column.name}
                        title={text.length > 40 ? text : undefined}
                        className={
                          row[cell] === null || row[cell] === undefined
                            ? "max-w-72 truncate px-3 text-muted-foreground/70 italic first:pl-3 last:pr-3"
                            : "max-w-72 truncate px-3 text-foreground first:pl-3 last:pr-3"
                        }
                      >
                        {text}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}
