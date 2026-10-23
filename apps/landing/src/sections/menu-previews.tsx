import { Meter } from "@roundhouse/ui";
import type { ReactNode } from "react";
import type { FeatureGroup } from "../content";

/**
 * Live interface crop shown beside the Product menu for the group under the pointer. Each
 * one is a small piece of the dashboard (`data-ui`), not an illustration.
 *
 * @param props - Which group to preview.
 * @returns The crop.
 */
export function MenuPreview({ group }: { group: FeatureGroup["id"] }) {
  return (
    <div
      data-ui
      key={group}
      className="lp-fade flex h-full flex-col overflow-hidden rounded-lg border border-border-strong bg-background font-sans text-[13px]"
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2 text-[12px] text-muted-foreground">
        <span>{PREVIEW_TITLE[group]}</span>
        <span className="inline-flex items-center gap-1.5 text-success">
          <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
          live
        </span>
      </div>
      <div className="grid flex-1 content-start gap-2.5 p-3">{PREVIEWS[group]}</div>
    </div>
  );
}

const PREVIEW_TITLE: Record<FeatureGroup["id"], string> = {
  deploy: "api · deployments",
  data: "postgres",
  networking: "production · private network",
  observability: "hetzner-fsn1",
  tools: "acme / production",
};

function Row({ left, right, tone }: { left: string; right: string; tone?: "ok" | "soft" }) {
  return (
    <div className="flex items-baseline justify-between gap-3 font-mono text-[12px]">
      <code className="block min-w-0 truncate font-mono text-foreground">{left}</code>
      <span className={tone === "ok" ? "text-success" : "text-muted-foreground"}>{right}</span>
    </div>
  );
}

const PREVIEWS: Record<FeatureGroup["id"], ReactNode> = {
  deploy: (
    <>
      <Row left="dep_7h2k  4f2c9e1" right="live · 38s" tone="ok" />
      <Row left="dep_5q1x  a91d03b" right="standby" />
      <Row left="dep_2m8c  77be410" right="standby" />
      <p className="mt-1 rounded-md bg-[var(--lp-step)] p-2 font-mono text-[12px] text-muted-foreground">
        pr-212 · preview at api-pr-212.acme.dev
      </p>
    </>
  ),
  data: (
    <>
      <Row left="postgres:17" right="healthy" tone="ok" />
      <div className="grid gap-1.5">
        <div className="flex justify-between text-[12px] text-muted-foreground">
          <span>Volume</span>
          <span className="font-mono text-foreground">3.8 / 10 GB</span>
        </div>
        <Meter value={38} label="Volume usage" />
      </div>
      <Row left="backup → r2://acme-backups" right="02:00 daily" />
      <Row left="last backup" right="ok · 412 MB" tone="ok" />
    </>
  ),
  networking: (
    <>
      <Row left="api.production.acme.internal" right="10.20.0.3" />
      <Row left="postgres.production.acme.internal" right="10.20.0.7" />
      <Row left="redis.production.acme.internal" right="10.20.0.9" />
      <Row left="wg0  3 peers" right="handshake 4s" tone="ok" />
    </>
  ),
  observability: (
    <>
      {[
        ["CPU", 38, "38% · 3.0/8 vCPU"],
        ["RAM", 61, "61% · 19.5/32 GB"],
        ["Disk", 42, "42% · 101/240 GB"],
      ].map(([label, value, text]) => (
        <div key={label as string} className="grid gap-1.5">
          <div className="flex justify-between text-[12px]">
            <span className="text-muted-foreground">{label}</span>
            <span className="font-mono text-foreground">{text}</span>
          </div>
          <Meter value={value as number} label={`${label} usage`} />
        </div>
      ))}
    </>
  ),
  tools: (
    <>
      <div className="flex items-center gap-2">
        <span className="rounded-md border border-border-strong bg-[var(--lp-step)] px-2 py-1 font-mono text-[12px]">
          api
        </span>
        <span className="h-px flex-1 border-t border-dashed border-accent/60" aria-hidden="true" />
        <span className="rounded-md border border-border-strong bg-[var(--lp-step)] px-2 py-1 font-mono text-[12px]">
          postgres
        </span>
      </div>
      <p className="rounded-md bg-[var(--lp-step)] p-2 font-mono text-[12px] text-foreground">
        $ roundhouse logs api --follow
      </p>
      <Row left="LOG_LEVEL  info → debug" right="staged" />
    </>
  ),
};
