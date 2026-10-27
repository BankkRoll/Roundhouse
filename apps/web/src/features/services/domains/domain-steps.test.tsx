import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Domain } from "../../../lib/api/deploy-types";
import { mockTls } from "../../../mocks/domains-db";
import { DomainStepper, domainSteps } from "./domain-steps";

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

type RecordState = Domain["records"][number]["state"];

function domain(
  status: Domain["status"],
  states: { routing?: RecordState; ownership?: RecordState; delegation?: RecordState } = {},
  overrides: Partial<Domain> = {},
): Domain {
  const records: Domain["records"] = [
    {
      type: "CNAME",
      name: "app.example.com",
      value: "ingress.example.com",
      purpose: "routing",
      state: states.routing ?? "ok",
      note: null,
    },
    {
      type: "TXT",
      name: "_roundhouse.app.example.com",
      value: "rh-verify=abc",
      purpose: "ownership",
      state: states.ownership ?? "ok",
      note: null,
    },
  ];
  if (states.delegation) {
    records.push({
      type: "CNAME",
      name: "_acme-challenge.app.example.com",
      value: "dom-1.acme.apps.example.com",
      purpose: "acme_delegation",
      state: states.delegation,
      note: null,
    });
  }
  return {
    id: "dom_1",
    hostname: "app.example.com",
    type: "custom",
    status,
    records,
    tls: mockTls("pending", NOW),
    last_checked_at: NOW - 2 * 60_000,
    error: null,
    ...overrides,
  } as Domain;
}

const states = (d: Domain) => domainSteps(d, NOW).map((s) => s.state);

describe("domainSteps", () => {
  it("waits at DNS with the missing routing record and when it was checked", () => {
    const steps = domainSteps(
      domain("pending_dns", { routing: "missing", ownership: "missing" }),
      NOW,
    );
    expect(steps.map((s) => s.state)).toEqual(["current", "pending", "pending", "pending"]);
    expect(steps[0]!.detail).toMatch(
      /^CNAME app\.example\.com not found; last checked 2 ?m\w* ago$/,
    );
  });

  it("waits at Ownership with the exact TXT name", () => {
    const steps = domainSteps(domain("pending_verification", { ownership: "missing" }), NOW);
    expect(steps.map((s) => s.state)).toEqual(["done", "current", "pending", "pending"]);
    expect(steps[1]!.detail).toMatch(/^TXT _roundhouse\.app\.example\.com not found; last checked/);
  });

  it("names a wrong ownership value and a wildcard's missing delegation", () => {
    expect(
      domainSteps(domain("pending_verification", { ownership: "wrong" }), NOW)[1]!.detail,
    ).toMatch(/^TXT _roundhouse\.app\.example\.com has another value/);
    expect(domainSteps(domain("pending_dns", { delegation: "missing" }), NOW)[0]!.detail).toMatch(
      /^CNAME _acme-challenge\.app\.example\.com not found/,
    );
  });

  it("treats one matching address among several routing records as enough", () => {
    const d = domain("pending_verification", { ownership: "missing" });
    d.records.unshift({ ...d.records[0]!, type: "A", value: "203.0.113.9", state: "wrong" });
    expect(domainSteps(d, NOW)[1]!.detail).toMatch(/^TXT /);
    expect(domainSteps(d, NOW)[0]!.state).toBe("done");
  });

  it("waits at Certificate while issuing and fails there with the certificate's error", () => {
    expect(states(domain("issuing"))).toEqual(["done", "done", "current", "pending"]);
    const failed = domainSteps(
      domain("issuing", {}, { tls: { ...mockTls("failed", NOW), error: "rate limited" } }),
      NOW,
    );
    expect(failed.map((s) => s.state)).toEqual(["done", "done", "failed", "pending"]);
    expect(failed[2]!.detail).toBe("rate limited");
  });

  it("fails at the record still wrong after 72 hours", () => {
    expect(states(domain("failed", { routing: "missing" }))).toEqual([
      "failed",
      "pending",
      "pending",
      "pending",
    ]);
    expect(states(domain("failed", { ownership: "wrong" }))).toEqual([
      "done",
      "failed",
      "pending",
      "pending",
    ]);
  });

  it("is all done once active", () => {
    const steps = domainSteps(domain("active"), NOW);
    expect(steps.map((s) => s.state)).toEqual(["done", "done", "done", "done"]);
    expect(steps.every((s) => s.detail === null)).toBe(true);
  });
});

describe("DomainStepper", () => {
  it("is an ordered list marking the current step and announcing every state", () => {
    render(<DomainStepper domain={domain("pending_verification", { ownership: "missing" })} />);
    const list = screen.getByRole("list", { name: "Progress of app.example.com" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((i) => i.textContent)).toEqual([
      "DNS (done)",
      "Ownership (in progress)",
      "Certificate (not started)",
      "Active (not started)",
    ]);
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(items.filter((i) => i.hasAttribute("aria-current"))).toHaveLength(1);
    expect(screen.getByText(/TXT _roundhouse\.app\.example\.com not found/)).toHaveTextContent(
      /^Ownership: TXT/,
    );
  });

  it("marks a failed step as the current one and says it failed", () => {
    render(<DomainStepper domain={domain("failed", { routing: "missing" })} />);
    const first = screen.getAllByRole("listitem")[0]!;
    expect(first).toHaveAttribute("aria-current", "step");
    expect(first).toHaveTextContent("DNS (failed)");
  });

  it("has no current step and no reason once active", () => {
    render(<DomainStepper domain={domain("active")} />);
    const items = screen.getAllByRole("listitem");
    expect(items.some((i) => i.hasAttribute("aria-current"))).toBe(false);
    expect(items.map((i) => i.textContent)).toEqual([
      "DNS (done)",
      "Ownership (done)",
      "Certificate (done)",
      "Active (done)",
    ]);
  });
});
