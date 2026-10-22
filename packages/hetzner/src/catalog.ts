/**
 * What can be ordered: supported OS images, purchasable offers (server type
 * x location with live prices), and workload-based recommendations.
 *
 * Plan names and prices change (Hetzner retired the cx11 line in 2024 and the
 * cx22/cpx11 lines on 2026-01-01), so nothing here hard-codes either; every
 * offer comes from `GET /server_types` at call time.
 *
 * @module
 */
import type { HetznerClient, RequestOptions } from "./client";
import type {
  DeprecationInfo,
  HetznerArchitecture,
  Image,
  Location,
  Pricing,
  ServerType,
} from "./types";

/** Architecture as the agent and installer name it. */
export type NodeArchitecture = "amd64" | "arm64";

/** OS images the installer supports (see install/README.md). */
export const SUPPORTED_IMAGES = ["ubuntu-24.04", "ubuntu-22.04", "debian-12"] as const;

/** Name of a supported OS image. */
export type SupportedImageName = (typeof SUPPORTED_IMAGES)[number];

/** Default OS image for new servers. */
export const DEFAULT_IMAGE: SupportedImageName = "ubuntu-24.04";

/**
 * Maps Hetzner's architecture name to the agent's.
 *
 * @param arch - `x86` or `arm`.
 * @returns `amd64` or `arm64`.
 */
export function toNodeArchitecture(arch: HetznerArchitecture): NodeArchitecture {
  return arch === "arm" ? "arm64" : "amd64";
}

/**
 * Maps the agent's architecture name to Hetzner's.
 *
 * @param arch - `amd64` or `arm64`.
 * @returns `x86` or `arm`.
 */
export function toHetznerArchitecture(arch: NodeArchitecture): HetznerArchitecture {
  return arch === "arm64" ? "arm" : "x86";
}

function isPast(iso: string | undefined | null, now: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= now;
}

// -----------------------------------------------------------------------------
// Images
// -----------------------------------------------------------------------------

/** A supported OS image for one architecture. */
export interface SupportedImage {
  /** Image ID; pass it as `image` when creating a server. */
  id: number;
  name: SupportedImageName;
  description: string;
  architecture: NodeArchitecture;
  /** `true` once Hetzner has announced the image's removal. */
  deprecated: boolean;
}

/**
 * Filters images to the supported, orderable system images. Pure.
 *
 * @param images - Images from `GET /images`.
 * @param now - Current time in unix ms.
 * @returns Supported images, ordered as {@link SUPPORTED_IMAGES} then by architecture.
 */
export function filterSupportedImages(images: Image[], now = Date.now()): SupportedImage[] {
  const out: SupportedImage[] = [];
  for (const img of images) {
    if (img.type !== "system" || img.status !== "available") continue;
    if (!(SUPPORTED_IMAGES as readonly string[]).includes(img.name ?? "")) continue;
    if (isPast(img.deprecation?.unavailable_after, now)) continue;
    out.push({
      id: img.id,
      name: img.name as SupportedImageName,
      description: img.description,
      architecture: toNodeArchitecture(img.architecture),
      deprecated: img.deprecation != null,
    });
  }
  const rank = (n: string) => (SUPPORTED_IMAGES as readonly string[]).indexOf(n);
  return out.sort(
    (a, b) => rank(a.name) - rank(b.name) || a.architecture.localeCompare(b.architecture),
  );
}

/**
 * Lists supported, orderable OS images (Ubuntu 22.04/24.04, Debian 12) for
 * amd64 and arm64.
 *
 * @param api - Hetzner client.
 * @param filter - Optional architecture.
 * @param options - Signal and timeout.
 * @returns Supported images.
 */
export async function listSupportedImages(
  api: HetznerClient,
  filter: { architecture?: NodeArchitecture } = {},
  options: RequestOptions = {},
): Promise<SupportedImage[]> {
  const images = await api.listImages(
    {
      type: "system",
      status: "available",
      architecture: filter.architecture ? toHetznerArchitecture(filter.architecture) : undefined,
    },
    options,
  );
  return filterSupportedImages(images);
}

// -----------------------------------------------------------------------------
// Offers
// -----------------------------------------------------------------------------

/** One orderable server type in one location, priced. */
export interface Offer {
  /** Server type name to order, e.g. `cpx22`. */
  serverType: string;
  serverTypeId: number;
  description: string;
  /** Hetzner's category, e.g. `"Shared vCPU"`, when provided. */
  category: string | null;
  /** Location name to order in, e.g. `fsn1`. */
  location: string;
  city: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  networkZone: string;
  architecture: NodeArchitecture;
  cpuType: "shared" | "dedicated";
  vcpus: number;
  memoryGb: number;
  diskGb: number;
  storageType: "local" | "network";
  /** Currency of all prices; Hetzner bills in the project owner's currency (EUR for most). */
  currency: string;
  /** Monthly price cap as decimal strings, as Hetzner returns them. */
  priceMonthly: { net: string; gross: string };
  priceHourly: { net: string; gross: string };
  /** Gross monthly price in minor units (cents), for sorting and display. */
  monthlyGrossCents: number;
  /** Included outbound traffic in TB. */
  includedTrafficTb: number;
  /** Hetzner's own recommendation flag for this type in this location. */
  recommended: boolean;
  /** Deprecated but still orderable. Only present when requested. */
  deprecated: boolean;
  /** RFC 3339 time the offer stops being orderable, when deprecated. */
  unavailableAfter: string | null;
}

/** Options for {@link buildOffers} and {@link listOffers}. */
export interface OfferOptions {
  /**
   * Include deprecated types that can still be ordered (flagged
   * `deprecated: true`). Default `false`. Types past `unavailable_after`
   * and temporarily unavailable ones are always excluded.
   */
  includeDeprecated?: boolean;
  /** Current time in unix ms. */
  now?: number;
}

/**
 * Converts a decimal string to minor units with half-up rounding, without
 * floating point (`"1.0050"` is 101, not 100).
 *
 * @param decimal - Non-negative decimal string, e.g. `"4.7481"`.
 * @returns Cents.
 */
export function decimalToCents(decimal: string): number {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(decimal.trim());
  if (!m) throw new RangeError(`not a decimal amount: ${decimal}`);
  const frac = (m[2] ?? "").padEnd(3, "0");
  const cents = Number(m[1]) * 100 + Number(frac.slice(0, 2));
  return Number(frac[2]) >= 5 ? cents + 1 : cents;
}

/**
 * Joins server types with their per-location availability and prices. Pure.
 *
 * A (type, location) pair is an offer when the type lists the location, is
 * `available` there, has a price there, the location is known, and the
 * location's deprecation (if any) has not reached `unavailable_after`.
 *
 * @param serverTypes - From `GET /server_types`.
 * @param locations - From `GET /locations`.
 * @param pricing - Currency from `GET /pricing`.
 * @param options - Deprecated handling and clock.
 * @returns Offers sorted by gross monthly price, then type, then location.
 */
export function buildOffers(
  serverTypes: ServerType[],
  locations: Location[],
  pricing: Pick<Pricing, "currency">,
  options: OfferOptions = {},
): Offer[] {
  const now = options.now ?? Date.now();
  const byName = new Map(locations.map((l) => [l.name, l]));
  const offers: Offer[] = [];
  for (const st of serverTypes) {
    for (const tl of st.locations) {
      if (!tl.available) continue;
      // `deprecated` and type-level `deprecation` are legacy fields; they
      // still count so a type Hetzner flags either way is never offered silently.
      const deprecation: DeprecationInfo | null = tl.deprecation ?? st.deprecation ?? null;
      const deprecated = deprecation != null || st.deprecated === true;
      if (isPast(deprecation?.unavailable_after, now)) continue;
      if (deprecated && !options.includeDeprecated) continue;
      const price = st.prices.find((p) => p.location === tl.name);
      const loc = byName.get(tl.name);
      if (!price || !loc) continue;
      offers.push({
        serverType: st.name,
        serverTypeId: st.id,
        description: st.description,
        category: st.category ?? null,
        location: loc.name,
        city: loc.city,
        country: loc.country,
        networkZone: loc.network_zone,
        architecture: toNodeArchitecture(st.architecture),
        cpuType: st.cpu_type,
        vcpus: st.cores,
        memoryGb: st.memory,
        diskGb: st.disk,
        storageType: st.storage_type,
        currency: pricing.currency,
        priceMonthly: { net: price.price_monthly.net, gross: price.price_monthly.gross },
        priceHourly: { net: price.price_hourly.net, gross: price.price_hourly.gross },
        monthlyGrossCents: decimalToCents(price.price_monthly.gross),
        includedTrafficTb: price.included_traffic / 1e12,
        recommended: tl.recommended,
        deprecated,
        unavailableAfter: deprecation?.unavailable_after ?? null,
      });
    }
  }
  return offers.sort(
    (a, b) =>
      a.monthlyGrossCents - b.monthlyGrossCents ||
      a.serverType.localeCompare(b.serverType) ||
      a.location.localeCompare(b.location),
  );
}

/**
 * Fetches server types, locations, and pricing in parallel and returns the
 * live list of orderable offers.
 *
 * @param api - Hetzner client.
 * @param options - Deprecated handling, clock, signal, and timeout.
 * @returns Offers sorted by gross monthly price.
 * @example
 * const offers = await listOffers(new HetznerClient({ token }));
 * const cheapest = offers[0]; // e.g. { serverType: "cx23", location: "fsn1", ... }
 */
export async function listOffers(
  api: HetznerClient,
  options: OfferOptions & RequestOptions = {},
): Promise<Offer[]> {
  const req = { signal: options.signal, timeoutMs: options.timeoutMs };
  const [types, locations, pricing] = await Promise.all([
    api.listServerTypes({}, req),
    api.listLocations(req),
    api.getPricing(req),
  ]);
  return buildOffers(types, locations, pricing, options);
}

// -----------------------------------------------------------------------------
// Recommendations
// -----------------------------------------------------------------------------

/** What the server will run. All constraints are optional. */
export interface Workload {
  /**
   * `app` runs services; `builder` also builds images and hosts the registry,
   * which needs more memory and disk. Default `app`.
   */
  role?: "app" | "builder";
  minVcpus?: number;
  minMemoryGb?: number;
  minDiskGb?: number;
  /** Restrict to one architecture. Default: either. */
  architecture?: NodeArchitecture;
  /** Allowed locations, most preferred first. Default: any. */
  locations?: string[];
  /** Restrict to a network zone, e.g. `eu-central`. */
  networkZone?: string;
  cpuType?: "shared" | "dedicated";
  /** Budget cap for the gross monthly price, in cents. */
  maxMonthlyGrossCents?: number;
  /** How many suggestions to return. Default 3. */
  limit?: number;
}

/** A suggested offer and why. */
export interface Recommendation {
  offer: Offer;
  /** Short reason for the UI, e.g. "Cheapest that fits". */
  reason: string;
}

/**
 * Minimums per role. The installer's floor is 1 vCPU, 1 GiB, and 10 GiB; these
 * leave room for Docker, Caddy, and workloads. Builders keep BuildKit's
 * 20 GiB cache and the registry on local disk.
 */
export const WORKLOAD_DEFAULTS = {
  app: { minVcpus: 2, minMemoryGb: 4, minDiskGb: 40 },
  builder: { minVcpus: 2, minMemoryGb: 4, minDiskGb: 80 },
} as const;

/**
 * Suggests a few sensible offers for a workload. Pure.
 *
 * Each server type appears once, in its best location (allowed-location
 * order, then Hetzner's recommendation, then price). Picks, in order:
 * 1. the cheapest type that fits;
 * 2. the cheapest with at least twice its memory ("more headroom");
 * 3. the cheapest dedicated-vCPU type, when CPU type is unconstrained;
 * then fills with the next cheapest types.
 *
 * @param offers - From {@link listOffers}.
 * @param workload - Constraints.
 * @returns Up to `workload.limit` (default 3) recommendations.
 * @example
 * recommend(offers, { role: "builder", locations: ["fsn1", "nbg1"] });
 */
export function recommend(offers: Offer[], workload: Workload = {}): Recommendation[] {
  const role = workload.role ?? "app";
  const min = WORKLOAD_DEFAULTS[role];
  const minVcpus = workload.minVcpus ?? min.minVcpus;
  const minMemoryGb = workload.minMemoryGb ?? min.minMemoryGb;
  const minDiskGb = workload.minDiskGb ?? min.minDiskGb;
  const limit = workload.limit ?? 3;
  const allowed = workload.locations;

  const fits = offers.filter(
    (o) =>
      !o.deprecated &&
      o.vcpus >= minVcpus &&
      o.memoryGb >= minMemoryGb &&
      o.diskGb >= minDiskGb &&
      (!workload.architecture || o.architecture === workload.architecture) &&
      (!allowed || allowed.includes(o.location)) &&
      (!workload.networkZone || o.networkZone === workload.networkZone) &&
      (!workload.cpuType || o.cpuType === workload.cpuType) &&
      (workload.maxMonthlyGrossCents === undefined ||
        o.monthlyGrossCents <= workload.maxMonthlyGrossCents),
  );

  const locRank = (o: Offer) => (allowed ? allowed.indexOf(o.location) : 0);
  const best = new Map<string, Offer>();
  for (const o of fits) {
    const cur = best.get(o.serverType);
    if (
      !cur ||
      locRank(o) < locRank(cur) ||
      (locRank(o) === locRank(cur) &&
        (Number(o.recommended) > Number(cur.recommended) ||
          (o.recommended === cur.recommended && o.monthlyGrossCents < cur.monthlyGrossCents)))
    ) {
      best.set(o.serverType, o);
    }
  }
  const ranked = [...best.values()].sort(
    (a, b) => a.monthlyGrossCents - b.monthlyGrossCents || a.serverType.localeCompare(b.serverType),
  );

  const picks: Recommendation[] = [];
  const take = (o: Offer | undefined, reason: string) => {
    if (o && picks.length < limit && !picks.some((p) => p.offer.serverType === o.serverType)) {
      picks.push({ offer: o, reason });
    }
  };
  const first = ranked[0];
  if (!first) return [];
  take(first, "Cheapest that fits");
  take(
    ranked.find((o) => o.memoryGb >= first.memoryGb * 2),
    "More headroom",
  );
  if (!workload.cpuType) {
    take(
      ranked.find((o) => o.cpuType === "dedicated"),
      "Dedicated vCPU for steady load",
    );
  }
  for (const o of ranked) take(o, "Also fits");
  return picks;
}
