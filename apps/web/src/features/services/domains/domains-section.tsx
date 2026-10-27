import {
  CUSTOM_HOSTNAME_PROBLEM_MESSAGES,
  customHostnameProblem,
  isWildcardHostname,
  normalizeHostname,
} from "@roundhouse/shared";
import {
  Badge,
  Button,
  copyText,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  SettingsSection,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@roundhouse/ui";
import {
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  GlobeIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import { ErrorState } from "../../../components/error-state";
import { errorMessage } from "../../../lib/api/client";
import type { Domain } from "../../../lib/api/deploy-types";
import type { DnsRecord } from "../../../lib/api/domains-client";
import type { Mesh } from "../../../lib/api/mesh-client";
import { formatRelativeTime } from "../../../lib/format";
import { usePermissions } from "../../../lib/permissions";
import {
  isInProgress,
  useAddDomain,
  useCheckDomain,
  useRemoveDomain,
  useServiceDomains,
} from "../../../queries/domains";
import { useMesh } from "../../../queries/mesh";
import { useServiceConfig } from "../../../queries/services";
import { useEnvironmentGate } from "../../access/environment-gate";
import { useProjectEnvironment } from "../../projects/use-project-environment";
import type { ServicePageProps } from "../service-layout";
import {
  CertificateDetails,
  certificateConcern,
  certificateSummary,
  HstsPanel,
  RoutingGuidance,
} from "./domain-details";
import { DomainStepper } from "./domain-steps";

type Tone = "success" | "warning" | "danger" | "neutral" | "info";

/** Label and badge tone of each lifecycle state. */
export const DOMAIN_STATUS_META: Record<Domain["status"], { label: string; tone: Tone }> = {
  pending_dns: { label: "Waiting for DNS", tone: "warning" },
  pending_verification: { label: "Waiting for TXT", tone: "warning" },
  issuing: { label: "Issuing certificate", tone: "info" },
  active: { label: "Active", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
};

const RECORD_STATE: Record<DnsRecord["state"], { label: string; tone: Tone }> = {
  ok: { label: "Found", tone: "success" },
  missing: { label: "Not found", tone: "warning" },
  wrong: { label: "Wrong value", tone: "danger" },
  unknown: { label: "Not checked", tone: "neutral" },
};

const PURPOSE: Record<DnsRecord["purpose"], string> = {
  routing: "Routing",
  ownership: "Ownership",
  acme_delegation: "Certificate delegation",
};

/** Copy-button label of a record, distinct when a domain needs two CNAMEs. */
function recordLabel(record: DnsRecord): string {
  return record.purpose === "acme_delegation" ? `${record.type} delegation` : record.type;
}

function copy(value: string, what: string) {
  void copyText(value).then((ok) =>
    toast({ title: ok ? `${what} copied` : "Could not copy", tone: ok ? "success" : "error" }),
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={`Copy ${label}`}
      onClick={() => copy(value, label)}
    >
      <CopyIcon />
    </Button>
  );
}

/**
 * The DNS records a custom domain needs, each with a copy button and what the last check
 * saw.
 *
 * @param props - The records.
 * @returns The table.
 */
export function DnsRecordsTable({ records }: { records: DnsRecord[] }) {
  const notes = [...new Set(records.map((r) => r.note).filter((n): n is string => Boolean(n)))];
  return (
    <div className="grid gap-2">
      <Table stack aria-label="DNS records">
        <TableHeader>
          <TableRow>
            <TableHead>Type</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Value</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((record) => (
            <TableRow key={`${record.type}:${record.name}:${record.value}`}>
              <TableCell cell="primary">
                <span className="block font-mono text-xs">{record.type}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {PURPOSE[record.purpose]}
                </span>
              </TableCell>
              <TableCell className="max-w-56">
                <span className="flex items-center gap-1">
                  <span className="truncate font-mono text-xs" title={record.name}>
                    {record.name}
                  </span>
                  <CopyButton value={record.name} label={`${recordLabel(record)} name`} />
                </span>
              </TableCell>
              <TableCell className="max-w-72">
                <span className="flex items-center gap-1">
                  <span className="truncate font-mono text-xs" title={record.value}>
                    {record.value}
                  </span>
                  <CopyButton value={record.value} label={`${recordLabel(record)} value`} />
                </span>
              </TableCell>
              <TableCell cell="action">
                <Badge tone={RECORD_STATE[record.state].tone}>
                  {RECORD_STATE[record.state].label}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {notes.map((note) => (
        <p key={note} className="text-xs text-muted-foreground">
          {note}
        </p>
      ))}
    </div>
  );
}

function DomainRow({
  domain,
  canManage,
  mesh,
  onRemove,
}: {
  domain: Domain;
  canManage: boolean;
  /** The workspace's mesh, for which servers route to replicas elsewhere; `null` when unknown. */
  mesh: Mesh | null;
  onRemove: (domain: Domain) => void;
}) {
  const check = useCheckDomain();
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const meta = DOMAIN_STATUS_META[domain.status];
  const custom = domain.type === "custom";
  const showRecords = custom && domain.status !== "active";
  const concern = certificateConcern(domain.tls);
  return (
    <li aria-label={domain.hostname} className="grid gap-3 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <GlobeIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <a
            href={domain.url}
            target="_blank"
            rel="noreferrer noopener"
            className="block truncate font-mono text-sm text-foreground outline-none hover:underline focus-visible:underline"
          >
            {domain.hostname}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {custom ? "Custom" : "Generated"} ·{" "}
            <span
              className={
                concern === "danger" ? "text-danger" : concern === "warning" ? "text-warning" : ""
              }
            >
              {certificateSummary(domain.tls)}
            </span>
            {domain.last_checked_at
              ? ` · checked ${formatRelativeTime(domain.last_checked_at)}`
              : ""}
          </p>
        </div>
        {domain.wildcard ? <Badge tone="info">Wildcard</Badge> : null}
        <Badge tone={meta.tone}>{meta.label}</Badge>
        <div className="flex items-center gap-1">
          <CopyButton value={domain.url} label="URL" />
          {custom && canManage && domain.status !== "active" ? (
            <Button
              variant="secondary"
              size="sm"
              loading={check.isPending}
              onClick={() =>
                check.mutate(domain, {
                  onSuccess: (after) =>
                    toast({
                      title:
                        after.verification_status === "verified"
                          ? `${after.hostname} verified`
                          : "Checked",
                      description: after.error ?? undefined,
                      tone: after.verification_status === "verified" ? "success" : "info",
                    }),
                  onError: (error) =>
                    toast({
                      title: "Could not check",
                      description: errorMessage(error),
                      tone: "error",
                    }),
                })
              }
            >
              {check.isPending ? null : <RefreshCwIcon />}
              Check now
            </Button>
          ) : null}
          {custom && canManage ? (
            <Button variant="ghost" size="sm" onClick={() => onRemove(domain)}>
              Remove
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((value) => !value)}
          >
            Details
            <ChevronDownIcon
              className={open ? "rotate-180 transition-transform" : "transition-transform"}
            />
          </Button>
          {domain.status === "active" ? (
            <Button asChild variant="ghost" size="icon-sm">
              <a
                href={domain.url}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`Open ${domain.hostname}`}
              >
                <ExternalLinkIcon />
              </a>
            </Button>
          ) : null}
        </div>
      </div>
      {domain.error ? (
        <p
          className={
            domain.status === "failed" ? "text-sm text-danger" : "text-sm text-muted-foreground"
          }
          role={domain.status === "failed" ? "alert" : undefined}
        >
          {domain.error}
        </p>
      ) : null}
      {custom && domain.status !== "active" ? <DomainStepper domain={domain} /> : null}
      {/* A custom domain's stepper shows the certificate error at its Certificate step. */}
      {!custom && domain.tls.status === "failed" && domain.tls.error ? (
        <p className="text-sm text-danger">{domain.tls.error}</p>
      ) : null}
      {showRecords ? (
        <>
          <RoutingGuidance domain={domain} mesh={mesh} />
          <DnsRecordsTable records={domain.records} />
        </>
      ) : null}
      {open ? (
        <section
          id={detailsId}
          aria-label={`Details of ${domain.hostname}`}
          className="grid gap-5 border-l-2 border-border/70 pl-4 md:ml-7"
        >
          {custom && domain.status === "active" ? <DomainStepper domain={domain} /> : null}
          <CertificateDetails domain={domain} />
          {showRecords ? null : <RoutingGuidance domain={domain} mesh={mesh} />}
          <HstsPanel domain={domain} canManage={canManage && custom} />
        </section>
      ) : null}
    </li>
  );
}

function AddDomainDialog({
  open,
  onOpenChange,
  serviceId,
  environmentId,
  environmentName,
  listed,
  mesh,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serviceId: string;
  environmentId: string;
  environmentName: string;
  /** The polled list, so the records step shows live states. */
  listed: readonly Domain[] | undefined;
  mesh: Mesh | null;
}) {
  const add = useAddDomain(serviceId);
  const check = useCheckDomain();
  const [hostname, setHostname] = useState("");
  const [touched, setTouched] = useState(false);
  const [added, setAdded] = useState<Domain | null>(null);
  const inputId = useId();
  const normalised = normalizeHostname(hostname);
  // NOTE: Wildcards pass here because only the API knows whether this install can issue
  // them (managed TLS with a Cloudflare zone); its 422 says why when it can't.
  const problem = normalised
    ? customHostnameProblem(normalised, { appsDomain: null }, { allowWildcard: true })
    : ("invalid" as const);
  const wildcard = normalised !== null && isWildcardHostname(normalised);
  const localError = touched && problem ? CUSTOM_HOSTNAME_PROBLEM_MESSAGES[problem] : null;
  const current = added ? (listed?.find((d) => d.id === added.id) ?? added) : null;

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setHostname("");
      setTouched(false);
      setAdded(null);
      add.reset();
      check.reset();
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (problem || !normalised) return;
    add.mutate({ environment_id: environmentId, hostname: normalised }, { onSuccess: setAdded });
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl">
        {current ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Create these DNS records</DialogTitle>
              <DialogDescription>
                Add them at your DNS provider for{" "}
                <span className="font-mono text-foreground">{current.hostname}</span>. The TXT
                record proves you own it; nothing is routed until both are found.
                {current.wildcard
                  ? " The _acme-challenge CNAME lets this install answer the wildcard certificate's DNS-01 challenges."
                  : ""}{" "}
                We check automatically for 72 hours.
              </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2" aria-live="polite">
              <Badge tone={DOMAIN_STATUS_META[current.status].tone}>
                {DOMAIN_STATUS_META[current.status].label}
              </Badge>
              {current.error ? (
                <span className="text-xs text-muted-foreground">{current.error}</span>
              ) : null}
            </div>
            <RoutingGuidance domain={current} mesh={mesh} />
            <DnsRecordsTable records={current.records} />
            {check.isError ? (
              <p role="alert" className="text-sm text-danger">
                {errorMessage(check.error)}
              </p>
            ) : null}
            <DialogFooter>
              {isInProgress(current) || current.status === "failed" ? (
                <Button
                  variant="secondary"
                  loading={check.isPending}
                  onClick={() => check.mutate(current, { onSuccess: setAdded })}
                >
                  {check.isPending ? null : <RefreshCwIcon />}
                  Check now
                </Button>
              ) : null}
              <Button variant="primary" onClick={() => close(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Add a custom domain</DialogTitle>
              <DialogDescription>
                Route a hostname you own to this service in {environmentName}. You'll get the DNS
                records to create next.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor={inputId}>Hostname</Label>
              <Input
                id={inputId}
                value={hostname}
                onChange={(event) => setHostname(event.target.value)}
                onBlur={() => setTouched(true)}
                placeholder="shop.example.com"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                className="font-mono"
                aria-invalid={localError ? true : undefined}
                aria-describedby={localError ? `${inputId}-error` : `${inputId}-hint`}
              />
              {localError ? (
                <p id={`${inputId}-error`} className="text-sm text-danger">
                  {localError}
                </p>
              ) : (
                <p id={`${inputId}-hint`} className="text-xs text-muted-foreground">
                  {wildcard
                    ? "A wildcard covers one level of subdomains. It needs a third record delegating _acme-challenge, and works only when this install issues certificates itself over DNS-01 (managed TLS with a Cloudflare zone)."
                    : "One hostname, or a wildcard such as *.example.com where this install supports them."}
                </p>
              )}
            </div>
            {add.isError ? (
              <p role="alert" className="text-sm text-danger">
                {errorMessage(add.error)}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" loading={add.isPending}>
                Add domain
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * A service's domains in the selected environment, as a settings section: the generated
 * hostname and every custom domain with its live status, the DNS records still to
 * create, "Check now", and remove. Adding opens a dialog that shows the exact records.
 *
 * @param props - Workspace, project and service ids.
 * @returns The section.
 */
export function DomainsSection({ workspaceId, projectId, serviceId }: ServicePageProps) {
  const { environment } = useProjectEnvironment(projectId);
  const domains = useServiceDomains(serviceId, environment?.id);
  const config = useServiceConfig(serviceId, environment?.id);
  const canManage = useEnvironmentGate(workspaceId, projectId, environment).can("services:manage");
  const remove = useRemoveDomain();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Domain | null>(null);
  const noPort = config.data?.networking.port === null;
  const { can } = usePermissions(workspaceId);
  const mesh = useMesh(workspaceId, can("nodes:read")).data ?? null;

  return (
    <SettingsSection
      id="domains"
      title="Domains"
      className="scroll-mt-20"
      description={
        noPort
          ? "This service has no port, so it isn't reachable over HTTP. Set one under Networking to add domains."
          : `Hostnames routed to this service${environment ? ` in ${environment.name}` : ""}. Custom domains are routed once their DNS and ownership records are found.`
      }
      actions={
        canManage && environment && !noPort ? (
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            <PlusIcon />
            Add domain
          </Button>
        ) : null
      }
    >
      {domains.isPending ? (
        <Skeleton className="my-4 h-14 rounded-lg" />
      ) : domains.isError ? (
        <div className="py-4">
          <ErrorState
            message={errorMessage(domains.error)}
            onRetry={() => void domains.refetch()}
          />
        </div>
      ) : domains.data.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          No domains yet. Turn on the generated domain under Networking, or add your own.
        </p>
      ) : (
        <ul aria-label="Domain list" className="divide-y divide-border/70">
          {domains.data.map((domain) => (
            <DomainRow
              key={domain.id}
              domain={domain}
              canManage={canManage}
              mesh={mesh}
              onRemove={setRemoving}
            />
          ))}
        </ul>
      )}
      {environment ? (
        <AddDomainDialog
          open={adding}
          onOpenChange={setAdding}
          serviceId={serviceId}
          environmentId={environment.id}
          environmentName={environment.name}
          listed={domains.data}
          mesh={mesh}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(null);
            remove.reset();
          }
        }}
        title={`Remove ${removing?.hostname ?? "domain"}?`}
        description="It stops routing to this service right away. Adding it again needs a new TXT record."
        confirmLabel="Remove domain"
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() => {
          if (!removing) return;
          remove.mutate(removing, {
            onSuccess: () => {
              toast({ title: `${removing.hostname} removed`, tone: "success" });
              setRemoving(null);
            },
          });
        }}
      />
    </SettingsSection>
  );
}
