/**
 * Pure mappings between Linode wire types and the shared types.
 *
 * @module
 */
import { decimalToCents, type SupportedImageName } from "../catalog";
import type { FirewallRule } from "../firewall";
import { createTagCodec, readManagedIdentity, type TagCodec } from "../naming";
import type { CloudServer, Offer, ProviderImage, ServerStatus } from "../provider";
import type { Linode, LinodeFirewallRules, LinodeImage, LinodeRegion, LinodeType } from "./types";

/**
 * Linode documents no tag grammar beyond 3-50 characters, so labels are
 * written as `roundhouse.node=web-1`.
 */
export const LINODE_TAGS: TagCodec = createTagCodec({ separator: "=" });

/** Tag length limits (`POST /tags`: 3-50 characters). */
export const LINODE_TAG_LENGTH = { min: 3, max: 50 } as const;

/** Image IDs of the supported images. Every Linode is x86_64. */
export const LINODE_IMAGE_IDS: Record<string, SupportedImageName> = {
  "linode/ubuntu24.04": "ubuntu-24.04",
  "linode/ubuntu22.04": "ubuntu-22.04",
  "linode/debian12": "debian-12",
};

/**
 * Capabilities a region needs: Linodes, the Metadata service (the only
 * way to pass cloud-init user data), and Cloud Firewalls.
 */
export const LINODE_REGION_CAPABILITIES = ["Linodes", "Metadata", "Cloud Firewall"] as const;

/** Classes skipped: GPU and accelerator plans need special images. */
const SKIPPED_CLASSES = new Set(["gpu", "accelerated"]);

/** Classes with dedicated vCPUs. */
const DEDICATED_CLASSES = new Set(["dedicated", "premium", "highmem"]);

const CLASS_NAMES: Record<string, string> = {
  nanode: "Shared CPU (Nanode)",
  standard: "Shared CPU",
  dedicated: "Dedicated CPU",
  premium: "Premium",
  highmem: "High Memory",
};

/**
 * Whether a region can host a provisioned node: operational, a core site,
 * and with every capability in {@link LINODE_REGION_CAPABILITIES}.
 *
 * @param region - From `GET /v4/regions`.
 * @returns `true` when usable.
 */
export function isUsableRegion(region: LinodeRegion): boolean {
  return (
    region.status === "ok" &&
    region.site_type === "core" &&
    LINODE_REGION_CAPABILITIES.every((c) => region.capabilities.includes(c))
  );
}

/**
 * Joins types with usable regions. Pure.
 *
 * Linode does not say per type which regions sell it; every core region
 * with the capabilities is assumed to sell every shared and dedicated type,
 * and premium types need `Premium Plans`. `region_prices` overrides the
 * base price where present. A type with a `successor` is being retired and
 * is flagged deprecated.
 *
 * @param types - From `GET /v4/linode/types`.
 * @param regions - From `GET /v4/regions`.
 * @returns Offers in USD.
 */
export function buildLinodeOffers(types: LinodeType[], regions: LinodeRegion[]): Offer[] {
  const usable = regions.filter(isUsableRegion);
  const offers: Offer[] = [];
  for (const t of types) {
    if (SKIPPED_CLASSES.has(t.class) || t.gpus > 0) continue;
    for (const region of usable) {
      if (t.class === "premium" && !region.capabilities.includes("Premium Plans")) continue;
      const monthly = t.region_prices.find((p) => p.id === region.id)?.monthly ?? t.price.monthly;
      offers.push({
        provider: "linode",
        id: `${t.id}@${region.id}`,
        plan: t.id,
        description: t.label,
        category: CLASS_NAMES[t.class] ?? t.class,
        region: region.id,
        regionName: region.label,
        country: region.country ? region.country.toUpperCase() : null,
        vcpus: t.vcpus,
        memoryMib: t.memory,
        diskGb: Math.floor(t.disk / 1024),
        arch: "amd64",
        dedicated: DEDICATED_CLASSES.has(t.class),
        price: { monthlyCents: decimalToCents(monthly), currency: "USD" },
        includedTrafficTb: t.transfer / 1000,
        recommended: false,
        deprecated: t.successor !== null,
        unavailableAfter: null,
      });
    }
  }
  return offers;
}

/**
 * Filters public images to the supported ones that read Metadata user data
 * (the `cloud-init` capability). Pure.
 *
 * @param images - From `GET /v4/images`.
 * @returns Supported images; the ID to create with is the image ID.
 */
export function filterLinodeImages(images: LinodeImage[]): ProviderImage[] {
  const out: ProviderImage[] = [];
  for (const img of images) {
    const name = LINODE_IMAGE_IDS[img.id];
    if (!name || img.status !== "available" || !img.capabilities.includes("cloud-init")) continue;
    out.push({
      id: img.id,
      name,
      arch: "amd64",
      description: img.label,
      deprecated: img.deprecated,
      regions: null,
    });
  }
  return out;
}

const STATUS: Record<string, ServerStatus> = {
  running: "running",
  provisioning: "provisioning",
  booting: "provisioning",
  rebooting: "provisioning",
  rebuilding: "provisioning",
  migrating: "provisioning",
  cloning: "provisioning",
  restoring: "provisioning",
  offline: "stopped",
  stopped: "stopped",
  shutting_down: "stopped",
  deleting: "deleting",
};

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * Normalises a Linode.
 *
 * @param l - From the API.
 * @returns The shared shape.
 */
export function fromLinode(l: Linode): CloudServer {
  const labels = LINODE_TAGS.decode(l.tags ?? []);
  return {
    provider: "linode",
    id: String(l.id),
    name: l.label,
    status: STATUS[l.status] ?? "unknown",
    providerStatus: l.status,
    ipv4: l.ipv4?.find((ip) => !PRIVATE_V4.test(ip)) ?? null,
    ipv6: l.ipv6 ? l.ipv6.split("/")[0]! : null,
    region: l.region,
    plan: l.type,
    createdAt: l.created ?? null,
    labels,
    managed: readManagedIdentity(labels),
  };
}

/**
 * Maps the neutral rules to a Linode rule set: drop inbound by default,
 * accept outbound, and one accept rule per neutral rule.
 *
 * @param rules - Neutral inbound rules.
 * @returns The rule set.
 */
export function toLinodeRules(rules: FirewallRule[]): LinodeFirewallRules {
  return {
    inbound_policy: "DROP",
    outbound_policy: "ACCEPT",
    inbound: rules.map((r) => {
      const ipv4 = r.sources.filter((s) => !s.includes(":"));
      const ipv6 = r.sources.filter((s) => s.includes(":"));
      return {
        action: "ACCEPT",
        protocol: r.protocol === "tcp" ? "TCP" : "UDP",
        ports: String(r.port),
        addresses: { ...(ipv4.length ? { ipv4 } : {}), ...(ipv6.length ? { ipv6 } : {}) },
        description: r.description,
      };
    }),
    outbound: [],
  };
}
