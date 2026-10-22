import { cn } from "@openrail/ui";
import { type CSSProperties, type ReactNode, useState } from "react";
import { DEPLOY_URL } from "../links";
import {
  CLOUDFLARE_MONTHLY,
  compareCosts,
  DEFAULT_FLEET,
  formatUsd,
  RAILWAY_RATES,
  type Workload,
} from "../model/cost";
import { buttonClass, ExternalLink, Section } from "../ui";

const DEFAULT_WORKLOAD: Workload = { vcpu: 3, ramGb: 12, egressGb: 300, volumeGb: 50 };

const SLIDERS: readonly {
  key: keyof Workload;
  label: string;
  unit: string;
  max: number;
  step: number;
}[] = [
  { key: "vcpu", label: "Average vCPU in use", unit: "vCPU", max: 16, step: 0.25 },
  { key: "ramGb", label: "Average RAM in use", unit: "GB", max: 32, step: 0.5 },
  { key: "egressGb", label: "Egress per month", unit: "GB", max: 5000, step: 10 },
  { key: "volumeGb", label: "Volume storage", unit: "GB", max: 1000, step: 5 },
];

const FLEET_PRICE = DEFAULT_FLEET.reduce((sum, server) => sum + server.monthlyPrice, 0);
const FLEET_LINE = `Your side assumes ${DEFAULT_FLEET.length} rented servers with ${DEFAULT_FLEET[0]?.vcpu} vCPU and ${DEFAULT_FLEET[0]?.ramGb} GB RAM at ${formatUsd(DEFAULT_FLEET[0]?.monthlyPrice ?? 0)} a month each, plus about ${formatUsd(CLOUDFLARE_MONTHLY)} for Cloudflare.`;

function toNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * "Servers, not minutes": four workload sliders and one comparison table of your servers
 * against Railway's published usage rates.
 *
 * @returns The section.
 */
export function CostSection() {
  const [workload, setWorkload] = useState<Workload>(DEFAULT_WORKLOAD);
  const result = compareCosts(workload, DEFAULT_FLEET, RAILWAY_RATES);
  const cheaper = result.difference >= 0;
  const rates = RAILWAY_RATES;

  const rows: [string, ReactNode, string][] = [
    ["Servers", formatUsd(FLEET_PRICE), "Not needed"],
    [
      "Control plane",
      `${formatUsd(CLOUDFLARE_MONTHLY)} Cloudflare`,
      `${formatUsd(rates.planFee)} ${rates.planName} plan`,
    ],
    [`${workload.vcpu} vCPU`, "On your servers", formatUsd(result.paas.cpu)],
    [`${workload.ramGb} GB memory`, "On your servers", formatUsd(result.paas.ram)],
    [`${workload.egressGb} GB egress`, "Your host's allowance", formatUsd(result.paas.egress)],
    [`${workload.volumeGb} GB volumes`, "Your disks", formatUsd(result.paas.volume)],
  ];

  return (
    <Section id="pricing" labelledBy="pricing-title">
      <div className="grid gap-10 lg:grid-cols-12 lg:gap-[var(--lp-gap)]">
        <div className="lg:col-span-4" data-reveal>
          <h2 id="pricing-title" className="lp-heading">
            Servers, not minutes
          </h2>
          <p className="mt-5 max-w-[36ch] text-foreground">
            Usage-billed platforms charge for every vCPU-minute and gigabyte. Here you pay the
            server bills you choose, plus about $5 for the control plane.
          </p>
        </div>
        <div
          className="grid content-start gap-8 lg:col-span-8"
          data-reveal
          style={{ "--i": 1 } as CSSProperties}
        >
          <div className="grid gap-x-[var(--lp-gap)] gap-y-6 sm:grid-cols-2" data-testid="workload">
            {SLIDERS.map((slider) => {
              const value = workload[slider.key];
              return (
                <div key={slider.key} className="grid gap-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <label htmlFor={`slider-${slider.key}`} className="text-[16px] text-foreground">
                      {slider.label}
                    </label>
                    <span className="text-[16px] text-foreground tabular-nums">
                      {value} {slider.unit}
                    </span>
                  </div>
                  <input
                    id={`slider-${slider.key}`}
                    type="range"
                    min={0}
                    max={slider.max}
                    step={slider.step}
                    value={value}
                    aria-valuetext={`${value} ${slider.unit}`}
                    onChange={(event) =>
                      setWorkload((current) => ({
                        ...current,
                        [slider.key]: toNumber(event.target.value),
                      }))
                    }
                    className="lp-range w-full"
                  />
                </div>
              );
            })}
          </div>

          <div data-testid="calculator">
            <table className="hidden w-full border-collapse text-left md:table">
              <caption className="sr-only">
                Monthly cost: your servers against Railway's list price
              </caption>
              <thead>
                <tr>
                  <th
                    scope="col"
                    className="w-[36%] p-5 align-bottom text-[16px] font-normal text-muted-foreground"
                  >
                    Per month, estimated
                  </th>
                  <th
                    scope="col"
                    className="w-[32%] rounded-t-lg bg-accent p-5 align-top text-accent-foreground"
                  >
                    <span className="block text-[clamp(24px,2.2vw,36px)] font-semibold leading-tight tracking-[-0.03em]">
                      Your servers
                    </span>
                    <span
                      className="block text-[clamp(24px,2.2vw,36px)] leading-tight font-normal tracking-[-0.03em] tabular-nums"
                      data-testid="self-total"
                    >
                      {formatUsd(result.selfHost.total)}
                    </span>
                  </th>
                  <th scope="col" className="w-[32%] p-5 align-top">
                    <span className="block text-[clamp(24px,2.2vw,36px)] font-semibold leading-tight tracking-[-0.03em]">
                      Railway {rates.planName}
                    </span>
                    <span
                      className="block text-[clamp(24px,2.2vw,36px)] leading-tight font-normal tracking-[-0.03em] tabular-nums"
                      data-testid="paas-total"
                    >
                      {formatUsd(result.paas.total)}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody className="text-[18px]">
                {rows.map(([label, ours, theirs], index) => (
                  <tr key={label} className={index % 2 === 0 ? "bg-[var(--lp-step)]" : undefined}>
                    <th scope="row" className="px-5 py-3.5 font-normal text-foreground">
                      {label}
                    </th>
                    <td className="bg-accent/90 px-5 py-3.5 text-accent-foreground tabular-nums">
                      {ours}
                    </td>
                    <td className="px-5 py-3.5 text-foreground tabular-nums">{theirs}</td>
                  </tr>
                ))}
                <tr>
                  <td className="p-5" />
                  <td className="rounded-b-lg bg-accent px-5 pt-2 pb-5">
                    <ExternalLink
                      href={DEPLOY_URL}
                      className={buttonClass(
                        "quiet",
                        "bg-accent-foreground text-accent hover:bg-accent-foreground/85",
                      )}
                    >
                      Deploy to Cloudflare
                    </ExternalLink>
                  </td>
                  <td className="px-5 pt-2 pb-5" />
                </tr>
              </tbody>
            </table>

            <div className="grid gap-12 md:hidden">
              {[
                {
                  name: "Your servers",
                  total: result.selfHost.total,
                  pick: 1 as const,
                  accent: true,
                },
                {
                  name: `Railway ${rates.planName}`,
                  total: result.paas.total,
                  pick: 2 as const,
                  accent: false,
                },
              ].map((plan) => (
                <div
                  key={plan.name}
                  className={cn(
                    "rounded-lg p-5",
                    plan.accent ? "bg-accent text-accent-foreground" : "bg-[var(--lp-step)]",
                  )}
                >
                  <p className="text-[9vw] leading-none font-semibold tracking-[-0.03em]">
                    {plan.name}
                  </p>
                  <p className="mt-1 text-[9vw] leading-none tracking-[-0.03em] tabular-nums">
                    {formatUsd(plan.total)}
                  </p>
                  <dl className="mt-5 grid gap-3 text-[17px]">
                    {rows.map((row) => (
                      <div key={row[0]}>
                        <dt className={plan.accent ? "opacity-75" : "text-muted-foreground"}>
                          {row[0]}
                        </dt>
                        <dd>{row[plan.pick]}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>

            <p
              className={cn(
                "mt-6 max-w-[60ch] text-[20px]",
                cheaper ? "text-foreground" : "text-warning",
              )}
              data-testid="difference"
              aria-live="polite"
            >
              {cheaper
                ? `About ${formatUsd(result.difference)} a month less than the estimated Railway list price for this workload.`
                : `About ${formatUsd(-result.difference)} a month more than the estimated Railway list price for this workload.`}
              {result.fits ? "" : " The workload is larger than these two servers."}
            </p>
            <p className="mt-3 max-w-[58ch] text-[15px] text-muted-foreground">
              {FLEET_LINE} Railway figures use its published usage rates as of {rates.asOf} and a
              730-hour month.
            </p>
          </div>
        </div>
      </div>
    </Section>
  );
}
