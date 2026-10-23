/**
 * Cost model for the landing page calculator: what a workload costs on your own servers
 * (server bills plus the Cloudflare Workers Paid plan) versus estimates at the public list
 * prices of Railway, Render and Fly.io.
 *
 * Everything here is pure so it can be unit-tested and so the published rates live in one
 * editable place.
 *
 * @module
 */

/** Usage-based list prices for a hosted PaaS, plus its plan fee and included credit. */
export interface PaasRates {
  /** Date the rates were last checked against the public pricing page (YYYY-MM-DD). */
  asOf: string;
  /** Page the rates were copied from. */
  source: string;
  /** USD per vCPU per minute. */
  perVcpuMinute: number;
  /** USD per GB of RAM per minute. */
  perGbRamMinute: number;
  /** USD per GB of network egress. */
  perGbEgress: number;
  /** USD per GB of volume storage per minute. */
  perGbVolumeMinute: number;
  /** Plan the estimate assumes, e.g. "Pro". */
  planName: string;
  /** Monthly subscription fee in USD. */
  planFee: number;
  /** Usage credit included in the subscription, in USD. */
  includedUsage: number;
}

/**
 * Railway container pricing as published on 2026-10-22 at
 * https://docs.railway.com/reference/pricing/plans and https://railway.com/pricing:
 * $20 per vCPU-month, $10 per GB-RAM-month, $0.05 per GB egress, $0.15 per GB-volume-month,
 * Pro plan $20 a month including $20 of usage. Prices change: verify before relying on them.
 */
export const RAILWAY_RATES: Readonly<PaasRates> = {
  asOf: "2026-10-22",
  source: "https://railway.com/pricing",
  perVcpuMinute: 0.000463,
  perGbRamMinute: 0.000231,
  perGbEgress: 0.05,
  perGbVolumeMinute: 0.000003472222222,
  planName: "Pro",
  planFee: 20,
  includedUsage: 20,
};

/**
 * Minutes in an average month (730 hours). Usage-billed platforms quote per-minute rates;
 * an always-on service runs for all of them.
 */
export const MINUTES_PER_MONTH = 730 * 60;

/** Workers Paid plan minimum, which covers the control plane for a typical install. */
export const CLOUDFLARE_MONTHLY = 5;

/** Average resources a set of services uses across a month. */
export interface Workload {
  /** Average vCPU in use. */
  vcpu: number;
  /** Average RAM in use, GB. */
  ramGb: number;
  /** Outbound traffic per month, GB. */
  egressGb: number;
  /** Persistent volume size, GB. */
  volumeGb: number;
}

/** One server you rent or own. */
export interface Server {
  /** Stable key for lists. */
  id: string;
  /** Label such as "hetzner · fsn1". */
  name: string;
  /** Monthly price in USD (0 for hardware you already own). */
  monthlyPrice: number;
  /** vCPUs on the box. */
  vcpu: number;
  /** RAM on the box, GB. */
  ramGb: number;
}

/**
 * The fleet the landing page compares against: two rented servers with 8 vCPU and 16 GB RAM
 * each. The $30 monthly price is an assumed figure for a mid-size rented server, not a quote
 * from any provider.
 */
export const DEFAULT_FLEET: readonly Server[] = [
  { id: "a", name: "server-1", monthlyPrice: 30, vcpu: 8, ramGb: 16 },
  { id: "b", name: "server-2", monthlyPrice: 30, vcpu: 8, ramGb: 16 },
];

/** Line items of a usage-billed estimate. */
export interface PaasEstimate {
  cpu: number;
  ram: number;
  egress: number;
  volume: number;
  /** Sum of the usage line items. */
  usage: number;
  /** Subscription fee plus any usage beyond the included credit. */
  total: number;
}

/** Line items of a self-hosted estimate. */
export interface SelfHostEstimate {
  servers: number;
  cloudflare: number;
  total: number;
}

/** Side-by-side result. */
export interface CostComparison {
  selfHost: SelfHostEstimate;
  paas: PaasEstimate;
  /** `paas.total - selfHost.total`; negative when self-hosting costs more. */
  difference: number;
  /** Whether the servers have enough vCPU and RAM for the workload. */
  fits: boolean;
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Estimates a month of usage-billed hosting.
 *
 * @param workload - Average resources used.
 * @param rates - Rates to apply. Defaults to {@link RAILWAY_RATES}.
 * @returns Line items and the monthly total in USD.
 * @example
 * estimatePaas({ vcpu: 1, ramGb: 1, egressGb: 0, volumeGb: 0 }).usage; // ≈ 30.40
 */
export function estimatePaas(workload: Workload, rates: PaasRates = RAILWAY_RATES): PaasEstimate {
  const cpu = nonNegative(workload.vcpu) * nonNegative(rates.perVcpuMinute) * MINUTES_PER_MONTH;
  const ram = nonNegative(workload.ramGb) * nonNegative(rates.perGbRamMinute) * MINUTES_PER_MONTH;
  const egress = nonNegative(workload.egressGb) * nonNegative(rates.perGbEgress);
  const volume =
    nonNegative(workload.volumeGb) * nonNegative(rates.perGbVolumeMinute) * MINUTES_PER_MONTH;
  const usage = cpu + ram + egress + volume;
  const total = nonNegative(rates.planFee) + Math.max(0, usage - nonNegative(rates.includedUsage));
  return { cpu, ram, egress, volume, usage, total };
}

/**
 * Estimates a month of self-hosting: the servers' bills plus the Cloudflare plan.
 *
 * @param servers - Servers in the fleet.
 * @param cloudflare - Monthly Cloudflare cost. Defaults to {@link CLOUDFLARE_MONTHLY}.
 * @returns Line items and the monthly total in USD.
 */
export function estimateSelfHost(
  servers: readonly Server[],
  cloudflare: number = CLOUDFLARE_MONTHLY,
): SelfHostEstimate {
  const serverTotal = servers.reduce((sum, server) => sum + nonNegative(server.monthlyPrice), 0);
  const cf = nonNegative(cloudflare);
  return { servers: serverTotal, cloudflare: cf, total: serverTotal + cf };
}

/**
 * Checks whether a fleet can hold a workload, ignoring per-node bin packing.
 *
 * @param workload - Average resources used.
 * @param servers - Servers in the fleet.
 * @returns `true` when total vCPU and RAM cover the workload.
 */
export function fleetFits(workload: Workload, servers: readonly Server[]): boolean {
  const vcpu = servers.reduce((sum, server) => sum + nonNegative(server.vcpu), 0);
  const ram = servers.reduce((sum, server) => sum + nonNegative(server.ramGb), 0);
  return nonNegative(workload.vcpu) <= vcpu && nonNegative(workload.ramGb) <= ram;
}

/**
 * Compares self-hosting a workload with running it on a usage-billed PaaS.
 *
 * @param workload - Average resources used.
 * @param servers - Servers in the fleet.
 * @param rates - PaaS rates. Defaults to {@link RAILWAY_RATES}.
 * @param cloudflare - Monthly Cloudflare cost. Defaults to {@link CLOUDFLARE_MONTHLY}.
 * @returns Both estimates, their difference and a capacity check.
 */
export function compareCosts(
  workload: Workload,
  servers: readonly Server[],
  rates: PaasRates = RAILWAY_RATES,
  cloudflare: number = CLOUDFLARE_MONTHLY,
): CostComparison {
  const selfHost = estimateSelfHost(servers, cloudflare);
  const paas = estimatePaas(workload, rates);
  return {
    selfHost,
    paas,
    difference: paas.total - selfHost.total,
    fits: fleetFits(workload, servers),
  };
}

/**
 * Formats USD for the calculator: cents under $100, whole dollars above.
 *
 * @param value - Amount in USD.
 * @returns e.g. `"$4.20"` or `"$1,240"`.
 */
export function formatUsd(value: number): string {
  const amount = Number.isFinite(value) ? value : 0;
  const digits = Math.abs(amount) < 100 ? 2 : 0;
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

// -----------------------------------------------------------------------------
// Other hosted platforms
// -----------------------------------------------------------------------------

/** A hosted platform's estimate for one workload. */
export interface HostedEstimate {
  id: "railway" | "render" | "fly";
  /** Display name, e.g. "Railway". */
  name: string;
  /** Monthly total in USD. */
  total: number;
  /** What was priced, e.g. "Pro Max (4 CPU, 16 GB) on the Pro workspace". */
  basis: string;
  /** Public pricing page the rates come from. */
  source: string;
}

/** Date the Render and Fly.io rates were checked against their pricing pages. */
export const HOSTED_RATES_AS_OF = "2026-10-22";

/**
 * Render general-purpose instance tiers, the Pro workspace fee, bandwidth and disk prices
 * as published at https://render.com/pricing, https://render.com/docs/outbound-bandwidth
 * and https://render.com/docs/disks on {@link HOSTED_RATES_AS_OF}.
 */
export const RENDER_RATES = {
  source: "https://render.com/pricing",
  workspaceFee: 25,
  includedEgressGb: 25,
  perGbEgress: 0.15,
  perGbDiskMonth: 0.25,
  tiers: [
    { name: "Starter", cpu: 0.5, ramGb: 0.5, monthly: 7 },
    { name: "Standard", cpu: 1, ramGb: 2, monthly: 25 },
    { name: "Pro", cpu: 2, ramGb: 4, monthly: 85 },
    { name: "Pro Plus", cpu: 4, ramGb: 8, monthly: 175 },
    { name: "Pro Max", cpu: 4, ramGb: 16, monthly: 225 },
    { name: "Pro Ultra", cpu: 8, ramGb: 32, monthly: 450 },
  ],
} as const;

/**
 * Fly.io performance-CPU machine prices (US East), extra RAM, egress and volume prices as
 * published at https://fly.io/pricing and https://docs.fly.io/about/pricing on
 * {@link HOSTED_RATES_AS_OF}. A performance vCPU includes 2 GB RAM. Shared CPUs are
 * throttled under sustained load, so they are not priced here.
 */
export const FLY_RATES = {
  source: "https://fly.io/pricing",
  perPerformanceCpu: 33,
  ramPerCpuGb: 2,
  perExtraGbRam: 6,
  perGbEgress: 0.02,
  perGbVolumeMonth: 0.15,
  sizes: [1, 2, 4, 6, 8, 10, 12, 14, 16],
} as const;

/**
 * Prices a workload on Render: the smallest tier that holds it (or enough of the largest),
 * the Pro workspace, bandwidth beyond the included 25 GB, and disk.
 *
 * @param workload - Average resources used.
 * @returns The estimate.
 * @example
 * estimateRender({ vcpu: 3, ramGb: 12, egressGb: 300, volumeGb: 50 }).total; // 303.75
 */
export function estimateRender(workload: Workload): HostedEstimate {
  const vcpu = nonNegative(workload.vcpu);
  const ram = nonNegative(workload.ramGb);
  const largest = RENDER_RATES.tiers[RENDER_RATES.tiers.length - 1]!;
  const tier = RENDER_RATES.tiers.find((t) => t.cpu >= vcpu && t.ramGb >= ram);
  const count = tier ? 1 : Math.max(Math.ceil(vcpu / largest.cpu), Math.ceil(ram / largest.ramGb));
  const chosen = tier ?? largest;
  const egress =
    Math.max(0, nonNegative(workload.egressGb) - RENDER_RATES.includedEgressGb) *
    RENDER_RATES.perGbEgress;
  const disk = nonNegative(workload.volumeGb) * RENDER_RATES.perGbDiskMonth;
  return {
    id: "render",
    name: "Render",
    total: chosen.monthly * count + RENDER_RATES.workspaceFee + egress + disk,
    basis: `${count > 1 ? `${count} × ` : ""}${chosen.name} (${chosen.cpu} CPU, ${chosen.ramGb} GB) on the Pro workspace`,
    source: RENDER_RATES.source,
  };
}

/**
 * Prices a workload on Fly.io: performance machines with enough vCPUs, RAM beyond what
 * they include, egress in North America or Europe, and volumes.
 *
 * @param workload - Average resources used.
 * @returns The estimate.
 * @example
 * estimateFly({ vcpu: 3, ramGb: 12, egressGb: 300, volumeGb: 50 }).total; // 169.5
 */
export function estimateFly(workload: Workload): HostedEstimate {
  const vcpu = nonNegative(workload.vcpu);
  const largest = FLY_RATES.sizes[FLY_RATES.sizes.length - 1]!;
  const size = FLY_RATES.sizes.find((s) => s >= vcpu);
  const count = size ? 1 : Math.ceil(vcpu / largest);
  const cpus = (size ?? largest) * count;
  const extraRam = Math.max(0, nonNegative(workload.ramGb) - cpus * FLY_RATES.ramPerCpuGb);
  const total =
    cpus * FLY_RATES.perPerformanceCpu +
    extraRam * FLY_RATES.perExtraGbRam +
    nonNegative(workload.egressGb) * FLY_RATES.perGbEgress +
    nonNegative(workload.volumeGb) * FLY_RATES.perGbVolumeMonth;
  return {
    id: "fly",
    name: "Fly.io",
    total,
    basis: `${count > 1 ? `${count} × ` : ""}performance-${size ?? largest}x machine${extraRam > 0 ? ` with ${extraRam} GB extra RAM` : ""}`,
    source: FLY_RATES.source,
  };
}

/**
 * Prices a workload on the Railway Pro plan from {@link RAILWAY_RATES}.
 *
 * @param workload - Average resources used.
 * @returns The estimate.
 */
export function estimateRailway(workload: Workload): HostedEstimate {
  return {
    id: "railway",
    name: "Railway",
    total: estimatePaas(workload, RAILWAY_RATES).total,
    basis: "usage on the Pro plan",
    source: RAILWAY_RATES.source,
  };
}

/** The rented server {@link fleetFor} assumes, with its assumed monthly price. */
export const FLEET_SERVER: Readonly<Server> = DEFAULT_FLEET[0]!;

/**
 * Rents enough {@link FLEET_SERVER}s to hold a workload, never fewer than two so one can
 * fail.
 *
 * @param workload - Average resources used.
 * @returns The fleet.
 */
export function fleetFor(workload: Workload): Server[] {
  const count = Math.max(
    2,
    Math.ceil(nonNegative(workload.vcpu) / FLEET_SERVER.vcpu),
    Math.ceil(nonNegative(workload.ramGb) / FLEET_SERVER.ramGb),
  );
  return Array.from({ length: count }, (_, i) => ({ ...FLEET_SERVER, id: `s${i + 1}` }));
}

/** Result of {@link compareHosted}. */
export interface HostedComparison {
  fleet: Server[];
  selfHost: SelfHostEstimate;
  /** Every hosted estimate, cheapest first. */
  hosted: HostedEstimate[];
  /** Monthly savings against the cheapest and the dearest platform; negative means yours costs more. */
  savings: { min: number; max: number };
}

/**
 * Prices a workload on your own servers and on each hosted platform.
 *
 * @param workload - Average resources used.
 * @returns Both sides and the range of savings.
 */
export function compareHosted(workload: Workload): HostedComparison {
  const fleet = fleetFor(workload);
  const selfHost = estimateSelfHost(fleet);
  const hosted = [estimateRailway(workload), estimateRender(workload), estimateFly(workload)].sort(
    (a, b) => a.total - b.total,
  );
  return {
    fleet,
    selfHost,
    hosted,
    savings: {
      min: hosted[0]!.total - selfHost.total,
      max: hosted[hosted.length - 1]!.total - selfHost.total,
    },
  };
}
