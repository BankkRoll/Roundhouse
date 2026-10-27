/**
 * The status stepper of a custom domain (ADR 0009, "Dashboard"): DNS → Ownership →
 * Certificate → Active, with the exact reason at the step that is waiting or failed, such
 * as "TXT _roundhouse.app.example.com not found; last checked 2 min ago".
 *
 * @module
 */
import { cn } from "@roundhouse/ui";
import { CircleCheckIcon, CircleDashedIcon, CircleDotIcon, CircleXIcon } from "lucide-react";
import type { Domain } from "../../../lib/api/deploy-types";
import type { DnsRecord } from "../../../lib/api/domains-client";
import { formatRelativeTime } from "../../../lib/format";

/** Where one step stands. */
export type DomainStepState = "done" | "current" | "failed" | "pending";

/** One step of the stepper. */
export interface DomainStep {
  label: "DNS" | "Ownership" | "Certificate" | "Active";
  state: DomainStepState;
  /** Why the step is waiting or failed; only on the current or failed step. */
  detail: string | null;
}

const LABELS = ["DNS", "Ownership", "Certificate", "Active"] as const;

function describeRecord(record: DnsRecord): string | null {
  if (record.state === "missing") return `${record.type} ${record.name} not found`;
  if (record.state === "wrong") {
    return record.purpose === "ownership"
      ? `TXT ${record.name} has another value`
      : `${record.name} doesn't point to ${record.value}`;
  }
  if (record.state === "unknown") return `${record.type} ${record.name} not checked yet`;
  return null;
}

/** The first problem among records of some purposes, with when DNS was last looked at. */
function recordProblem(
  domain: Domain,
  purposes: DnsRecord["purpose"][],
  now: number,
): string | null {
  const records = domain.records.filter((r) => purposes.includes(r.purpose));
  // Several A/AAAA records are alternatives for one routing answer: one OK is enough.
  const routing = records.filter((r) => r.purpose === "routing");
  if (routing.some((r) => r.state === "ok")) {
    records.splice(0, records.length, ...records.filter((r) => r.purpose !== "routing"));
  }
  const problem = records.map(describeRecord).find((p): p is string => p !== null) ?? null;
  if (!problem) return null;
  return domain.last_checked_at
    ? `${problem}; last checked ${formatRelativeTime(domain.last_checked_at, now)}`
    : problem;
}

/**
 * Where a custom domain stands on its way to being served.
 *
 * - `pending_dns` waits at DNS (the routing record, and a wildcard's delegation);
 * - `pending_verification` waits at Ownership (the `_roundhouse` TXT);
 * - `issuing` waits at Certificate, failed when the certificate failed;
 * - `failed` (72 hours without the records) fails at whichever record is still wrong;
 * - `active` has every step done.
 *
 * @param domain - A custom domain.
 * @param now - Current time, for "last checked".
 * @returns The four steps in order.
 */
export function domainSteps(domain: Domain, now = Date.now()): DomainStep[] {
  const dns = recordProblem(domain, ["routing", "acme_delegation"], now);
  const ownership = recordProblem(domain, ["ownership"], now);
  let current: number;
  let failed = false;
  let detail: string | null = null;
  switch (domain.status) {
    case "pending_dns":
      current = 0;
      detail = dns ?? "Waiting for the routing record.";
      break;
    case "pending_verification":
      current = 1;
      detail = ownership ?? "Waiting for the ownership TXT record.";
      break;
    case "issuing":
      current = 2;
      failed = domain.tls.status === "failed";
      detail =
        domain.tls.error ??
        (failed ? "Issuance failed; it is retried." : "Waiting for every server to load it.");
      break;
    case "failed":
      current = dns ? 0 : 1;
      failed = true;
      detail = (dns ?? ownership ?? domain.error) || "Records not found within 72 hours.";
      break;
    default:
      current = LABELS.length;
  }
  return LABELS.map((label, index) => ({
    label,
    state:
      index < current ? "done" : index === current ? (failed ? "failed" : "current") : "pending",
    detail: index === current ? detail : null,
  }));
}

const STATE_TEXT: Record<DomainStepState, string> = {
  done: "done",
  current: "in progress",
  failed: "failed",
  pending: "not started",
};

/**
 * The stepper for a custom domain: an ordered list whose current step carries
 * `aria-current="step"`, each step's state in words for screen readers, and the reason
 * below the waiting or failed step.
 *
 * @param props - The domain.
 * @returns The stepper.
 */
export function DomainStepper({ domain }: { domain: Domain }) {
  const steps = domainSteps(domain);
  const active = steps.find((s) => s.detail !== null);
  return (
    <div className="grid gap-1.5">
      <ol
        aria-label={`Progress of ${domain.hostname}`}
        className="flex flex-wrap items-center gap-x-2 gap-y-1"
      >
        {steps.map((step, index) => (
          <li
            key={step.label}
            aria-current={step.state === "current" || step.state === "failed" ? "step" : undefined}
            data-state={step.state}
            className="flex items-center gap-1.5 text-xs"
          >
            {index > 0 ? <span aria-hidden="true" className="h-px w-4 bg-border" /> : null}
            {step.state === "done" ? (
              <CircleCheckIcon className="size-3.5 text-success" aria-hidden="true" />
            ) : step.state === "failed" ? (
              <CircleXIcon className="size-3.5 text-danger" aria-hidden="true" />
            ) : step.state === "current" ? (
              <CircleDotIcon className="size-3.5 text-accent-text" aria-hidden="true" />
            ) : (
              <CircleDashedIcon className="size-3.5 text-subtle-foreground" aria-hidden="true" />
            )}
            <span
              className={cn(
                step.state === "pending" ? "text-muted-foreground" : "text-foreground",
                step.state === "failed" && "text-danger",
              )}
            >
              {step.label}
              <span className="sr-only"> ({STATE_TEXT[step.state]})</span>
            </span>
          </li>
        ))}
      </ol>
      {active?.detail ? (
        <p
          className={cn(
            "text-xs",
            active.state === "failed" ? "text-danger" : "text-muted-foreground",
          )}
        >
          <span className="sr-only">{active.label}: </span>
          {active.detail}
        </p>
      ) : null}
    </div>
  );
}
