import { cn } from "@roundhouse/ui";
import { ArrowDownIcon } from "lucide-react";
import { type CSSProperties, type MouseEvent, useId, useState } from "react";
import {
  ADVISORIES,
  ADVISORIES_AS_OF,
  type Advisory,
  type AdvisoryClass,
  CLASS_ORDER,
  CLASSES,
  countByClass,
  SEVERITY_LABEL,
  type SortKey,
  sortAdvisories,
} from "../model/cves";
import { defence } from "../model/defences";
import { buttonClass, ExternalLink } from "../ui";
import { goToSection } from "./header";

type Filter = AdvisoryClass | "all";

const PRODUCTS = [...new Set(ADVISORIES.map((advisory) => advisory.product))].sort();

const LINK =
  "rounded-sm underline decoration-muted-foreground underline-offset-4 outline-none transition-colors hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring";

const SELECT =
  "min-h-11 w-full cursor-pointer rounded-md bg-[var(--lp-step)] px-3 text-[16px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Rows shown before "Show all" when every kind is listed. */
const PREVIEW_ROWS = 8;

const step = (i: number) => ({ "--i": i }) as CSSProperties;

function formatDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return iso;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function onDefenceClick(event: MouseEvent<HTMLAnchorElement>) {
  const id = event.currentTarget.hash.slice(1);
  if (id && goToSection(id)) event.preventDefault();
}

/** The defences that stand in a class's way, as in-page links to their rows. */
function DefenceLinks({ kind }: { kind: AdvisoryClass }) {
  return (
    <>
      {CLASSES[kind].defences.map((id, index) => (
        <span key={id}>
          {index > 0 ? ", " : null}
          <a href={`#defence-${id}`} onClick={onDefenceClick} className={LINK}>
            {defence(id).title}
          </a>
        </span>
      ))}
    </>
  );
}

function SeverityText({ advisory }: { advisory: Advisory }) {
  const { severity, score } = advisory;
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span
        aria-hidden="true"
        className={cn(
          "size-2.5 shrink-0 rounded-full",
          severity === "critical" && "bg-danger",
          severity === "high" && "bg-warning",
          severity === "medium" && "bg-muted-foreground",
          severity === "low" && "bg-meter-track",
        )}
      />
      {SEVERITY_LABEL[severity]}
      {score === null ? null : (
        <span className="text-muted-foreground tabular-nums">{score.toFixed(1)}</span>
      )}
    </span>
  );
}

function fixedText(advisory: Advisory): string {
  if (!advisory.fixedVersion) return "no fixed version stated";
  return advisory.fixedSource
    ? `fixed in ${advisory.fixedVersion} (per ${advisory.fixedSource})`
    : `fixed in ${advisory.fixedVersion}`;
}

/** What a selected class means here, or the overview when nothing is selected. */
function ClassVerdict({ filter, count }: { filter: Filter; count: number }) {
  if (filter === "all") {
    return (
      <p className="max-w-[60ch] text-[20px] leading-snug text-foreground">
        {ADVISORIES.length} advisories for {listOf(PRODUCTS)}. Pick a kind of flaw to see which part
        of Roundhouse stands in its way.
      </p>
    );
  }
  const info = CLASSES[filter];
  return (
    <div className="grid max-w-[66ch] gap-3">
      <p className="text-[20px] leading-snug text-foreground">
        {count} {count === 1 ? "advisory" : "advisories"} for {info.term}. {info.why}
      </p>
      <p className="text-[17px] text-foreground">
        What stops it here: <DefenceLinks kind={filter} />.
      </p>
      {info.more ? (
        <p className="text-[16px] text-muted-foreground">
          These are examples: dozens more {info.term} advisories are listed on{" "}
          {info.more.map((page, index) => (
            <span key={page.url}>
              {index > 0 ? (index === (info.more?.length ?? 0) - 1 ? " and " : ", ") : null}
              <ExternalLink href={page.url} className={LINK}>
                {page.product}'s security page
              </ExternalLink>
            </span>
          ))}
          .
        </p>
      ) : null}
    </div>
  );
}

function SortButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-sm font-normal outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
      <ArrowDownIcon
        aria-hidden="true"
        className={cn("size-4 transition-opacity", active ? "opacity-100" : "opacity-0")}
      />
    </button>
  );
}

/**
 * The live thing of the security section: published advisories for comparable
 * self-hosted platforms, filtered by kind of flaw, each kind mapped to the Roundhouse
 * design choices that block or narrow it. A real table on wide screens; on a phone each
 * row stacks into its own block (see `.lp-advisories` in landing.css).
 *
 * @returns The filter, the verdict for the selected kind and the table.
 */
export function AdvisoryExplorer() {
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<SortKey>("date");
  const [expanded, setExpanded] = useState(false);
  const captionId = useId();
  const counts = countByClass(ADVISORIES);
  const matching = sortAdvisories(
    filter === "all" ? ADVISORIES : ADVISORIES.filter((advisory) => advisory.kind === filter),
    sort,
  );
  // NOTE: Every kind at once is a long table, so it opens on the first few and the rest
  // are one press away; a single kind is short enough to show whole.
  const visible =
    expanded || matching.length <= PREVIEW_ROWS ? matching : matching.slice(0, PREVIEW_ROWS);
  const options: [Filter, string, number][] = [
    ["all", "Every kind", ADVISORIES.length],
    ...CLASS_ORDER.filter((kind) => counts.has(kind)).map((kind): [Filter, string, number] => [
      kind,
      CLASSES[kind].label,
      counts.get(kind) ?? 0,
    ]),
  ];

  return (
    <div className="grid gap-10" data-testid="advisories">
      {/* NOTE: Eleven buttons stack into a screen of their own on a phone, and the sortable
          headers are hidden below 1024px, so narrow screens get selects instead. */}
      <div className="grid gap-4 lg:hidden" data-reveal style={step(2)}>
        <label className="grid gap-2 text-[16px] text-foreground sm:hidden">
          Kind of flaw
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as Filter)}
            className={SELECT}
          >
            {options.map(([value, label, count]) => (
              <option key={value} value={value}>
                {label} ({count})
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-2 text-[16px] text-foreground sm:max-w-xs">
          Order
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as SortKey)}
            className={SELECT}
          >
            <option value="date">Newest first</option>
            <option value="severity">Most severe first</option>
          </select>
        </label>
      </div>

      <fieldset className="hidden min-w-0 flex-wrap gap-2 sm:flex" data-reveal style={step(2)}>
        <legend className="sr-only">Kind of flaw</legend>
        {options.map(([value, label, count]) => {
          const pressed = filter === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={pressed}
              onClick={() => setFilter(value)}
              className={cn(
                "inline-flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-4 text-[16px] outline-none transition-[background-color,color,transform] focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98]",
                pressed
                  ? "bg-accent text-accent-foreground"
                  : "bg-[var(--lp-step)] text-foreground hover:bg-[var(--lp-step-2)]",
              )}
            >
              {label}
              <span
                className={cn("tabular-nums", pressed ? "opacity-75" : "text-muted-foreground")}
              >
                {count}
              </span>
            </button>
          );
        })}
      </fieldset>

      <div aria-live="polite" data-testid="class-verdict" data-reveal style={step(3)}>
        <ClassVerdict key={filter} filter={filter} count={matching.length} />
      </div>

      <div data-reveal style={step(4)}>
        {/* NOTE: The phone layout restyles rows as blocks, and some browsers drop table
            semantics from restyled table elements, so the roles are stated outright. */}
        {/* biome-ignore-start lint/a11y/noRedundantRoles: keeps table semantics on phones */}
        <table
          role="table"
          className="lp-advisories w-full text-left text-[16px]"
          aria-describedby={captionId}
        >
          <caption id={captionId} className="sr-only">
            Published security advisories for other self-hosted deploy platforms, with the
            Roundhouse design choices that stand in the way of each kind of flaw.{" "}
            {sort === "date" ? "Newest first." : "Most severe first."}
          </caption>
          <thead role="rowgroup">
            <tr role="row" className="text-muted-foreground">
              <th
                role="columnheader"
                scope="col"
                aria-sort={sort === "date" ? "descending" : "none"}
              >
                <SortButton active={sort === "date"} onClick={() => setSort("date")}>
                  Published
                </SortButton>
              </th>
              <th role="columnheader" scope="col">
                Platform
              </th>
              <th role="columnheader" scope="col">
                Advisory
              </th>
              <th
                role="columnheader"
                scope="col"
                aria-sort={sort === "severity" ? "descending" : "none"}
              >
                <SortButton active={sort === "severity"} onClick={() => setSort("severity")}>
                  Severity
                </SortButton>
              </th>
              <th role="columnheader" scope="col">
                What went wrong
              </th>
              <th role="columnheader" scope="col">
                What stops it here
              </th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {visible.map((advisory, index) => (
              <tr
                key={`${filter}-${sort}-${advisory.id}`}
                role="row"
                data-class={advisory.kind}
                data-published={advisory.published}
                data-severity={advisory.severity}
                className="lp-line-in"
                style={step(Math.min(index, 8))}
              >
                <td role="cell" data-label="Published" className="whitespace-nowrap tabular-nums">
                  {formatDate(advisory.published)}
                </td>
                <th role="rowheader" scope="row" data-label="Platform" className="font-semibold">
                  {advisory.product}
                </th>
                <td role="cell" data-label="Advisory">
                  <ExternalLink href={advisory.url} className={cn(LINK, "whitespace-nowrap")}>
                    {advisory.id}
                  </ExternalLink>
                </td>
                <td role="cell" data-label="Severity">
                  <SeverityText advisory={advisory} />
                </td>
                <td role="cell" data-label="What went wrong" className="min-w-[26ch]">
                  {advisory.summary}
                  <span className="mt-1.5 block text-muted-foreground">
                    Affected {advisory.affectedVersions}; {fixedText(advisory)}.
                  </span>
                </td>
                <td role="cell" data-label="What stops it here" className="min-w-[22ch]">
                  <DefenceLinks kind={advisory.kind} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* biome-ignore-end lint/a11y/noRedundantRoles: keeps table semantics on phones */}
        {visible.length < matching.length ? (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className={cn(buttonClass("quiet"), "mt-6")}
          >
            Show all {matching.length} advisories
          </button>
        ) : null}
        <p className="mt-8 max-w-[70ch] text-[16px] text-muted-foreground">
          Verified against each vendor's advisory and NVD as of {formatDate(ADVISORIES_AS_OF)}. They
          show what a deploy platform has to defend against, not how safe any of these projects is
          today.
        </p>
      </div>
    </div>
  );
}
