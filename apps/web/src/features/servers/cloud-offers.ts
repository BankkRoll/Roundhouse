/**
 * Pure helpers for the cloud provider flow: grouping a provider's offers into plans with
 * the regions each is sold in, picking the recommended default, formatting prices and
 * sizes, validating node names the way the API does, and describing a provisioning run's
 * progress.
 *
 * @module
 */
import type {
  NodeProvision,
  OfferRecommendation,
  ProviderOffer,
} from "../../lib/api/providers-types";

/** One plan and every region it can be ordered in, cheapest region first. */
export interface OfferPlan {
  plan: string;
  description: string;
  vcpus: number;
  memoryMib: number;
  diskGb: number;
  arch: ProviderOffer["arch"];
  dedicated: boolean;
  /** The plan's offers, one per region. */
  offers: ProviderOffer[];
  /** The cheapest of {@link OfferPlan.offers}, for "from" prices. */
  cheapest: ProviderOffer;
  /** Why the plan is suggested, when one of its offers is. */
  recommendation: string | null;
}

/**
 * Groups offers by plan, ordered by recommendation first, then cheapest monthly price.
 *
 * @param offers - Offers from the API.
 * @param recommendations - The API's suggestions, best first.
 * @returns One entry per plan.
 */
export function groupOffersByPlan(
  offers: readonly ProviderOffer[],
  recommendations: readonly OfferRecommendation[],
): OfferPlan[] {
  const reasons = new Map<string, { reason: string; rank: number }>();
  recommendations.forEach((entry, rank) => {
    const offer = offers.find((candidate) => candidate.id === entry.offer_id);
    if (offer && !reasons.has(offer.plan)) reasons.set(offer.plan, { reason: entry.reason, rank });
  });

  const plans = new Map<string, ProviderOffer[]>();
  for (const offer of offers) {
    const list = plans.get(offer.plan);
    if (list) list.push(offer);
    else plans.set(offer.plan, [offer]);
  }

  return [...plans.values()]
    .map((list): OfferPlan => {
      const sorted = [...list].sort((a, b) => a.monthly_cents - b.monthly_cents);
      const first = sorted[0] as ProviderOffer;
      return {
        plan: first.plan,
        description: first.description,
        vcpus: first.vcpus,
        memoryMib: first.memory_mib,
        diskGb: first.disk_gb,
        arch: first.arch,
        dedicated: first.dedicated,
        offers: sorted,
        cheapest: first,
        recommendation: reasons.get(first.plan)?.reason ?? null,
      };
    })
    .sort((a, b) => {
      const rankA = reasons.get(a.plan)?.rank ?? Number.POSITIVE_INFINITY;
      const rankB = reasons.get(b.plan)?.rank ?? Number.POSITIVE_INFINITY;
      return rankA - rankB || a.cheapest.monthly_cents - b.cheapest.monthly_cents;
    });
}

/**
 * The offer to start on: the first recommendation that is still listed, else the
 * cheapest offer.
 *
 * @param offers - Offers from the API.
 * @param recommendations - The API's suggestions, best first.
 * @returns The offer, or `undefined` when there are none.
 */
export function defaultOffer(
  offers: readonly ProviderOffer[],
  recommendations: readonly OfferRecommendation[],
): ProviderOffer | undefined {
  for (const entry of recommendations) {
    const offer = offers.find((candidate) => candidate.id === entry.offer_id);
    if (offer) return offer;
  }
  return [...offers].sort((a, b) => a.monthly_cents - b.monthly_cents)[0];
}

/**
 * A monthly price in the offer's currency.
 *
 * @param cents - Price in the currency's minor unit.
 * @param currency - ISO 4217 code, e.g. `EUR`.
 * @returns E.g. `€4.51/mo`.
 * @example
 * formatMonthlyPrice(451, "EUR"); // "€4.51/mo"
 */
export function formatMonthlyPrice(cents: number, currency: string): string {
  let amount: string;
  try {
    amount = new Intl.NumberFormat("en", { style: "currency", currency }).format(cents / 100);
  } catch {
    // NOTE: An unknown currency code makes Intl throw; show the code rather than nothing.
    amount = `${(cents / 100).toFixed(2)} ${currency}`;
  }
  return `${amount}/mo`;
}

/**
 * Memory in the units providers advertise.
 *
 * @param mib - Memory in MiB.
 * @returns E.g. `4 GB`, `1.5 GB` or `512 MB`.
 */
export function formatMemoryMib(mib: number): string {
  if (mib < 1024) return `${mib} MB`;
  const gb = mib / 1024;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

/**
 * One-line size of a plan, e.g. `2 vCPU · 4 GB · 40 GB disk`.
 *
 * @param plan - The plan's size.
 * @returns The summary.
 */
export function formatPlanSize(plan: Pick<OfferPlan, "vcpus" | "memoryMib" | "diskGb">): string {
  return `${plan.vcpus} vCPU · ${formatMemoryMib(plan.memoryMib)} · ${plan.diskGb} GB disk`;
}

/** Node names the API accepts: a lowercase DNS label. */
export const NODE_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Validates a node name with the API's rule.
 *
 * @param name - Proposed name.
 * @returns An error message, or `null` when valid.
 */
export function nodeNameError(name: string): string | null {
  if (name === "") return "Enter a name.";
  return NODE_NAME_PATTERN.test(name)
    ? null
    : "Use 1-63 lowercase letters, digits or hyphens, not starting or ending with a hyphen.";
}

const STEP_LABELS: Record<string, string> = {
  validate_token: "Checking the API token",
  check_existing: "Checking for an existing server",
  check_offer: "Checking the plan is available",
  ensure_firewall: "Setting up the firewall",
  ensure_ssh_key: "Setting up SSH access",
  create_server: "Creating the server",
  wait_until_running: "Waiting for the server to start",
  done: "Server running; waiting for the agent to join",
};

/**
 * Human text for an adapter step.
 *
 * @param step - Step id, e.g. `create_server`.
 * @returns The label; unknown steps get their id with spaces.
 */
export function provisionStepLabel(step: string | null): string | null {
  if (step === null) return null;
  return STEP_LABELS[step] ?? step.replace(/_/g, " ");
}

/** The three stages a provisioning run shows. */
export const PROVISION_STAGES = ["Creating server", "Booting", "Joined"] as const;

/** Where a run is among {@link PROVISION_STAGES}. */
export interface ProvisionProgress {
  /** Index of the current stage; `PROVISION_STAGES.length` once joined. */
  current: number;
  /** Whether the run stopped at {@link ProvisionProgress.current}. */
  failed: boolean;
}

/**
 * Maps a run's status onto the stepper.
 *
 * @param provision - The run.
 * @returns The current stage and whether it failed there.
 */
export function provisionProgress(
  provision: Pick<NodeProvision, "status" | "server_id" | "step">,
): ProvisionProgress {
  switch (provision.status) {
    case "queued":
    case "creating":
      return { current: 0, failed: false };
    case "booting":
      return { current: 1, failed: false };
    case "joined":
      return { current: PROVISION_STAGES.length, failed: false };
    default: {
      // NOTE: A run that already had a server (or was waiting on it) failed while
      // booting; otherwise it never got past creating.
      const reachedBoot = provision.server_id !== null || provision.step === "wait_until_running";
      return { current: reachedBoot ? 1 : 0, failed: true };
    }
  }
}

/**
 * Runs to list beside the servers: still in flight, or failed in a way that may have left
 * a billing server behind. Runs whose node is already listed are skipped.
 *
 * @param provisions - Recent runs.
 * @param nodes - The listed nodes.
 * @returns The runs to show, in the order given.
 */
export function pendingProvisions(
  provisions: readonly NodeProvision[],
  nodes: readonly { id: string; name: string }[],
): NodeProvision[] {
  return provisions.filter(
    (run) =>
      (run.status === "queued" ||
        run.status === "creating" ||
        run.status === "booting" ||
        run.status === "cleanup_failed") &&
      !nodes.some((node) => node.id === run.node_id || node.name === run.name),
  );
}
