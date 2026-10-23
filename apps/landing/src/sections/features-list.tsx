import type { CSSProperties } from "react";
import { FEATURE_GROUPS } from "../content";
import { Section } from "../ui";

/** The short value at the right end of each row. */
const VALUES: Record<string, string> = {
  Services: "from Git",
  "Any language": "Railpack or Dockerfile",
  "Zero-downtime deploys": "health-checked",
  Rollbacks: "no rebuild",
  "PR previews": "a URL per pull request",
  "Cron jobs": "on a schedule",
  Databases: "Postgres, MySQL, Redis, MongoDB",
  Volumes: "pinned to a server",
  Backups: "to your R2",
  "Private networking": ".internal names",
  "Domains & HTTPS": "generated or your own",
  "Signed control channel": "Ed25519",
  Logs: "build and runtime",
  Metrics: "per service",
  "Servers & live usage": "every heartbeat",
  "Audit log": "every change",
  "Project canvas": "staged changes",
  Environments: "production, staging…",
  "Shared variables": "defined once",
  CLI: "your terminal",
  Templates: "ready-made stacks",
  "MCP server": "for coding agents",
  "Members & roles": "four roles",
};

/**
 * "Everything it does": the heading on the left, every feature on the right as a row with
 * its short value and one line on what it does, in two columns of groups.
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
          your code, data and servers in your own accounts.
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
                <li key={feature.title} className="grid gap-1 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-3 lg:flex-nowrap">
                    <span
                      aria-hidden="true"
                      className="size-3 shrink-0 translate-y-px rounded-full bg-accent"
                    />
                    <span className="text-[18px] text-foreground">{feature.title}</span>
                    <span className="ml-auto text-right text-[15px] text-muted-foreground">
                      {VALUES[feature.title] ?? ""}
                    </span>
                  </div>
                  <p className="ml-6 max-w-[52ch] text-[16px] text-foreground">{feature.body}</p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}
