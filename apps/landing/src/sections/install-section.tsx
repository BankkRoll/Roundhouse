import { PRODUCT_NAME } from "@openrail/shared";
import { ServerCard } from "@openrail/ui";
import { CheckIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { JOIN_TOKEN_MINUTES } from "../content";
import { DEPLOY_URL, INSTALL_COMMAND, MASTER_KEY_COMMAND } from "../links";
import { buttonClass, CommandLine, ExternalLink, Section } from "../ui";

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
    <div data-ui className="font-sans text-[13px]">
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

/** The tail of the installer's output on a fresh server, as `install/install.sh` logs it. */
const INSTALLER_LOG = [
  "signature and checksum verified for 0.1.0",
  "joining https://openrail.acme.workers.dev",
  "installing Docker Engine from download.docker.com",
  "installing Caddy from the official Cloudsmith repository",
  "OpenRail agent is running.",
] as const;

function InstallerLog() {
  return (
    <ol
      aria-label="Installer output"
      className="grid gap-1 rounded-lg bg-[#08090a] p-4 font-mono text-[13px] leading-relaxed text-[#e8eaed]"
    >
      {INSTALLER_LOG.map((line, index) => (
        <li key={line} className="break-words">
          <code>
            <span className="text-accent-text">==&gt;</span>{" "}
            <span className={index === INSTALLER_LOG.length - 1 ? "text-success" : undefined}>
              {line}
            </span>
          </code>
        </li>
      ))}
    </ol>
  );
}

const NEEDS: readonly [string, string][] = [
  ["A Cloudflare account", "On Workers Paid, about $5 a month. It runs the control plane."],
  ["A Linux server", "Ubuntu 22.04 or 24.04, or Debian 12, on x86 or ARM. Rented or at home."],
  [
    "1 vCPU, 1 GB RAM, 10 GB disk",
    "The minimum the installer accepts; the server that builds images wants 20 GB free.",
  ],
  ["Ports 80 and 443", "Only for your apps' traffic. Nothing listens for control commands."],
];

function Step({
  index,
  title,
  you,
  we,
  action,
  children,
}: {
  index: number;
  title: string;
  /** What the reader does. */
  you: ReactNode;
  /** What happens in response. */
  we: ReactNode;
  action: ReactNode;
  children: ReactNode;
}) {
  return (
    <li
      className="grid min-w-0 content-start gap-5 rounded-lg bg-[var(--lp-step)] p-5 sm:p-6"
      data-reveal
      style={{ "--i": index } as CSSProperties}
    >
      <h3 className="text-[24px] font-semibold leading-tight tracking-[-0.025em]">{title}</h3>
      <div className="grid gap-2 text-[16px] text-foreground">
        <p>
          <strong className="font-semibold">You:</strong> {you}
        </p>
        <p>
          <strong className="font-semibold">{PRODUCT_NAME}:</strong> {we}
        </p>
      </div>
      <div className="min-w-0">{action}</div>
      {children}
    </li>
  );
}

/**
 * "Set up once": what you need, then the one-time setup as three side-by-side steps, each
 * with what you do, what happens, its one action and what you see afterwards. It hands
 * off to the deploy pipeline, which is what every later push looks like.
 *
 * @returns The section.
 */
export function InstallSection() {
  return (
    <Section id="install" labelledBy="install-title" className="grid gap-12">
      <div className="grid gap-10 lg:grid-cols-12 lg:gap-[var(--lp-gap)]">
        <div className="lg:col-span-5">
          <h2 id="install-title" className="lp-heading" data-reveal>
            Set up once
          </h2>
          <p className="mt-5 max-w-[40ch] text-foreground" data-reveal>
            No sign-up and no cluster to build. Put the control plane in your Cloudflare account,
            create your admin account and connect a server. After that, every deploy is a{" "}
            <a
              href="#deploys"
              className="rounded-sm underline decoration-muted-foreground underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              git push
            </a>
            .
          </p>
        </div>
        <div className="lg:col-span-7" data-reveal style={{ "--i": 1 } as CSSProperties}>
          <h3 className="text-[20px] font-semibold tracking-[-0.015em]">What you need</h3>
          <dl className="mt-4 grid gap-x-[var(--lp-gap)] gap-y-5 sm:grid-cols-2">
            {NEEDS.map(([need, detail]) => (
              <div key={need} className="grid gap-0.5">
                <dt className="text-[17px] text-foreground">{need}</dt>
                <dd className="text-[16px] text-muted-foreground">{detail}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      <ol aria-label="Setup" className="grid gap-3 lg:grid-cols-3" data-testid="install-steps">
        <Step
          index={0}
          title="Deploy the control plane"
          you="Click Deploy to Cloudflare and pick your account."
          we="Creates its Worker, database and storage there. Nothing runs anywhere else."
          action={
            <ExternalLink href={DEPLOY_URL} className={buttonClass("primary")}>
              Deploy to Cloudflare
            </ExternalLink>
          }
        >
          <DeployedFragment />
        </Step>
        <Step
          index={1}
          title="Create your admin"
          you="Store a master key as a Worker secret, then open your Worker's URL."
          we="The setup wizard checks the key and creates your account and first workspace."
          action={<CommandLine code={MASTER_KEY_COMMAND} tone="field" />}
        >
          <WizardFragment />
        </Step>
        <Step
          index={2}
          title="Connect a server"
          you="In Servers, choose Add server and run the line it gives you on your machine."
          we={`Installs Docker, Caddy and the agent, and joins with a one-time token that expires in ${JOIN_TOKEN_MINUTES} minutes.`}
          action={<CommandLine code={INSTALL_COMMAND} tone="field" />}
        >
          <InstallerLog />
          <ConnectedFragment />
        </Step>
      </ol>
    </Section>
  );
}
