/**
 * In-memory state for the cloud provider mocks: which providers each workspace has
 * connected, its provisioning runs, and a small static catalogue of priced offers per
 * provider (EUR for Hetzner, USD elsewhere, as those providers bill).
 *
 * @module
 */
import type { ProviderId } from "@roundhouse/providers";
import type { NodeProvision, ProviderOffer } from "../lib/api/providers-types";

/** A stored connection. The mock keeps no token, only what the API would return. */
export interface DbIntegration {
  workspace_id: string;
  provider: ProviderId;
  account_label: string | null;
  token_fingerprint: string;
  token_last4: string;
  last_validated_at: number;
  updated_at: number;
}

/** A stored provisioning run. */
export type DbProvision = NodeProvision & { workspace_id: string };

/** Provider state of the mock database. */
export interface ProvidersDb {
  integrations: DbIntegration[];
  provisions: DbProvision[];
}

/**
 * Provider state with nothing connected and no runs.
 *
 * @returns Empty state.
 */
export function emptyProviders(): ProvidersDb {
  return { integrations: [], provisions: [] };
}

type OfferSeed = [
  plan: string,
  description: string,
  vcpus: number,
  memoryMib: number,
  diskGb: number,
  arch: ProviderOffer["arch"],
  monthlyCents: number,
];

type RegionSeed = [region: string, name: string, country: string];

function offers(
  plans: OfferSeed[],
  regions: RegionSeed[],
  currency: string,
  traffic: number | null,
): ProviderOffer[] {
  return plans.flatMap(([plan, description, vcpus, memory_mib, disk_gb, arch, cents]) =>
    regions.map(([region, region_name, country], index) => ({
      id: `${plan}@${region}`,
      plan,
      description,
      category: "Shared vCPU",
      region,
      region_name,
      country,
      vcpus,
      memory_mib,
      disk_gb,
      arch,
      dedicated: false,
      // NOTE: Later regions cost a little more, so per-region prices are visible in tests.
      monthly_cents: cents + index * 50,
      currency,
      included_traffic_tb: traffic,
      deprecated: false,
      unavailable_after: null,
    })),
  );
}

/** Every offer each mock provider sells, cheapest plan first. */
export const MOCK_OFFERS: Readonly<Record<ProviderId, ProviderOffer[]>> = {
  hetzner: offers(
    [
      ["cx22", "CX22", 2, 4096, 40, "amd64", 451],
      ["cax11", "CAX11", 2, 4096, 40, "arm64", 449],
      ["cx32", "CX32", 4, 8192, 80, "amd64", 812],
      ["cx42", "CX42", 8, 16384, 160, "amd64", 1966],
    ],
    [
      ["fsn1", "Falkenstein", "DE"],
      ["nbg1", "Nuremberg", "DE"],
      ["hel1", "Helsinki", "FI"],
    ],
    "EUR",
    20,
  ),
  digitalocean: offers(
    [
      ["s-1vcpu-2gb", "Basic 1 vCPU / 2 GB", 1, 2048, 50, "amd64", 1200],
      ["s-2vcpu-4gb", "Basic 2 vCPU / 4 GB", 2, 4096, 80, "amd64", 2400],
      ["s-4vcpu-8gb", "Basic 4 vCPU / 8 GB", 4, 8192, 160, "amd64", 4800],
    ],
    [
      ["nyc3", "New York 3", "US"],
      ["fra1", "Frankfurt 1", "DE"],
    ],
    "USD",
    4,
  ),
  vultr: offers(
    [
      ["vc2-1c-2gb", "Cloud Compute 1 vCPU / 2 GB", 1, 2048, 55, "amd64", 1000],
      ["vc2-2c-4gb", "Cloud Compute 2 vCPU / 4 GB", 2, 4096, 80, "amd64", 2000],
    ],
    [
      ["ewr", "New Jersey", "US"],
      ["ams", "Amsterdam", "NL"],
    ],
    "USD",
    3,
  ),
  linode: offers(
    [
      ["g6-standard-1", "Linode 2 GB", 1, 2048, 50, "amd64", 1200],
      ["g6-standard-2", "Linode 4 GB", 2, 4096, 80, "amd64", 2400],
    ],
    [
      ["us-east", "Newark, NJ", "US"],
      ["eu-central", "Frankfurt, DE", "DE"],
    ],
    "USD",
    4,
  ),
};

/**
 * The mock's suggestions: the cheapest amd64 offer that fits the role, then the next
 * size up. Builders want 4 GB and 40 GB of disk.
 *
 * @param list - Offers already filtered for the request.
 * @param role - `node` or `builder`.
 * @returns Up to two suggestions, best first.
 */
export function mockRecommendations(
  list: readonly ProviderOffer[],
  role: "node" | "builder",
): { offer_id: string; reason: string }[] {
  const fits = list
    .filter((offer) => offer.arch === "amd64")
    .filter((offer) => role === "node" || (offer.memory_mib >= 4096 && offer.disk_gb >= 40))
    .sort((a, b) => a.monthly_cents - b.monthly_cents);
  const best = fits[0];
  if (!best) return [];
  const bigger = fits.find((offer) => offer.vcpus > best.vcpus);
  return [
    {
      offer_id: best.id,
      reason:
        role === "builder" ? "Cheapest plan with room to build images" : "Cheapest plan that fits",
    },
    ...(bigger ? [{ offer_id: bigger.id, reason: "More headroom for busy apps" }] : []),
  ];
}
