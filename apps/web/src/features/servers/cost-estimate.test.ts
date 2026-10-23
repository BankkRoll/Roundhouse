import { describe, expect, it } from "vitest";
import { costTotals, formatCostEstimate } from "./cost-estimate";

describe("cost estimates", () => {
  it("formats an estimate in its currency", () => {
    expect(formatCostEstimate({ monthly_cents: 451, currency: "EUR" })).toBe("≈ €4.51/mo");
    expect(formatCostEstimate({ monthly_cents: 2400, currency: "USD" })).toBe("≈ $24.00/mo");
  });

  it("totals per currency without converting, largest first, skipping unknown estimates", () => {
    expect(
      costTotals([
        { estimated_monthly_cost: { monthly_cents: 451, currency: "EUR" } },
        { estimated_monthly_cost: null },
        { estimated_monthly_cost: { monthly_cents: 2400, currency: "USD" } },
        { estimated_monthly_cost: { monthly_cents: 812, currency: "EUR" } },
      ]),
    ).toEqual([
      { currency: "USD", monthly_cents: 2400, servers: 1 },
      { currency: "EUR", monthly_cents: 1263, servers: 2 },
    ]);
    expect(costTotals([{ estimated_monthly_cost: null }])).toEqual([]);
  });
});
