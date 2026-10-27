import { READONLY_DB_USER, type ServiceDatabaseEngine } from "@roundhouse/shared";
import { Button, cn, EmptyState, Label, Skeleton, Textarea } from "@roundhouse/ui";
import { SegmentedControl } from "@roundhouse/ui/controls";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DatabaseIcon,
  EyeIcon,
  FolderIcon,
  FolderOpenIcon,
  LockIcon,
  PlayIcon,
  TableIcon,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, useId, useState } from "react";
import { ErrorState } from "../../components/error-state";
import { errorMessage, isApiError } from "../../lib/api/client";
import type { DatabaseQueryOp, DatabaseQueryResult } from "../../lib/api/data-client";
import { usePermissions } from "../../lib/permissions";
import { useBrowseQuery, useDatabaseQuery, useDatabaseSchema } from "../../queries/databases";
import { useEnvironmentGate } from "../access/environment-gate";
import { findService, useProjectEnvironment } from "../projects/use-project-environment";
import type { ServicePageProps } from "../services/service-layout";
import { ResultGrid } from "./result-grid";

/** Rows per page of the rows grid (ADR 0004). */
export const DATA_PAGE_SIZE = 100;

/** A relation picked in the schema tree. */
interface SelectedTable {
  namespace: string;
  table: string;
}

const QUERY_HINTS: Record<ServiceDatabaseEngine, { placeholder: string; hint: string }> = {
  postgres: {
    placeholder: "SELECT * FROM public.customers LIMIT 20",
    hint: "One SQL statement, run in a read-only transaction.",
  },
  mysql: {
    placeholder: "SELECT * FROM app.customers LIMIT 20",
    hint: "One SQL statement, run in a read-only transaction.",
  },
  redis: {
    placeholder: "GET session:42",
    hint: "One command; arguments are split on spaces. Write commands are refused.",
  },
  mongodb: {
    placeholder: '{ "find": "customers", "limit": 20 }',
    hint: "A command document as JSON. Write commands are refused.",
  },
};

/** The first column of each row: the names in a namespace or table listing. */
function names(result: DatabaseQueryResult | undefined): string[] {
  return (result?.ok ? (result.rows ?? []) : []).map((row) => String(row[0] ?? ""));
}

function unavailableMessage(error: unknown): { title: string; description: string } | null {
  if (isApiError(error, 409)) {
    return { title: "The database isn't running here", description: errorMessage(error) };
  }
  if (isApiError(error, 503)) {
    return { title: "The database's server is offline", description: errorMessage(error) };
  }
  return null;
}

function Namespace({
  serviceId,
  environmentId,
  namespace,
  defaultOpen,
  selected,
  onSelect,
}: {
  serviceId: string;
  environmentId: string;
  namespace: string;
  defaultOpen: boolean;
  selected: SelectedTable | null;
  onSelect: (table: SelectedTable) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const tables = useBrowseQuery(
    serviceId,
    environmentId,
    open ? { type: "list_tables", namespace } : null,
  );
  const Icon = open ? FolderOpenIcon : FolderIcon;
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="truncate font-mono text-[13px]">{namespace}</span>
      </button>
      {open ? (
        tables.isPending ? (
          <Skeleton className="mt-1 ml-6 h-4 w-28" />
        ) : tables.isError ? (
          <p className="ml-6 py-1 text-xs text-danger">{errorMessage(tables.error)}</p>
        ) : !tables.data.ok ? (
          <p className="ml-6 py-1 text-xs text-danger">{tables.data.error}</p>
        ) : (
          <ul aria-label={`Tables in ${namespace}`} className="ml-4 border-l border-border pl-2">
            {names(tables.data).length === 0 ? (
              <li className="px-2 py-1 text-xs text-muted-foreground">Empty</li>
            ) : null}
            {names(tables.data).map((table) => {
              const active = selected?.namespace === namespace && selected.table === table;
              return (
                <li key={table}>
                  <button
                    type="button"
                    aria-current={active ? "true" : undefined}
                    onClick={() => onSelect({ namespace, table })}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                      active && "bg-accent-subtle text-accent-text hover:bg-accent-subtle",
                    )}
                  >
                    <TableIcon
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="truncate font-mono text-[13px]">{table}</span>
                  </button>
                </li>
              );
            })}
            {tables.data.notice?.startsWith("cursor:") && tables.data.notice !== "cursor:0" ? (
              <li className="px-2 py-1 text-xs text-muted-foreground">More keys not shown</li>
            ) : null}
          </ul>
        )
      ) : null}
    </li>
  );
}

function RowsView({
  serviceId,
  environmentId,
  table,
}: {
  serviceId: string;
  environmentId: string;
  table: SelectedTable | null;
}) {
  const [offset, setOffset] = useState(0);
  const [shown, setShown] = useState(table);
  if (shown !== table) {
    setShown(table);
    setOffset(0);
  }
  const op: DatabaseQueryOp | null = table
    ? { type: "rows", namespace: table.namespace, table: table.table, offset }
    : null;
  const rows = useBrowseQuery(serviceId, environmentId, op);

  if (!table) {
    return (
      <EmptyState
        icon={<TableIcon />}
        title="Pick a table"
        description="Its rows show here, 100 at a time."
        className="py-16"
      />
    );
  }
  if (rows.isPending) return <Skeleton className="h-64" />;
  if (rows.isError) {
    return <ErrorState message={errorMessage(rows.error)} onRetry={() => void rows.refetch()} />;
  }
  const label = `${table.namespace}.${table.table}`;
  return (
    <ResultGrid
      result={rows.data}
      label={`${label} rows`}
      firstRow={offset + 1}
      actions={
        <div className="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Previous page"
            disabled={offset === 0 || rows.isFetching}
            onClick={() => setOffset(Math.max(0, offset - DATA_PAGE_SIZE))}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Next page"
            disabled={!rows.data.truncated || rows.isFetching}
            onClick={() => setOffset(offset + DATA_PAGE_SIZE)}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      }
    />
  );
}

function QueryView({
  serviceId,
  environmentId,
  engine,
}: {
  serviceId: string;
  environmentId: string;
  engine: ServiceDatabaseEngine;
}) {
  const run = useDatabaseQuery(serviceId);
  const [text, setText] = useState("");
  const id = useId();
  const hints = QUERY_HINTS[engine];

  function submit() {
    const statement = text.trim();
    if (!statement || run.isPending) return;
    const op: DatabaseQueryOp =
      engine === "redis"
        ? { type: "raw", argv: statement.split(/\s+/) }
        : { type: "raw", statement };
    run.mutate({ environment_id: environmentId, mode: "read", op, max_rows: DATA_PAGE_SIZE });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    submit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="grid gap-4">
      <form onSubmit={onSubmit} className="grid gap-2" aria-label="Query">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={id}>Read-only query</Label>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <LockIcon className="size-3" aria-hidden="true" />
            as {READONLY_DB_USER}
          </span>
        </div>
        <Textarea
          id={id}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={hints.placeholder}
          spellCheck={false}
          aria-describedby={`${id}-hint`}
          rows={5}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {hints.hint} At most {DATA_PAGE_SIZE} rows are returned. Raw queries are audited.
          </p>
          <Button type="submit" variant="primary" loading={run.isPending} disabled={!text.trim()}>
            {run.isPending ? null : <PlayIcon />}
            Run
          </Button>
        </div>
      </form>
      {run.isError ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(run.error)}
        </p>
      ) : run.data ? (
        <ResultGrid result={run.data} label="Query result" />
      ) : null}
    </div>
  );
}

/**
 * A database service's Data tab (ADR 0004): the schema tree on the left, and on the
 * right either a table's rows (100 a page) or a read-only query box. Everything runs as
 * the read-only principal; writing isn't offered here. Results stay in the browser and
 * "Copy as CSV" only touches the clipboard.
 *
 * @param props - Workspace, project and service ids.
 * @returns The tab.
 */
export function DataTab({ workspaceId, projectId, serviceId }: ServicePageProps) {
  const { project, environment } = useProjectEnvironment(projectId);
  const service = findService(project.data, serviceId);
  const { role } = usePermissions(workspaceId);
  const { can } = useEnvironmentGate(workspaceId, projectId, environment);
  const allowed = can("data:read");
  const engine = service?.database?.engine;
  const schema = useDatabaseSchema(serviceId, environment?.id, allowed && Boolean(engine));
  const [view, setView] = useState<"rows" | "query">("rows");
  const [selected, setSelected] = useState<SelectedTable | null>(null);

  if (!service || role === undefined) {
    return <Skeleton className="h-64" aria-busy="true" />;
  }
  if (!engine) {
    return (
      <EmptyState
        icon={<DatabaseIcon />}
        title="Not a database"
        description="The data browser is for database services."
        className="py-16"
      />
    );
  }
  if (!allowed) {
    return (
      <EmptyState
        icon={<LockIcon />}
        title="You can't browse this database"
        description="Reading data needs the data:read permission, which your role doesn't have."
        className="py-16"
      />
    );
  }
  if (schema.isPending || !environment) return <Skeleton className="h-64" aria-busy="true" />;
  if (schema.isError) {
    const unavailable = unavailableMessage(schema.error);
    return unavailable ? (
      <EmptyState
        icon={<DatabaseIcon />}
        title={unavailable.title}
        description={unavailable.description}
        action={
          <Button size="sm" onClick={() => void schema.refetch()}>
            Try again
          </Button>
        }
        className="py-16"
      />
    ) : (
      <ErrorState message={errorMessage(schema.error)} onRetry={() => void schema.refetch()} />
    );
  }

  const namespaces = names(schema.data.namespaces);
  const preferred = namespaces.includes("public") ? "public" : namespaces[0];

  return (
    <section aria-label="Data" className="grid min-w-0 gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <nav aria-label="Schema" className="min-w-0 lg:border-r lg:border-border lg:pr-4">
        <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <EyeIcon className="size-3" aria-hidden="true" />
          Read-only
        </p>
        {schema.data.namespaces.ok ? (
          <ul aria-label="Namespaces" className="grid gap-0.5">
            {namespaces.map((namespace) => (
              <Namespace
                key={namespace}
                serviceId={serviceId}
                environmentId={environment.id}
                namespace={namespace}
                defaultOpen={namespace === preferred}
                selected={selected}
                onSelect={(table) => {
                  setSelected(table);
                  setView("rows");
                }}
              />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-danger">{schema.data.namespaces.error}</p>
        )}
      </nav>
      <div className="grid min-w-0 content-start gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SegmentedControl<"rows" | "query">
            label="Data view"
            value={view}
            onValueChange={setView}
            options={[
              { value: "rows", label: "Rows" },
              { value: "query", label: "Query" },
            ]}
          />
          {view === "rows" && selected ? (
            <p className="truncate font-mono text-sm text-foreground">
              {selected.namespace}.{selected.table}
            </p>
          ) : null}
        </div>
        {view === "rows" ? (
          <RowsView serviceId={serviceId} environmentId={environment.id} table={selected} />
        ) : (
          <QueryView serviceId={serviceId} environmentId={environment.id} engine={engine} />
        )}
      </div>
    </section>
  );
}
