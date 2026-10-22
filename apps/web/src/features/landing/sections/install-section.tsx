import { ServerCard } from "@openrail/ui";
import { CheckIcon, CircleCheckIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { JOIN_TOKEN_MINUTES } from "../content";
import { DEPLOY_URL, INSTALL_COMMAND, MASTER_KEY_COMMAND } from "../links";
import { buttonClass, CommandLine, ExternalLink, Section } from "../ui";

function Exchange({
  index,
  say,
  call,
  response,
}: {
  index: number;
  say: string;
  call: ReactNode;
  response: ReactNode;
}) {
  return (
    <li className="grid gap-4" data-reveal style={{ "--i": index } as CSSProperties}>
      <p className="text-[22px] font-medium tracking-[-0.015em] text-foreground">{say}</p>
      <div className="rounded-lg bg-[var(--lp-step)] p-4 sm:p-5">{call}</div>
      {response}
    </li>
  );
}

const RESOURCES = [
  ["Worker", "openrail", "deployed"],
  ["D1 database", "openrail", "migrated"],
  ["Durable Object", "NodeConnection", "bound"],
  ["Analytics Engine", "openrail_metrics", "bound"],
] as const;

function DeployedFragment() {
  return (
    <div
      data-ui
      className="overflow-hidden rounded-lg border border-border bg-background font-sans text-[13px]"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <span className="font-medium text-foreground">Your Cloudflare account</span>
        <span className="text-muted-foreground">Workers Paid</span>
      </div>
      <ul>
        {RESOURCES.map(([kind, name, state]) => (
          <li
            key={kind}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 border-b border-border px-4 py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
          >
            <span className="text-muted-foreground">{kind}</span>
            <code className="col-start-1 row-start-2 truncate font-mono text-foreground sm:col-start-auto sm:row-start-auto">
              {name}
            </code>
            <span className="text-success">{state}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function WizardFragment() {
  const steps = ["Master key", "Admin", "First server"];
  return (
    <div
      data-ui
      className="rounded-lg border border-border bg-background p-5 font-sans text-[13px]"
    >
      <ol aria-label="Setup progress" className="mb-4 flex items-center gap-2">
        {steps.map((label, index) => (
          <li key={label} className="flex min-w-0 flex-1 items-center gap-1.5">
            <span
              className={
                index === 0
                  ? "flex size-5 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground"
                  : index === 1
                    ? "flex size-5 shrink-0 items-center justify-center rounded-full border border-accent text-[11px] text-accent-text"
                    : "flex size-5 shrink-0 items-center justify-center rounded-full border border-border-strong text-[11px] text-muted-foreground"
              }
            >
              {index === 0 ? <CheckIcon className="size-3" aria-hidden="true" /> : index + 1}
            </span>
            <span
              className={
                index === 1 ? "truncate text-foreground" : "truncate text-muted-foreground"
              }
            >
              {label}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-[16px] font-semibold text-foreground">Create the admin account</p>
      <p className="mt-1 text-muted-foreground">
        This account owns the instance and its first workspace.
      </p>
      <div className="mt-4 grid gap-3">
        {[
          ["Master key", "••••••••••••••••••••••••••••••••••••••••••••"],
          ["Your name", "Mara Okafor"],
          ["Workspace name", "Acme"],
        ].map(([label, value]) => (
          <div key={label} className="grid gap-1">
            <span className="text-muted-foreground">{label}</span>
            <code className="rounded-md border border-input bg-surface px-3 py-2 font-mono text-foreground">
              {value}
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConnectedFragment() {
  return (
    <div
      data-ui
      className="grid gap-4 rounded-lg border border-border bg-background p-5 font-sans text-[13px] sm:grid-cols-[1fr_300px]"
    >
      <div className="grid content-start gap-3">
        <div
          role="status"
          className="flex items-start gap-3 rounded-md border border-success/30 bg-success/10 p-3"
        >
          <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
          <div>
            <p className="text-[14px] font-medium text-foreground">
              <span className="font-mono">home-nuc</span> connected
            </p>
            <p className="text-muted-foreground">
              The agent registered with the control plane. Usage appears after its first heartbeat.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap justify-between gap-2 text-muted-foreground">
          <span>Join token used</span>
          <span>Tokens are single use and expire after {JOIN_TOKEN_MINUTES} minutes</span>
        </div>
      </div>
      <ServerCard
        title="home-nuc"
        meta="linux · 192.168.1.40"
        status="online"
        metrics={[
          { label: "CPU", percent: 6, value: "6% · 0.2/4 vCPU" },
          { label: "RAM", percent: 18, value: "18% · 2.9/16 GB" },
          { label: "Disk", percent: 9, value: "9% · 46/512 GB" },
        ]}
        footer="agent v0.1.0"
        footerAside="seen 1s ago"
      />
    </div>
  );
}

/**
 * "Three moves to your first server": what you do, and what comes back, mirroring the
 * setup wizard's own copy.
 *
 * @returns The section.
 */
export function InstallSection() {
  return (
    <Section
      id="install"
      labelledBy="install-title"
      className="grid gap-12 lg:grid-cols-12 lg:gap-[var(--lp-gap)]"
    >
      <div className="lg:col-span-4">
        <div className="lg:sticky lg:top-[calc(var(--lp-header-h)+32px)]">
          <h2 id="install-title" className="lp-heading" data-reveal>
            Three moves to your first server
          </h2>
          <p className="mt-5 max-w-[36ch] text-foreground" data-reveal>
            Nothing to sign up for. The control plane goes into your Cloudflare account and the
            agent onto your server; the setup wizard walks you through the rest.
          </p>
        </div>
      </div>
      <ol className="grid gap-16 lg:col-span-8 lg:gap-20">
        <Exchange
          index={0}
          say="First, deploy the control plane."
          call={
            <div className="flex flex-wrap items-center gap-4">
              <ExternalLink href={DEPLOY_URL} className={buttonClass("primary")}>
                Deploy to Cloudflare
              </ExternalLink>
              <span className="text-[16px] text-foreground">Workers Paid, about $5 a month</span>
            </div>
          }
          response={<DeployedFragment />}
        />
        <Exchange
          index={1}
          say="Then set the master key."
          call={<CommandLine code={MASTER_KEY_COMMAND} tone="field" />}
          response={<WizardFragment />}
        />
        <Exchange
          index={2}
          say="Then paste one line on any Linux server."
          call={<CommandLine code={INSTALL_COMMAND} tone="field" />}
          response={<ConnectedFragment />}
        />
      </ol>
    </Section>
  );
}
