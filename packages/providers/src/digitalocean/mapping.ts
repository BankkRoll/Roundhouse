/**
 * Pure mappings between DigitalOcean wire types and the shared types.
 *
 * @module
 */
import { decimalToCents, type SupportedImageName } from "../catalog";
import { ANYWHERE_V4, ANYWHERE_V6, type FirewallRule } from "../firewall";
import { createTagCodec, readManagedIdentity, type TagCodec } from "../naming";
import type { CloudServer, Offer, ProviderImage, ServerStatus } from "../provider";
import type { DoDroplet, DoImage, DoInboundRule, DoOutboundRule, DoRegion, DoSize } from "./types";

/**
 * Tags allow only letters, digits, `:`, `-`, and `_`, so labels are written
 * as `roundhouse:node:web-1` (dots in keys and the `=` become `:`).
 */
export const DIGITALOCEAN_TAGS: TagCodec = createTagCodec({ separator: ":", keyDot: ":" });

/** DigitalOcean's tag grammar (letters, digits, `:`, `-`, `_`; at most 255). */
export const DIGITALOCEAN_TAG = /^[a-zA-Z0-9_:-]{1,255}$/;

/** Distribution slugs of the supported images. Every droplet is x86_64. */
export const DIGITALOCEAN_IMAGE_SLUGS: Record<string, SupportedImageName> = {
  "ubuntu-24-04-x64": "ubuntu-24.04",
  "ubuntu-22-04-x64": "ubuntu-22.04",
  "debian-12-x64": "debian-12",
};

/** Plan classes with dedicated vCPUs; `Basic` plans share them. */
const DEDICATED = /general purpose|cpu-optimized|memory-optimized|storage-optimized/i;

/**
 * Joins sizes with the regions they can be created in. Pure.
 *
 * A (size, region) pair is an offer when the size is available, has no GPU
 * (GPU sizes need GPU images), lists the region, and the region is
 * available. Prices are uniform across regions, in USD.
 *
 * @param sizes - From `GET /v2/sizes`.
 * @param regions - From `GET /v2/regions`.
 * @returns Offers.
 */
export function buildDigitalOceanOffers(sizes: DoSize[], regions: DoRegion[]): Offer[] {
  const bySlug = new Map(regions.map((r) => [r.slug, r]));
  const offers: Offer[] = [];
  for (const size of sizes) {
    if (!size.available || size.gpu_info) continue;
    for (const slug of size.regions) {
      const region = bySlug.get(slug);
      if (!region?.available) continue;
      offers.push({
        provider: "digitalocean",
        id: `${size.slug}@${slug}`,
        plan: size.slug,
        description: `${size.description} ${size.vcpus} vCPU / ${size.memory / 1024} GB`,
        category: size.description,
        region: slug,
        regionName: region.name,
        country: null,
        vcpus: size.vcpus,
        memoryMib: size.memory,
        diskGb: size.disk,
        arch: "amd64",
        dedicated: DEDICATED.test(size.description),
        price: { monthlyCents: decimalToCents(size.price_monthly), currency: "USD" },
        includedTrafficTb: size.transfer,
        recommended: false,
        deprecated: false,
        unavailableAfter: null,
      });
    }
  }
  return offers;
}

/**
 * Filters distribution images to the supported ones. Pure.
 *
 * @param images - From `GET /v2/images?type=distribution`.
 * @returns Supported images; the ID to create with is the slug.
 */
export function filterDigitalOceanImages(images: DoImage[]): ProviderImage[] {
  const out: ProviderImage[] = [];
  for (const img of images) {
    const name = img.slug ? DIGITALOCEAN_IMAGE_SLUGS[img.slug] : undefined;
    if (!name || img.status !== "available") continue;
    out.push({
      id: img.slug!,
      name,
      arch: "amd64",
      description: `${img.distribution} ${img.name}`,
      deprecated: false,
      regions: [...img.regions],
    });
  }
  return out;
}

const STATUS: Record<string, ServerStatus> = {
  new: "provisioning",
  active: "running",
  off: "stopped",
};

/**
 * Normalises a droplet.
 *
 * @param d - From the API.
 * @returns The shared shape.
 */
export function fromDroplet(d: DoDroplet): CloudServer {
  const labels = DIGITALOCEAN_TAGS.decode(d.tags ?? []);
  return {
    provider: "digitalocean",
    id: String(d.id),
    name: d.name,
    status: STATUS[d.status] ?? "unknown",
    providerStatus: d.status,
    ipv4: d.networks?.v4.find((n) => n.type === "public")?.ip_address ?? null,
    ipv6: d.networks?.v6.find((n) => n.type === "public")?.ip_address ?? null,
    region: d.region.slug,
    plan: d.size_slug,
    createdAt: d.created_at ?? null,
    labels,
    managed: readManagedIdentity(labels),
  };
}

/**
 * Maps the neutral rules to DigitalOcean's.
 *
 * IMPORTANT: a DigitalOcean cloud firewall denies outbound traffic that no
 * outbound rule allows, so every protocol is allowed out explicitly; agents
 * must reach the control plane, package mirrors, and registries.
 *
 * @param rules - Neutral inbound rules.
 * @returns DigitalOcean inbound and outbound rules.
 */
export function toDigitalOceanRules(rules: FirewallRule[]): {
  inbound_rules: DoInboundRule[];
  outbound_rules: DoOutboundRule[];
} {
  const everywhere = { addresses: [ANYWHERE_V4, ANYWHERE_V6] };
  return {
    inbound_rules: rules.map((r) => ({
      protocol: r.protocol,
      ports: String(r.port),
      sources: { addresses: [...r.sources] },
    })),
    outbound_rules: (["tcp", "udp", "icmp"] as const).map((protocol) => ({
      protocol,
      ports: "0",
      destinations: everywhere,
    })),
  };
}
