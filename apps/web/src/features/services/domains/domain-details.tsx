/**
 * The parts of a domain row beyond its status: the certificate serving it (expiry,
 * issuer, per-server state), which servers answer for it, and its HSTS policy.
 *
 * @module
 */
import {
  HSTS_PRELOAD_MIN_MAX_AGE_S,
  hstsHeaderValue,
  hstsProblems,
  hstsWarnings,
  MAX_HSTS_MAX_AGE_S,
} from "@roundhouse/shared";
import { Badge, Button, Checkbox, Input, Select, SettingsRow, toast } from "@roundhouse/ui";
import { Switch } from "@roundhouse/ui/controls";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import { errorMessage, isApiError } from "../../../lib/api/client";
import type { Domain } from "../../../lib/api/deploy-types";
import type { DomainHsts, DomainTls } from "../../../lib/api/domains-client";
import { formatTimestamp } from "../../../lib/format";
import { useUpdateDomain } from "../../../queries/domains";

type Tone = "success" | "warning" | "danger" | "neutral" | "info";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A certificate this close to expiry is shown as a warning: renewal should be done by now. */
export const CERTIFICATE_EXPIRY_WARNING_MS = 14 * DAY;

const TLS_STATUS: Record<DomainTls["status"], { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "warning" },
  issued: { label: "Issued", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  disabled: { label: "TLS off", tone: "neutral" },
};

const NODE_STATE: Record<DomainTls["nodes"][number]["state"], { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "warning" },
  issued: { label: "Loaded", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

function plural(n: number, unit: string) {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/**
 * How far away a future (or past) instant is, in words.
 *
 * @param timestamp - Unix ms.
 * @param now - Current unix ms.
 * @returns `"in 54 days"`, `"in 5 hours"`, `"expired 2 days ago"`.
 */
export function formatExpiry(timestamp: number, now = Date.now()): string {
  const left = timestamp - now;
  const span = Math.abs(left);
  const words =
    span >= 2 * DAY
      ? plural(Math.floor(span / DAY), "day")
      : span >= HOUR
        ? plural(Math.floor(span / HOUR), "hour")
        : plural(Math.max(1, Math.floor(span / 60_000)), "minute");
  return left >= 0 ? `in ${words}` : `expired ${words} ago`;
}

/**
 * How urgent a domain's certificate looks.
 *
 * @param tls - The certificate state.
 * @param now - Current unix ms.
 * @returns `danger` when issuance failed or it expired, `warning` within
 *   {@link CERTIFICATE_EXPIRY_WARNING_MS} of expiry, otherwise `null`.
 */
export function certificateConcern(tls: DomainTls, now = Date.now()): "danger" | "warning" | null {
  if (tls.status === "failed") return "danger";
  if (tls.status !== "issued" || tls.not_after === null) return null;
  if (tls.not_after <= now) return "danger";
  return tls.not_after - now < CERTIFICATE_EXPIRY_WARNING_MS ? "warning" : null;
}

/**
 * The certificate in a few words, for the domain's summary line.
 *
 * @param tls - The certificate state.
 * @param now - Current unix ms.
 * @returns E.g. `"Certificate expires in 54 days"`.
 */
export function certificateSummary(tls: DomainTls, now = Date.now()): string {
  switch (tls.status) {
    case "disabled":
      return "TLS off";
    case "pending":
      return "Certificate pending";
    case "failed":
      return "Certificate failed";
    case "issued":
      if (tls.not_after === null) return "Certificate issued";
      return tls.not_after <= now
        ? `Certificate ${formatExpiry(tls.not_after, now)}`
        : `Certificate expires ${formatExpiry(tls.not_after, now)}`;
  }
}

const date = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 py-1.5 text-sm">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </div>
  );
}

/**
 * The certificate serving a domain: status, issuer, validity and, when more than one
 * server serves it, each server's state.
 *
 * @param props - The domain.
 * @returns The facts.
 */
export function CertificateDetails({ domain }: { domain: Domain }) {
  const { tls } = domain;
  const now = Date.now();
  const concern = certificateConcern(tls, now);
  const meta = TLS_STATUS[tls.status];
  return (
    <div className="grid gap-1">
      <h3 className="text-sm font-medium text-foreground">Certificate</h3>
      <dl aria-label="Certificate" className="divide-y divide-border/50">
        <Fact term="Status">
          <Badge tone={meta.tone}>{meta.label}</Badge>
        </Fact>
        {tls.issuer ? <Fact term="Issuer">{tls.issuer}</Fact> : null}
        {tls.not_after !== null ? (
          <Fact term={tls.not_after <= now ? "Expired" : "Expires"}>
            <span
              title={formatTimestamp(tls.not_after)}
              className={
                concern === "danger" ? "text-danger" : concern === "warning" ? "text-warning" : ""
              }
            >
              {date(tls.not_after)} ({formatExpiry(tls.not_after, now)})
            </span>
          </Fact>
        ) : null}
        {tls.not_before !== null ? (
          <Fact term="Valid from">
            <span title={formatTimestamp(tls.not_before)}>{date(tls.not_before)}</span>
          </Fact>
        ) : null}
      </dl>
      {tls.status === "issued" ? (
        <p className="text-xs text-muted-foreground">
          Renews automatically well before it expires; nothing to do here.
          {concern === "warning"
            ? " Renewal should have finished by now, so check the servers' logs if this stays."
            : ""}
        </p>
      ) : tls.status === "pending" ? (
        <p className="text-xs text-muted-foreground">
          Issued once the domain is verified and a server serving it completes the ACME challenge.
        </p>
      ) : tls.status === "disabled" ? (
        <p className="text-xs text-muted-foreground">
          This install serves plain HTTP (TLS mode off).
        </p>
      ) : null}
      {tls.error ? (
        <p role="alert" className="text-sm text-danger">
          {tls.error}
        </p>
      ) : null}
      {tls.nodes.length > 1 ? (
        <ul aria-label="Certificate on each server" className="mt-1 grid gap-1">
          {tls.nodes.map((node) => (
            <li key={node.node_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="font-mono text-xs text-foreground">{node.name}</span>
              <Badge tone={NODE_STATE[node.state].tone}>{NODE_STATE[node.state].label}</Badge>
              {node.error ? <span className="text-xs text-danger">{node.error}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Which of the workspace's servers answer for a domain, and what that means for its DNS.
 * Until servers route to each other's replicas, only those running the service do.
 *
 * @param props - The domain.
 * @returns The guidance.
 */
export function RoutingGuidance({ domain }: { domain: Domain }) {
  const nodes = domain.routing_nodes;
  const serving = nodes.filter((node) => node.serves);
  let message: string;
  if (nodes.length === 0) {
    message = "This workspace has no servers taking traffic yet. Add one before pointing DNS here.";
  } else if (serving.length === 0) {
    message =
      "Not deployed yet: no server runs this service, so nothing answers for this hostname until a deployment is live.";
  } else if (serving.length < nodes.length) {
    message =
      `Runs on ${serving.length} of ${nodes.length} servers. Until servers route to each other's ` +
      "replicas, only these answer for this hostname, so DNS must point at them. Update the " +
      "records if the service moves to other servers.";
  } else {
    message =
      nodes.length === 1
        ? "Served by this workspace's server."
        : `Served by all ${nodes.length} of this workspace's servers.`;
  }
  return (
    <div className="grid gap-1.5">
      <h3 className="text-sm font-medium text-foreground">Servers</h3>
      <p
        className={serving.length === 0 ? "text-sm text-warning" : "text-sm text-muted-foreground"}
      >
        {message}
      </p>
      {nodes.length > 0 ? (
        <ul aria-label="Servers" className="grid gap-1">
          {nodes.map((node) => (
            <li key={node.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="font-mono text-xs text-foreground">{node.name}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {node.public_ip ?? "no public IP"}
              </span>
              <Badge tone={node.serves ? "success" : "neutral"}>
                {node.serves ? "Serves" : "Not running here"}
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

const MAX_AGE_PRESETS = [
  { label: "1 day", value: 86_400 },
  { label: "1 week", value: 604_800 },
  { label: "6 months", value: 15_768_000 },
  { label: "1 year", value: HSTS_PRELOAD_MIN_MAX_AGE_S },
  { label: "2 years", value: MAX_HSTS_MAX_AGE_S },
] as const;

const isPreset = (seconds: number) => MAX_AGE_PRESETS.some((p) => p.value === seconds);

function HeaderPreview({ hsts }: { hsts: DomainHsts }) {
  return hsts.enabled ? (
    <p className="text-xs text-muted-foreground">
      Sent over HTTPS as{" "}
      <code className="font-mono text-foreground">
        Strict-Transport-Security: {hstsHeaderValue(hsts)}
      </code>
    </p>
  ) : (
    <p className="text-xs text-muted-foreground">No Strict-Transport-Security header is sent.</p>
  );
}

function HstsForm({ domain, canManage }: { domain: Domain; canManage: boolean }) {
  const update = useUpdateDomain();
  const saved = domain.hsts;
  const [draft, setDraft] = useState<DomainHsts>(saved);
  const [custom, setCustom] = useState(!isPreset(saved.max_age));
  const [seconds, setSeconds] = useState(String(saved.max_age));
  const [confirming, setConfirming] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const id = useId();
  const trimmed = seconds.trim();
  const policy: DomainHsts = {
    ...draft,
    max_age: custom ? (/^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN) : draft.max_age,
  };
  const problems = hstsProblems(policy, domain.hostname, domain.apex);
  const warnings = problems.length ? [] : hstsWarnings(policy);
  const dirty =
    policy.enabled !== saved.enabled ||
    policy.max_age !== saved.max_age ||
    policy.include_subdomains !== saved.include_subdomains ||
    policy.preload !== saved.preload;
  const set = (patch: Partial<DomainHsts>) => setDraft((previous) => ({ ...previous, ...patch }));

  function reset() {
    setDraft(saved);
    setCustom(!isPreset(saved.max_age));
    setSeconds(String(saved.max_age));
    setErrors([]);
  }

  function send(confirmPreload?: string) {
    setErrors([]);
    update.mutate(
      {
        domain,
        body: {
          hsts: policy,
          ...(confirmPreload ? { confirm_preload: confirmPreload } : {}),
        },
      },
      {
        onSuccess: () => {
          setConfirming(false);
          toast({ title: `HSTS saved for ${domain.hostname}`, tone: "success" });
        },
        onError: (cause) => {
          const details = isApiError(cause) ? cause.details.map((d) => d.message) : [];
          setErrors(details.length ? details : [errorMessage(cause)]);
        },
      },
    );
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!dirty || problems.length) return;
    if (policy.preload && !saved.preload) setConfirming(true);
    else send();
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label={`HSTS for ${domain.hostname}`}>
      <fieldset disabled={!canManage} className="divide-y divide-border/50">
        <SettingsRow
          label="Send HSTS"
          description="Tells browsers to use HTTPS only for this hostname."
          htmlFor={`${id}-enabled`}
          control="switch"
          className="py-2.5"
        >
          <Switch
            id={`${id}-enabled`}
            checked={draft.enabled}
            onCheckedChange={(enabled) => set({ enabled })}
            aria-describedby={`${id}-enabled-description`}
          />
        </SettingsRow>
        <SettingsRow
          label="max-age"
          description="How long browsers remember the policy."
          htmlFor={`${id}-max-age`}
          className="py-2.5"
        >
          <div className="flex flex-wrap gap-2">
            <Select
              id={`${id}-max-age`}
              value={custom ? "custom" : String(draft.max_age)}
              aria-describedby={`${id}-max-age-description`}
              onChange={(event) => {
                if (event.target.value === "custom") {
                  setCustom(true);
                  setSeconds(String(draft.max_age));
                } else {
                  setCustom(false);
                  set({ max_age: Number(event.target.value) });
                }
              }}
              className="w-auto"
            >
              {MAX_AGE_PRESETS.map((preset) => (
                <option key={preset.value} value={preset.value}>
                  {preset.label}
                </option>
              ))}
              <option value="custom">Custom</option>
            </Select>
            {custom ? (
              <Input
                aria-label="max-age in seconds"
                inputMode="numeric"
                value={seconds}
                onChange={(event) => setSeconds(event.target.value)}
                className="w-36 font-mono tabular-nums"
              />
            ) : null}
          </div>
        </SettingsRow>
        <div className="grid gap-2 py-2.5">
          <label
            htmlFor={`${id}-subdomains`}
            className="flex items-start gap-2 text-sm text-foreground"
          >
            <Checkbox
              id={`${id}-subdomains`}
              className="mt-0.5"
              checked={draft.include_subdomains}
              onChange={(event) => set({ include_subdomains: event.target.checked })}
            />
            <span>
              includeSubDomains
              <span className="block text-[13px] text-muted-foreground">
                Every subdomain must serve HTTPS too.
              </span>
            </span>
          </label>
          <label
            htmlFor={`${id}-preload`}
            className="flex items-start gap-2 text-sm text-foreground"
          >
            <Checkbox
              id={`${id}-preload`}
              className="mt-0.5"
              checked={draft.preload}
              onChange={(event) => set({ preload: event.target.checked })}
            />
            <span>
              preload
              <span className="block text-[13px] text-muted-foreground">
                Allows submitting the domain to browsers' built-in HTTPS-only lists. Apex domains
                only.
              </span>
            </span>
          </label>
        </div>
      </fieldset>
      <div className="grid gap-2 pt-2">
        {problems.length ? null : <HeaderPreview hsts={policy} />}
        {problems.length ? (
          <ul aria-label="HSTS problems" className="grid gap-0.5 text-sm text-danger">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
        {dirty && warnings.length ? (
          <ul aria-label="HSTS warnings" className="grid gap-0.5 text-sm text-warning">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}
        {errors.length && !confirming ? (
          <div role="alert" className="grid gap-0.5 text-sm text-danger">
            {errors.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
        ) : null}
        {canManage ? (
          <div className="flex justify-end gap-2">
            {dirty ? (
              <Button type="button" variant="ghost" size="sm" onClick={reset}>
                Discard
              </Button>
            ) : null}
            <Button
              type="submit"
              variant={dirty ? "primary" : "secondary"}
              size="sm"
              disabled={!dirty || problems.length > 0}
              loading={update.isPending && !confirming}
            >
              Save HSTS
            </Button>
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) {
            setErrors([]);
            update.reset();
          }
        }}
        title={`Allow preloading ${domain.hostname}?`}
        description="Browsers that ship the preload list will refuse plain HTTP on this domain and every subdomain. Removal from the list takes months after you ask, so this is effectively irreversible."
        confirmLabel="Turn on preload"
        confirmText={domain.hostname}
        pending={update.isPending}
        error={errors.length ? errors.join(" ") : null}
        onConfirm={() => send(domain.hostname)}
      />
    </form>
  );
}

/**
 * A domain's HSTS policy. Custom domains can change it; generated ones always send the
 * default, shown read-only.
 *
 * @param props - The domain and whether the user may change it.
 * @returns The panel.
 */
export function HstsPanel({ domain, canManage }: { domain: Domain; canManage: boolean }) {
  return (
    <div className="grid gap-1">
      <h3 className="text-sm font-medium text-foreground">HSTS</h3>
      {domain.type === "custom" ? (
        <HstsForm
          key={`${domain.hsts.enabled}:${domain.hsts.max_age}:${domain.hsts.include_subdomains}:${domain.hsts.preload}`}
          domain={domain}
          canManage={canManage}
        />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">Generated domains use the default policy.</p>
          <HeaderPreview hsts={domain.hsts} />
        </>
      )}
    </div>
  );
}
