/**
 * Pure mappings between Hetzner wire types and the shared types: offers,
 * images, servers, and firewall rules.
 *
 * @module
 */
import {
  type Arch,
  decimalToCents,
  isPast,
  isSupportedImage,
  SUPPORTED_IMAGES,
  type SupportedImageName,
} from "../catalog";
import type { FirewallRule as NeutralRule } from "../firewall";
import { readManagedIdentity } from "../naming";
import type { CloudServer, Offer, ProviderImage, ServerStatus } from "../provider";
import type {
  DeprecationInfo,
  FirewallRule,
  HetznerArchitecture,
  Image,
  Location,
  Pricing,
  Server,
  ServerType,
} from "./types";

/**
 * Maps Hetzner's architecture name to the agent's.
 *
 * @param arch - `x86` or `arm`.
 * @returns `amd64` or `arm64`.
 */
export function toArch(arch: HetznerArchitecture): Arch {
  return arch === "arm" ? "arm64" : "amd64";
}

/**
 * Maps the agent's architecture name to Hetzner's.
 *
 * @param arch - `amd64` or `arm64`.
 * @returns `x86` or `arm`.
 */
export function toHetznerArch(arch: Arch): HetznerArchitecture {
  return arch === "arm64" ? "arm" : "x86";
}

/**
 * Joins server types with their per-location availability and prices. Pure.
 *
 * A (type, location) pair is an offer when the type lists the location, is
 * `available` there, has a price there, the location is known, and the
 * location's deprecation (if any) has not reached `unavailable_after`.
 * Deprecated pairs that are still orderable are included and flagged.
 *
 * @param serverTypes - From `GET /server_types`.
 * @param locations - From `GET /locations`.
 * @param pricing - Currency from `GET /pricing`.
 * @param now - Current unix ms.
 * @returns Offers with gross monthly prices.
 */
export function buildHetznerOffers(
  serverTypes: ServerType[],
  locations: Location[],
  pricing: Pick<Pricing, "currency">,
  now: number,
): Offer[] {
  const byName = new Map(locations.map((l) => [l.name, l]));
  const offers: Offer[] = [];
  for (const st of serverTypes) {
    for (const tl of st.locations) {
      if (!tl.available) continue;
      // `deprecated` and type-level `deprecation` are legacy fields; they
      // still count so a type Hetzner flags either way is never offered silently.
      const deprecation: DeprecationInfo | null = tl.deprecation ?? st.deprecation ?? null;
      if (isPast(deprecation?.unavailable_after, now)) continue;
      const price = st.prices.find((p) => p.location === tl.name);
      const loc = byName.get(tl.name);
      if (!price || !loc) continue;
      offers.push({
        provider: "hetzner",
        id: `${st.name}@${loc.name}`,
        plan: st.name,
        description: st.description,
        category: st.category ?? null,
        region: loc.name,
        regionName: loc.city,
        country: loc.country,
        vcpus: st.cores,
        memoryMib: Math.round(st.memory * 1024),
        diskGb: st.disk,
        arch: toArch(st.architecture),
        dedicated: st.cpu_type === "dedicated",
        price: {
          monthlyCents: decimalToCents(price.price_monthly.gross),
          currency: pricing.currency,
        },
        includedTrafficTb: price.included_traffic / 1e12,
        recommended: tl.recommended,
        deprecated: deprecation != null || st.deprecated === true,
        unavailableAfter: deprecation?.unavailable_after ?? null,
      });
    }
  }
  return offers;
}

/**
 * Filters images to the supported, orderable system images. Pure.
 *
 * @param images - From `GET /images`.
 * @param now - Current unix ms.
 * @returns Supported images, ordered as {@link SUPPORTED_IMAGES} then by architecture.
 */
export function filterHetznerImages(images: Image[], now: number): ProviderImage[] {
  const out: ProviderImage[] = [];
  for (const img of images) {
    if (img.type !== "system" || img.status !== "available") continue;
    if (!img.name || !isSupportedImage(img.name)) continue;
    if (isPast(img.deprecation?.unavailable_after, now)) continue;
    out.push({
      id: String(img.id),
      name: img.name as SupportedImageName,
      arch: toArch(img.architecture),
      description: img.description,
      deprecated: img.deprecation != null,
      regions: null,
    });
  }
  const rank = (n: string) => (SUPPORTED_IMAGES as readonly string[]).indexOf(n);
  return out.sort((a, b) => rank(a.name) - rank(b.name) || a.arch.localeCompare(b.arch));
}

/**
 * The address Hetzner's images configure on the server: the first host of
 * its /64.
 *
 * @param network - IPv6 network such as `2001:db8::/64`.
 * @returns E.g. `2001:db8::1`.
 */
export function ipv6HostAddress(network: string): string {
  const prefix = network.split("/")[0]!;
  return prefix.endsWith("::") ? `${prefix}1` : prefix;
}

const STATUS: Record<string, ServerStatus> = {
  running: "running",
  initializing: "provisioning",
  starting: "provisioning",
  rebuilding: "provisioning",
  migrating: "provisioning",
  off: "stopped",
  stopping: "stopped",
  deleting: "deleting",
};

/**
 * Normalises a Hetzner server.
 *
 * @param server - From the API.
 * @returns The shared shape.
 */
export function fromHetznerServer(server: Server): CloudServer {
  const v6 = server.public_net.ipv6?.ip ?? null;
  const labels = server.labels ?? {};
  return {
    provider: "hetzner",
    id: String(server.id),
    name: server.name,
    status: STATUS[server.status] ?? "unknown",
    providerStatus: server.status,
    ipv4: server.public_net.ipv4?.ip ?? null,
    ipv6: v6 ? ipv6HostAddress(v6) : null,
    region: server.location.name,
    plan: server.server_type.name,
    createdAt: server.created ?? null,
    labels,
    managed: readManagedIdentity(labels),
  };
}

/**
 * Maps the neutral rules to Hetzner's. Hetzner blocks all other inbound
 * traffic once a firewall has rules, and allows all outbound traffic when
 * there are no outbound rules, so only inbound rules are sent.
 *
 * @param rules - Neutral inbound rules.
 * @returns Hetzner firewall rules.
 */
export function toHetznerRules(rules: NeutralRule[]): FirewallRule[] {
  return rules.map((r) => ({
    direction: "in",
    protocol: r.protocol,
    port: String(r.port),
    source_ips: [...r.sources],
    description: r.description,
  }));
}
