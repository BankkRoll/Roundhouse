import { cn } from "@roundhouse/ui";
import { type CSSProperties, useState } from "react";
import { DEPLOY_URL } from "../links";
import {
  CLOUDFLARE_MONTHLY,
  compareHosted,
  FLEET_SERVER,
  FLY_RATES,
  formatUsd,
  HOSTED_RATES_AS_OF,
  RAILWAY_RATES,
  RENDER_RATES,
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
  { key: "vcpu", label: "Average vCPU in use", unit: "vCPU", max: 32, step: 0.25 },
  { key: "ramGb", label: "Average RAM in use", unit: "GB", max: 64, step: 0.5 },
  { key: "egressGb", label: "Egress per month", unit: "GB", max: 5000, step: 10 },
  { key: "volumeGb", label: "Volume storage", unit: "GB", max: 1000, step: 5 },
];

const SOURCE_LINK =
  "rounded-sm underline decoration-muted-foreground underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

function toNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** Says how your servers compare with the range of hosted estimates. */
function savingsSentence(min: number, max: number): string {
  if (min >= 0) {
    return min === max
      ? `About ${formatUsd(min)} a month less than hosted platforms for this workload.`
      : `About ${formatUsd(min)} to ${formatUsd(max)} a month less than these hosted platforms for this workload.`;
  }
  if (max <= 0) {
    return `About ${formatUsd(-max)} to ${formatUsd(-min)} a month more than these hosted platforms for this workload.`;
  }
  return `Between ${formatUsd(-min)} a month more and ${formatUsd(max)} a month less than these hosted platforms for this workload.`;
}

function CostRow({
  name,
  basis,
  total,
  max,
  ours = false,
  testId,
}: {
  name: string;
  basis: string;
  total: number;
  max: number;
  ours?: boolean;
  testId: string;
}) {
  return (
    <li
      className={cn(
        "grid gap-2.5 rounded-lg p-5",
        ours ? "bg-accent text-accent-foreground" : "bg-[var(--lp-step)]",
      )}
    >
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-[clamp(22px,2vw,30px)] font-semibold leading-tight tracking-[-0.025em]">
          {name}
        </span>
        <span
          className="text-[clamp(22px,2vw,30px)] leading-tight tracking-[-0.025em] tabular-nums"
          data-testid={testId}
        >
          {formatUsd(total)}
        </span>
      </div>
      <span
        aria-hidden="true"
        className={cn(
          "block h-2.5 rounded-full",
          ours ? "bg-accent-foreground/20" : "bg-meter-track",
        )}
      >
        <span
          className={cn(
            "block h-full rounded-full transition-[width] duration-300",
            ours ? "bg-accent-foreground" : "bg-muted-foreground",
          )}
          style={{ width: `${max > 0 ? Math.max(1, (total / max) * 100) : 0}%` }}
        />
      </span>
      <span className={cn("text-[16px]", ours ? "opacity-80" : "text-muted-foreground")}>
        {basis}
      </span>
    </li>
  );
}

/**
 * "Servers, not minutes": four workload sliders, then your servers against Railway,
 * Render and Fly.io at their published list prices, cheapest first, each with what was
 * priced and a bar to scale.
 *
 * @returns The section.
 */
export function CostSection() {
  const [workload, setWorkload] = useState<Workload>(DEFAULT_WORKLOAD);
  const result = compareHosted(workload);
  const max = Math.max(result.selfHost.total, ...result.hosted.map((h) => h.total));
  const servers = result.fleet.length;
  const fleetLine = `${servers} rented servers with ${FLEET_SERVER.vcpu} vCPU and ${FLEET_SERVER.ramGb} GB RAM at an assumed ${formatUsd(FLEET_SERVER.monthlyPrice)} a month each, plus about ${formatUsd(CLOUDFLARE_MONTHLY)} for Cloudflare`;

  return (
    <Section id="pricing" labelledBy="pricing-title">
      <div className="grid gap-10 lg:grid-cols-12 lg:gap-[var(--lp-gap)]">
        <div className="lg:col-span-4" data-reveal>
          <h2 id="pricing-title" className="lp-heading">
            Servers, not minutes
          </h2>
          <p className="mt-5 max-w-[36ch] text-foreground">
            Hosted platforms bill for every vCPU, gigabyte and instance tier. Here you pay the
            server bills you choose, plus about $5 a month for the control plane. Set your workload
            and compare.
          </p>
          <ExternalLink href={DEPLOY_URL} className={cn(buttonClass("primary"), "mt-8")}>
            Deploy to Cloudflare
          </ExternalLink>
        </div>
        <div
          className="grid content-start gap-10 lg:col-span-8"
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
            <ol aria-label="Estimated monthly cost" className="grid gap-2">
              <CostRow
                name="Your servers"
                basis={`${servers} servers (${FLEET_SERVER.vcpu} vCPU, ${FLEET_SERVER.ramGb} GB) and Cloudflare`}
                total={result.selfHost.total}
                max={max}
                ours
                testId="self-total"
              />
              {result.hosted.map((estimate) => (
                <CostRow
                  key={estimate.id}
                  name={estimate.name}
                  basis={estimate.basis}
                  total={estimate.total}
                  max={max}
                  testId={`hosted-${estimate.id}`}
                />
              ))}
            </ol>

            <p
              className="mt-6 max-w-[60ch] text-[20px] text-foreground"
              data-testid="difference"
              aria-live="polite"
            >
              {savingsSentence(result.savings.min, result.savings.max)}
            </p>
            <p className="mt-3 max-w-[64ch] text-[15px] text-muted-foreground">
              Your side assumes {fleetLine}, never fewer than two servers so one can fail. Hosted
              figures are list prices for an always-on workload in a 730-hour month, on the smallest
              size that fits, from the pricing pages of{" "}
              <ExternalLink href={RAILWAY_RATES.source} className={SOURCE_LINK}>
                Railway
              </ExternalLink>{" "}
              ({RAILWAY_RATES.asOf}),{" "}
              <ExternalLink href={RENDER_RATES.source} className={SOURCE_LINK}>
                Render
              </ExternalLink>{" "}
              and{" "}
              <ExternalLink href={FLY_RATES.source} className={SOURCE_LINK}>
                Fly.io
              </ExternalLink>{" "}
              ({HOSTED_RATES_AS_OF}). Prices change; check them before you decide.
            </p>
          </div>
        </div>
      </div>
    </Section>
  );
}
