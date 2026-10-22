/**
 * Cost model for the landing page calculator: what a workload costs on your own servers
 * (server bills plus the Cloudflare Workers Paid plan) versus an estimate at Railway's
 * public list price.
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
