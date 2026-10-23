/**
 * Pure mappings between Vultr wire types and the shared types.
 *
 * @module
 */
import { decimalToCents, type SupportedImageName } from "../catalog";
import type { FirewallRule } from "../firewall";
import { createTagCodec, readManagedIdentity, type TagCodec } from "../naming";
import type { CloudServer, Offer, ProviderImage, ServerStatus } from "../provider";
import type { VultrCreateRuleBody, VultrInstance, VultrOs, VultrPlan, VultrRegion } from "./types";

/**
 * Vultr documents no tag grammar and its own examples contain spaces, so
 * labels are written as `roundhouse.node=web-1`.
 */
export const VULTR_TAGS: TagCodec = createTagCodec({ separator: "=" });

/** Plan type prefixes with dedicated vCPUs (Optimized Cloud Compute, Dedicated Cloud). */
const DEDICATED_TYPES = /^(voc|vdc)/;

/** Display names of plan types. */
const CATEGORIES: Record<string, string> = {
  vc2: "Cloud Compute",
  vhf: "High Frequency",
  vhp: "High Performance",
  voc: "Optimized Cloud Compute",
  vdc: "Dedicated Cloud",
};

/** OS names of the supported images, matched by prefix. Every OS is x64. */
const OS_NAMES: [RegExp, SupportedImageName][] = [
  [/^Ubuntu 24\.04\b/, "ubuntu-24.04"],
  [/^Ubuntu 22\.04\b/, "ubuntu-22.04"],
  [/^Debian 12\b/, "debian-12"],
];

/**
 * Joins plans with the regions they deploy in. Pure.
 *
 * Prices differ by region: `location_cost[region]` overrides `monthly_cost`.
 * GPU plans and plans that cannot be deployed on demand are skipped.
 *
 * @param plans - From `GET /v2/plans?type=all`.
 * @param regions - From `GET /v2/regions`.
 * @returns Offers in USD.
 */
export function buildVultrOffers(plans: VultrPlan[], regions: VultrRegion[]): Offer[] {
  const byId = new Map(regions.map((r) => [r.id, r]));
  const offers: Offer[] = [];
  for (const plan of plans) {
    if ((plan.gpu_brand && plan.gpu_brand !== "none") || plan.deploy_ondemand === false) continue;
    for (const id of plan.locations) {
      const region = byId.get(id);
      if (!region) continue;
      const monthly = plan.location_cost?.[id]?.monthly_cost ?? plan.monthly_cost;
      const category = CATEGORIES[plan.type.split("-")[0]!] ?? plan.type;
      offers.push({
        provider: "vultr",
        id: `${plan.id}@${id}`,
        plan: plan.id,
        description: `${category} ${plan.vcpu_count} vCPU / ${plan.ram / 1024} GB`,
        category,
        region: id,
        regionName: region.city,
        country: region.country || null,
        vcpus: plan.vcpu_count,
        memoryMib: plan.ram,
        diskGb: plan.disk,
        arch: "amd64",
        dedicated: DEDICATED_TYPES.test(plan.type),
        price: { monthlyCents: decimalToCents(monthly), currency: "USD" },
        includedTrafficTb: plan.bandwidth / 1000,
        recommended: false,
        deprecated: false,
        unavailableAfter: null,
      });
    }
  }
  return offers;
}

/**
 * Filters the OS list to the supported images. Pure.
 *
 * @param list - From `GET /v2/os`.
 * @returns Supported images; the ID to create with is the numeric `os_id`.
 */
export function filterVultrImages(list: VultrOs[]): ProviderImage[] {
  const out: ProviderImage[] = [];
  for (const os of list) {
    if (os.arch !== "x64") continue;
    const name = OS_NAMES.find(([re]) => re.test(os.name))?.[1];
    if (!name || out.some((i) => i.name === name)) continue;
    out.push({
      id: String(os.id),
      name,
      arch: "amd64",
      description: os.name,
      deprecated: false,
      regions: null,
    });
  }
  return out;
}

/**
 * Normalises a Vultr instance status. Vultr reports three fields; a server
 * runs once `status` is `active` and `power_status` is `running`.
 *
 * @param i - Instance.
 * @returns The shared status.
 */
export function vultrStatus(i: Pick<VultrInstance, "status" | "power_status">): ServerStatus {
  if (i.status === "pending" || i.status === "resizing") return "provisioning";
  if (i.status === "active") return i.power_status === "running" ? "running" : "stopped";
  if (i.status === "suspended") return "stopped";
  return "unknown";
}

/**
 * Normalises an instance.
 *
 * @param i - From the API.
 * @returns The shared shape.
 */
export function fromVultrInstance(i: VultrInstance): CloudServer {
  const labels = VULTR_TAGS.decode(i.tags ?? []);
  return {
    provider: "vultr",
    id: i.id,
    name: i.label,
    status: vultrStatus(i),
    providerStatus: `${i.status}/${i.power_status}/${i.server_status}`,
    ipv4: i.main_ip && i.main_ip !== "0.0.0.0" ? i.main_ip : null,
    ipv6: i.v6_main_ip ? i.v6_main_ip : null,
    region: i.region,
    plan: i.plan,
    createdAt: i.date_created ?? null,
    labels,
    managed: readManagedIdentity(labels),
  };
}

/**
 * Maps the neutral rules to Vultr's. A Vultr rule holds one IP family and
 * one subnet, so each neutral rule becomes one rule per source. Vultr drops
 * inbound traffic no rule accepts and does not filter outbound traffic.
 *
 * @param rules - Neutral inbound rules.
 * @returns Rule bodies for `POST /v2/firewalls/{id}/rules`.
 */
export function toVultrRules(rules: FirewallRule[]): VultrCreateRuleBody[] {
  const out: VultrCreateRuleBody[] = [];
  for (const r of rules) {
    for (const cidr of r.sources) {
      const [subnet, size] = cidr.split("/");
      out.push({
        ip_type: subnet!.includes(":") ? "v6" : "v4",
        protocol: r.protocol,
        port: String(r.port),
        subnet: subnet!,
        subnet_size: Number(size ?? (subnet!.includes(":") ? 128 : 32)),
        source: "",
        notes: r.description,
      });
    }
  }
  return out;
}
