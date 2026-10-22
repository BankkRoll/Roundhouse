import type { CSSProperties } from "react";
import { FEATURE_GROUPS } from "../content";
import { Section } from "../ui";

/** The short value at the right end of each row. */
const VALUES: Record<string, string> = {
  Services: "from Git",
  Rollbacks: "no rebuild",
  "PR previews": "a URL per pull request",
  "Cron jobs": "on a schedule",
  Databases: "Postgres, MySQL, Redis, MongoDB",
  Volumes: "pinned to a server",
  Backups: "to your R2",
  "Private networking": ".internal names",
  "Domains & HTTPS": "certificates included",
  "Signed control channel": "Ed25519",
  Logs: "build and runtime",
  Metrics: "per service",
  "Servers & live usage": "every heartbeat",
  "Audit log": "every change",
  "Project canvas": "staged changes",
  CLI: "your terminal",
  Templates: "ready-made stacks",
  "MCP server": "for coding agents",
  "Members & roles": "four roles",
};

/**
 * "Everything it does": the heading on the left, every feature as two-ended rows in two
 * columns of groups on the right.
 *
 * @returns The section.
 */
export function FeaturesList() {
  return (
    <Section
      id="features"
      labelledBy="features-title"
      className="grid gap-10 lg:grid-cols-12 lg:gap-[var(--lp-gap)]"
    >
      <div className="lg:col-span-4">
        <h2 id="features-title" className="lp-heading" data-reveal>
          Everything it does
        </h2>
        <p className="mt-5 max-w-[36ch] text-foreground" data-reveal>
          One install covers the whole path from a Git push to a running, observable service, with
          your data and your servers in your own accounts.
        </p>
      </div>
      <div className="gap-x-(--lp-gap) sm:columns-2 lg:col-span-8 lg:columns-1 xl:columns-2">
        {FEATURE_GROUPS.map((group, groupIndex) => (
          <div
            key={group.id}
            className="mb-12 min-w-0 break-inside-avoid last:mb-0"
            data-reveal
            style={{ "--i": groupIndex } as CSSProperties}
          >
            <h3 className="text-[16px] font-normal text-muted-foreground">{group.title}</h3>
            <ul className="mt-2">
              {group.features.map((feature) => (
                <li
                  key={feature.title}
                  className="flex min-h-11 flex-wrap items-baseline gap-x-3 py-2 lg:flex-nowrap"
                >
                  <span
                    aria-hidden="true"
                    className="size-3 shrink-0 translate-y-px rounded-full bg-accent"
                  />
                  <span className="text-[18px] text-foreground">{feature.title}</span>
                  <span className="ml-6 basis-full text-[15px] text-muted-foreground lg:ml-auto lg:basis-auto lg:text-right">
                    {VALUES[feature.title] ?? ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}
