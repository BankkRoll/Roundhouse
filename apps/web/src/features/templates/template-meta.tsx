/**
 * Presentation helpers shared by the template gallery and detail page: category labels,
 * icons for `builtin:<name>`, source descriptions and requirement wording.
 *
 * @module
 */
import { cn } from "@roundhouse/ui";
import {
  ActivityIcon,
  AtomIcon,
  BracesIcon,
  DatabaseIcon,
  FileCode2Icon,
  FolderIcon,
  GlobeIcon,
  HexagonIcon,
  LayoutTemplateIcon,
  type LucideIcon,
  RadarIcon,
  ServerIcon,
  WebhookIcon,
  WorkflowIcon,
} from "lucide-react";
import type {
  TemplateCategory,
  TemplateRequirement,
  TemplateSource,
} from "../../lib/api/templates-types";

/** Display label of each gallery category, in filter order. */
export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  starter: "Starters",
  static: "Static sites",
  tool: "Tools",
  monitoring: "Monitoring",
  automation: "Automation",
  database: "Databases",
};

const BUILTIN_ICONS: Record<string, LucideIcon> = {
  activity: ActivityIcon,
  database: DatabaseIcon,
  folder: FolderIcon,
  globe: GlobeIcon,
  go: BracesIcon,
  nginx: ServerIcon,
  nodejs: HexagonIcon,
  python: FileCode2Icon,
  radar: RadarIcon,
  react: AtomIcon,
  webhook: WebhookIcon,
  workflow: WorkflowIcon,
};

/**
 * The lucide icon for a template's `icon` field.
 *
 * @param icon - `builtin:<name>`, an https URL, or `null`.
 * @returns The matching icon, or a generic template icon.
 */
export function templateIcon(icon: string | null): LucideIcon {
  // NOTE: https icons are never fetched: loading a third-party image would tell that
  // host who browses this control plane's gallery, so they get the generic icon.
  const name = icon?.startsWith("builtin:") ? icon.slice("builtin:".length) : null;
  return (name && BUILTIN_ICONS[name]) || LayoutTemplateIcon;
}

/**
 * A template's icon in its tile.
 *
 * @param props - The template's `icon` field and extra classes.
 * @returns The tile.
 */
export function TemplateIcon({ icon, className }: { icon: string | null; className?: string }) {
  const Icon = templateIcon(icon);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40 text-muted-foreground [&_svg]:size-4",
        className,
      )}
    >
      <Icon />
    </span>
  );
}

/**
 * One-line description of where a template service's code comes from.
 *
 * @param source - The service's source.
 * @returns e.g. `"nginx:stable-alpine"`, `"railwayapp/railpack@main · examples/x"`, `"postgres 17"`.
 */
export function describeTemplateSource(source: TemplateSource): string {
  switch (source.type) {
    case "image":
      return source.image;
    case "git": {
      const repo = source.repo_url
        .replace(/^https:\/\/(www\.)?github\.com\//, "")
        .replace(/\.git$/, "");
      const dir = source.root_dir && source.root_dir !== "." ? ` · ${source.root_dir}` : "";
      return `${repo}@${source.branch}${dir}`;
    }
    case "database":
      return source.version ? `${source.engine} ${source.version}` : source.engine;
  }
}

/**
 * Why an unsupported template can't be deployed, for its row and detail page.
 *
 * @param requirements - What the template needs.
 * @returns e.g. `"Needs databases"` or `"Needs databases and volumes"`.
 */
export function requirementsLabel(requirements: readonly TemplateRequirement[]): string {
  return `Needs ${requirements.join(" and ")}`;
}
