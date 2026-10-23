import { Badge, Button, cn, EmptyState, Input, Skeleton } from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { ErrorState } from "../../components/error-state";
import { PageHeader } from "../../components/page-header";
import { errorMessage } from "../../lib/api/client";
import type {
  TemplateCategory,
  TemplateDetail,
  TemplateSummary,
} from "../../lib/api/templates-types";
import { useTemplateDetails, useTemplates } from "../../queries/templates";
import {
  CATEGORY_LABELS,
  describeTemplateSource,
  requirementsLabel,
  TemplateIcon,
} from "./template-meta";

type CategoryFilter = TemplateCategory | "all";

function matches(template: TemplateSummary, query: string): boolean {
  if (!query) return true;
  const haystack = [template.name, template.description, ...template.tags].join(" ").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

function sourceHint(detail: TemplateDetail | undefined): string | null {
  if (!detail) return null;
  return [...new Set(detail.services.map((service) => describeTemplateSource(service.source)))]
    .slice(0, 2)
    .join(", ");
}

function CategoryFilters({
  categories,
  value,
  onChange,
}: {
  categories: readonly TemplateCategory[];
  value: CategoryFilter;
  onChange: (value: CategoryFilter) => void;
}) {
  const options: { value: CategoryFilter; label: string }[] = [
    { value: "all", label: "All" },
    ...categories.map((category) => ({ value: category, label: CATEGORY_LABELS[category] })),
  ];
  return (
    <fieldset className="flex min-w-0 flex-wrap gap-1.5">
      <legend className="sr-only">Category</legend>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-7 rounded-md border border-border px-2.5 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            value === option.value && "border-border-strong bg-muted text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </fieldset>
  );
}

function TemplateRow({
  workspaceId,
  template,
  detail,
}: {
  workspaceId: string;
  template: TemplateSummary;
  detail: TemplateDetail | undefined;
}) {
  const hint = sourceHint(detail);
  const services = `${template.service_count} ${template.service_count === 1 ? "service" : "services"}`;
  return (
    <li
      aria-disabled={template.supported ? undefined : true}
      className={cn(
        "relative grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 py-3.5 sm:grid-cols-[auto_minmax(0,1fr)_11rem] sm:gap-x-4",
        template.supported ? "transition-colors hover:bg-muted/30" : "opacity-60",
      )}
    >
      <TemplateIcon icon={template.icon} />
      <div className="min-w-0">
        <h3 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-foreground">
          {template.supported ? (
            <Link
              to="/w/$workspaceId/templates/$templateId"
              params={{ workspaceId, templateId: template.id }}
              className="truncate outline-none after:absolute after:inset-0 focus-visible:underline"
            >
              {template.name}
            </Link>
          ) : (
            <span className="truncate">{template.name}</span>
          )}
          {template.supported ? null : (
            <Badge tone="warning">{requirementsLabel(template.requirements)}</Badge>
          )}
        </h3>
        <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-muted-foreground">
          {template.description}
        </p>
        {hint ? (
          <p className="mt-1 truncate font-mono text-xs text-subtle-foreground">{hint}</p>
        ) : null}
      </div>
      <p className="col-start-2 flex gap-3 text-xs text-muted-foreground sm:col-start-3 sm:justify-end sm:pt-0.5">
        <span>{CATEGORY_LABELS[template.category]}</span>
        <span className="tabular-nums">{services}</span>
      </p>
    </li>
  );
}

function LoadingRows() {
  return (
    <ul aria-label="Loading templates" className="divide-y divide-border/70">
      {[0, 1, 2, 3].map((index) => (
        <li key={index} className="flex items-center gap-3 py-3.5">
          <Skeleton className="size-8" />
          <div className="grid flex-1 gap-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-full max-w-md" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The template gallery: search by name, description or tag, filter by category, and
 * open a template to deploy it. Unsupported templates are listed but can't be opened.
 *
 * @param props - Workspace id.
 * @returns The page.
 */
export function TemplatesPage({ workspaceId }: { workspaceId: string }) {
  const templates = useTemplates(workspaceId);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const searchId = useId();
  const all = templates.data ?? [];
  // PERF: The summary carries no sources, so the hints come from each detail. The
  // catalogue is small and built in, and the details are cached for the detail page.
  const details = useTemplateDetails(
    workspaceId,
    useMemo(() => (templates.data ?? []).map((template) => template.id), [templates.data]),
  );
  const categories = (Object.keys(CATEGORY_LABELS) as TemplateCategory[]).filter((c) =>
    all.some((template) => template.category === c),
  );
  const trimmed = query.trim();
  const visible = all.filter(
    (template) =>
      (category === "all" || template.category === category) && matches(template, trimmed),
  );

  return (
    <>
      <PageHeader
        title="Templates"
        subline="Starting points that create services, config and variables in one step."
      />
      {templates.isPending ? (
        <LoadingRows />
      ) : templates.isError ? (
        <ErrorState
          title="Couldn't load templates"
          message={errorMessage(templates.error)}
          onRetry={() => void templates.refetch()}
        />
      ) : (
        <>
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="relative w-full md:max-w-xs">
              <label htmlFor={searchId} className="sr-only">
                Search templates
              </label>
              <SearchIcon
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-subtle-foreground"
              />
              <Input
                id={searchId}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search templates"
                className="pl-8"
              />
            </div>
            <CategoryFilters categories={categories} value={category} onChange={setCategory} />
          </div>
          {visible.length > 0 ? (
            <ul
              aria-label="Templates"
              className="divide-y divide-border/70 border-y border-border/70"
            >
              {visible.map((template) => (
                <TemplateRow
                  key={template.id}
                  workspaceId={workspaceId}
                  template={template}
                  detail={details.get(template.id)}
                />
              ))}
            </ul>
          ) : (
            <EmptyState
              icon={<SearchIcon />}
              title={trimmed ? `No templates match "${trimmed}"` : "No templates here"}
              description="Try another word, or show every category."
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setQuery("");
                    setCategory("all");
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          )}
        </>
      )}
    </>
  );
}
