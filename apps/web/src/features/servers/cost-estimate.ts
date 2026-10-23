/**
 * Monthly cost estimates for servers Roundhouse provisioned: the plan's price in the
 * provider's catalogue when the server was created. Labelled as estimates everywhere,
 * since traffic, backups, taxes and price changes are not included.
 *
 * @module
 */
import type { Node } from "../../lib/api/types";
import { formatMonthlyPrice } from "./cloud-offers";

/** A node's recorded monthly price. */
export type CostEstimate = NonNullable<Node["estimated_monthly_cost"]>;

/** Explains where the figures come from, for tooltips and fine print. */
export const COST_ESTIMATE_NOTE =
  "Estimated from the provider's catalogue price when the server was created. Traffic, backups, taxes and price changes aren't included; your provider's invoice is what counts.";

/**
 * A short estimate label.
 *
 * @param cost - The recorded price.
 * @returns E.g. `≈ €4.51/mo`.
 * @example
 * formatCostEstimate({ monthly_cents: 451, currency: "EUR" }); // "≈ €4.51/mo"
 */
export function formatCostEstimate(cost: CostEstimate): string {
  return `≈ ${formatMonthlyPrice(cost.monthly_cents, cost.currency)}`;
}

/** Sum of the estimates in one currency. */
export interface CostTotal {
  currency: string;
  monthly_cents: number;
  /** How many servers the total covers. */
  servers: number;
}

/**
 * Adds up the provider-managed nodes' estimates per currency, largest total first.
 * Currencies are never converted into one another.
 *
 * @param nodes - Listed nodes.
 * @returns One total per currency; empty when no node has an estimate.
 */
export function costTotals(nodes: readonly Pick<Node, "estimated_monthly_cost">[]): CostTotal[] {
  const totals = new Map<string, CostTotal>();
  for (const node of nodes) {
    const cost = node.estimated_monthly_cost;
    if (!cost) continue;
    const total = totals.get(cost.currency) ?? {
      currency: cost.currency,
      monthly_cents: 0,
      servers: 0,
    };
    total.monthly_cents += cost.monthly_cents;
    total.servers += 1;
    totals.set(cost.currency, total);
  }
  return [...totals.values()].sort((a, b) => b.monthly_cents - a.monthly_cents);
}
