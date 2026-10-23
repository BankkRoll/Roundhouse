/**
 * Provider-neutral plan recommendations from a list of offers.
 *
 * Works on any provider's {@link Offer}s (or a mix), so the dashboard shows
 * the same "cheapest that fits / more headroom / dedicated" choices for
 * every cloud.
 *
 * @module
 */
import type { Arch, NodeRole } from "./catalog";
import type { Offer } from "./provider";

/** What the server will run. All constraints are optional. */
export interface Workload {
  /**
   * `node` runs services; `builder` also builds images and hosts the
   * registry, which needs more disk. Default `node`.
   */
  role?: NodeRole;
  /** Minimum vCPUs. */
  minVcpus?: number;
  /** Minimum memory in MiB. */
  minMemoryMib?: number;
  /** Minimum local disk in GB. */
  minDiskGb?: number;
  /** Restrict to one architecture. Default: either. */
  arch?: Arch;
  /** Allowed regions, most preferred first. Default: any. */
  regions?: string[];
  /** `true` for dedicated vCPUs only, `false` for shared only. Default: either. */
  dedicated?: boolean;
  /** Budget cap for the monthly price, in cents of the offers' currency. */
  maxMonthlyCents?: number;
  /** How many suggestions to return. Default 3. */
  limit?: number;
}

/** A suggested offer and why. */
export interface Recommendation {
  /** The offer. */
  offer: Offer;
  /** Short reason for the UI, e.g. "Cheapest that fits". */
  reason: string;
}

/**
 * Minimums per role. The installer's floor is 1 vCPU, 1 GiB, and 10 GiB; these
 * leave room for Docker, Caddy, and workloads. Builders keep BuildKit's
 * 20 GiB cache and the registry on local disk.
 */
export const WORKLOAD_DEFAULTS: Record<
  NodeRole,
  { minVcpus: number; minMemoryMib: number; minDiskGb: number }
> = {
  node: { minVcpus: 2, minMemoryMib: 4096, minDiskGb: 40 },
  builder: { minVcpus: 2, minMemoryMib: 4096, minDiskGb: 80 },
};

const planKey = (o: Offer) => `${o.provider}:${o.plan}`;

/**
 * Suggests a few sensible offers for a workload. Pure.
 *
 * Each plan appears once, in its best region (allowed-region order, then the
 * provider's recommendation, then price). Picks, in order:
 * 1. the cheapest plan that fits;
 * 2. the cheapest with at least twice its memory ("more headroom");
 * 3. the cheapest dedicated-vCPU plan, when `dedicated` is unconstrained;
 * then fills with the next cheapest plans. Deprecated offers are never
 * suggested. Offers in different currencies are compared by their numbers,
 * so pass one provider's offers at a time unless the currencies match.
 *
 * @param offers - From `Provider.listOffers`.
 * @param workload - Constraints.
 * @returns Up to `workload.limit` (default 3) recommendations.
 * @example
 * recommend(await provider.listOffers(), { role: "builder", regions: ["fsn1", "nbg1"] });
 */
export function recommend(offers: Offer[], workload: Workload = {}): Recommendation[] {
  const min = WORKLOAD_DEFAULTS[workload.role ?? "node"];
  const minVcpus = workload.minVcpus ?? min.minVcpus;
  const minMemoryMib = workload.minMemoryMib ?? min.minMemoryMib;
  const minDiskGb = workload.minDiskGb ?? min.minDiskGb;
  const limit = workload.limit ?? 3;
  const allowed = workload.regions;

  const fits = offers.filter(
    (o) =>
      !o.deprecated &&
      o.vcpus >= minVcpus &&
      o.memoryMib >= minMemoryMib &&
      o.diskGb >= minDiskGb &&
      (!workload.arch || o.arch === workload.arch) &&
      (!allowed || allowed.includes(o.region)) &&
      (workload.dedicated === undefined || o.dedicated === workload.dedicated) &&
      (workload.maxMonthlyCents === undefined || o.price.monthlyCents <= workload.maxMonthlyCents),
  );

  const regionRank = (o: Offer) => (allowed ? allowed.indexOf(o.region) : 0);
  const best = new Map<string, Offer>();
  for (const o of fits) {
    const cur = best.get(planKey(o));
    if (
      !cur ||
      regionRank(o) < regionRank(cur) ||
      (regionRank(o) === regionRank(cur) &&
        (Number(o.recommended) > Number(cur.recommended) ||
          (o.recommended === cur.recommended && o.price.monthlyCents < cur.price.monthlyCents)))
    ) {
      best.set(planKey(o), o);
    }
  }
  const ranked = [...best.values()].sort(
    (a, b) => a.price.monthlyCents - b.price.monthlyCents || planKey(a).localeCompare(planKey(b)),
  );

  const picks: Recommendation[] = [];
  const take = (o: Offer | undefined, reason: string) => {
    if (o && picks.length < limit && !picks.some((p) => planKey(p.offer) === planKey(o))) {
      picks.push({ offer: o, reason });
    }
  };
  const first = ranked[0];
  if (!first) return [];
  take(first, "Cheapest that fits");
  take(
    ranked.find((o) => o.memoryMib >= first.memoryMib * 2),
    "More headroom",
  );
  if (workload.dedicated === undefined) {
    take(
      ranked.find((o) => o.dedicated),
      "Dedicated vCPU for steady load",
    );
  }
  for (const o of ranked) take(o, "Also fits");
  return picks;
}
