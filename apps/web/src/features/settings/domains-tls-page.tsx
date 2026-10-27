/**
 * Settings → Domains & TLS (ADR 0009): how the install gets certificates and what custom
 * domains point at.
 *
 * - **Ingress**: the apps domain and the TLS mode, saved through
 *   `PATCH /v1/instance/settings`. `managed` is offered only when the API says its
 *   prerequisites are met; `acme` warns when more than one server takes traffic.
 * - **Custom domains**: the ingress hostname customers CNAME to.
 * - **Certificate authority**: the ACME directory and contact address.
 * - **Cloudflare DNS**: the zone and write-only token behind DNS-01, which the apps
 *   wildcard and wildcard custom domains need.
 * - **Certificates**: what the control plane issued, with expiry, renewal and delivery.
 *
 * Everything but the TLS mode goes through `PUT /v1/instance/domains`, which needs a
 * fresh session; the API client asks for the password and retries.
 *
 * @module
 */
import { LOCAL_APPS_DOMAIN, normalizeHostname, type TlsMode } from "@roundhouse/shared";
import {
  Badge,
  Button,
  EmptyState,
  SaveBar,
  Select,
  SettingsRow,
  SettingsSection,
  SettingsStack,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@roundhouse/ui";
import { ShieldIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorState } from "../../components/error-state";
import { SettingsField } from "../../components/settings-field";
import { errorMessage, isApiError } from "../../lib/api/client";
import type { Certificate, InstanceDomainSettings } from "../../lib/api/tls-client";
import { formatRelativeTime, formatTimestamp, formatUntil } from "../../lib/format";
import { canManageInstance } from "../../lib/permissions";
import {
  useCertificates,
  useInstanceDomains,
  useSaveInstanceDomains,
  useUpdateInstanceSettings,
} from "../../queries/instance";
import { useMe } from "../../queries/me";
import { SettingsFrame } from "./settings-frame";

type Tone = "success" | "warning" | "danger" | "neutral" | "info";

/** Let's Encrypt's production directory, the API's default. */
export const LETS_ENCRYPT_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";
/** Let's Encrypt's staging directory: untrusted certificates, generous rate limits. */
export const LETS_ENCRYPT_STAGING_DIRECTORY =
  "https://acme-staging-v02.api.letsencrypt.org/directory";

const HOSTNAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ZONE_ID = /^[a-f0-9]{32}$/;
const DAY = 86_400_000;
/** A certificate this close to expiry is highlighted: renewal should have finished. */
const EXPIRY_WARNING_MS = 14 * DAY;

const TLS_COPY: Record<TlsMode, { label: string; hint: string }> = {
  acme: {
    label: "Let's Encrypt, ordered by each server",
    hint: "Each server's Caddy orders certificates for the hostnames it serves. Needs public DNS pointing at your servers, and one ingress server: with more, a challenge can reach a server that didn't order it.",
  },
  managed: {
    label: "Let's Encrypt, managed by the control plane",
    hint: "The control plane orders certificates (HTTP-01, or DNS-01 through the Cloudflare zone below) and sends them to every ingress server, so any number of servers can share a hostname.",
  },
  internal: {
    label: "Internal CA",
    hint: "Caddy's local CA signs certificates. For development; browsers warn until you trust the CA.",
  },
  off: { label: "Off (plain HTTP)", hint: "No TLS. Only for tests on a private network." },
};

/** An API error in words, with the way out when the password prompt was dismissed. */
function saveErrorMessage(cause: unknown): string {
  return isApiError(cause, "reauth_required")
    ? `${errorMessage(cause)} Sign in again, then retry.`
    : errorMessage(cause);
}

function normalized(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
}

function validHostname(value: string): boolean {
  return HOSTNAME.test(value) && value.length <= 253;
}

// -----------------------------------------------------------------------------
// Ingress: apps domain and TLS mode
// -----------------------------------------------------------------------------

function RateLimitWarning({ appsDomain }: { appsDomain: string }) {
  return (
    <p role="status" className="mt-1.5 text-xs text-warning">
      Without a Cloudflare zone for {appsDomain}, every generated hostname gets its own certificate,
      and Let's Encrypt issues at most 50 new certificates per registered domain per week. Add the
      zone below to cover them with one wildcard certificate.
    </p>
  );
}

function IngressForm({ settings }: { settings: InstanceDomainSettings }) {
  const update = useUpdateInstanceSettings();
  const [domain, setDomain] = useState(settings.apps_domain ?? "");
  const [mode, setMode] = useState<TlsMode>(settings.tls_mode);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const modeId = useId();
  const apps = normalized(domain);
  const dirty = apps !== (settings.apps_domain ?? "") || mode !== settings.tls_mode;
  const { managed } = settings;
  const acmeConflict = mode === "acme" && settings.ingress_nodes > 1;
  const appsDomain = apps || settings.apps_domain;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (apps && !validHostname(apps)) {
      setError("Enter a hostname like apps.example.com.");
      return;
    }
    setError(null);
    setSaveError(null);
    update.mutate(
      {
        ...(apps !== (settings.apps_domain ?? "") ? { apps_domain: apps || null } : {}),
        ...(mode !== settings.tls_mode ? { tls_mode: mode } : {}),
      },
      {
        onSuccess: () => toast({ title: "Ingress settings saved", tone: "success" }),
        onError: (cause) => setSaveError(saveErrorMessage(cause)),
      },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Ingress">
      <SettingsSection
        title="Ingress"
        description={
          <>
            Generated domains are{" "}
            <span className="font-mono text-foreground">service-env-xxxx.&lt;apps domain&gt;</span>.
            Point a wildcard DNS record at your servers. Existing hostnames keep working when this
            changes; new ones use the new domain.
          </>
        }
      >
        <SettingsField
          label="Apps domain"
          description={`Empty disables generated domains. For local development use ${LOCAL_APPS_DOMAIN}.`}
          value={domain}
          onChange={(event) => setDomain(event.target.value)}
          placeholder="apps.example.com"
          error={error}
          inputClassName="font-mono"
          spellCheck={false}
        />
        <SettingsRow
          label="TLS mode"
          description="How every hostname, generated or custom, gets its certificate."
          htmlFor={modeId}
        >
          <Select
            id={modeId}
            value={mode}
            aria-describedby={`${modeId}-description ${modeId}-hint`}
            onChange={(event) => setMode(event.target.value as TlsMode)}
          >
            {(Object.keys(TLS_COPY) as TlsMode[]).map((value) => (
              <option
                key={value}
                value={value}
                disabled={
                  value === "managed" && !managed.available && settings.tls_mode !== "managed"
                }
              >
                {TLS_COPY[value].label}
                {value === "managed" && !managed.available ? " (unavailable)" : ""}
              </option>
            ))}
          </Select>
          <p id={`${modeId}-hint`} className="mt-1.5 text-xs text-muted-foreground">
            {TLS_COPY[mode].hint}
          </p>
          {!managed.available && managed.problems.length ? (
            <div className="mt-1.5 text-xs text-muted-foreground">
              <p>Managed mode needs:</p>
              <ul aria-label="Managed TLS prerequisites" className="list-disc pl-4">
                {managed.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {acmeConflict ? (
            <div role="status" className="mt-1.5 grid gap-1.5 text-xs text-warning">
              <p>
                This install has {settings.ingress_nodes} ingress servers. With Let's Encrypt
                ordered by each server, a challenge can reach a server that didn't order the
                certificate, so hostnames may not get one.
                {managed.available ? " Managed mode issues once and sends it to every server." : ""}
              </p>
              {managed.available ? (
                <div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setMode("managed")}
                  >
                    Switch to managed
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          {mode === "managed" && !managed.apps_wildcard && appsDomain ? (
            <RateLimitWarning appsDomain={appsDomain} />
          ) : null}
        </SettingsRow>
        <SettingsRow
          label="Ingress servers"
          description="Servers that take HTTP traffic, across every workspace."
        >
          <p className="text-sm tabular-nums text-foreground md:text-right">
            {settings.ingress_nodes}
          </p>
        </SettingsRow>
      </SettingsSection>
      {saveError ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {saveError}
        </p>
      ) : null}
      <SaveBar
        dirty={dirty}
        saving={update.isPending}
        onDiscard={() => {
          setDomain(settings.apps_domain ?? "");
          setMode(settings.tls_mode);
          setError(null);
          setSaveError(null);
        }}
      />
    </form>
  );
}

// -----------------------------------------------------------------------------
// Custom domains: the ingress hostname
// -----------------------------------------------------------------------------

function IngressHostnameForm({ settings }: { settings: InstanceDomainSettings }) {
  const save = useSaveInstanceDomains();
  const [draft, setDraft] = useState(settings.ingress_hostname ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const value = normalized(draft);
  const dirty = value !== (settings.ingress_hostname ?? "");

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const hostname = value ? normalizeHostname(value) : null;
    if (value && (!hostname || !validHostname(hostname))) {
      setError("Enter a hostname like ingress.example.com.");
      return;
    }
    setError(null);
    setSaveError(null);
    save.mutate(
      { ingress_hostname: hostname },
      {
        onSuccess: (next) => {
          setDraft(next.ingress_hostname ?? "");
          toast({ title: "Ingress hostname saved", tone: "success" });
        },
        onError: (cause) => setSaveError(saveErrorMessage(cause)),
      },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Custom domains">
      <SettingsSection
        title="Custom domains"
        description="What customers point their own hostnames at. Each custom domain still needs its ownership TXT record before it is routed."
      >
        <SettingsField
          label="Ingress hostname"
          description="The name customers CNAME their domains to. Keep it as A/AAAA records of every ingress server's public IP. Empty: they CNAME to the service's generated hostname."
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={
            settings.apps_domain ? `ingress.${settings.apps_domain}` : "ingress.example.com"
          }
          error={error}
          inputClassName="font-mono"
          spellCheck={false}
        />
      </SettingsSection>
      {saveError ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {saveError}
        </p>
      ) : null}
      <SaveBar
        dirty={dirty}
        saving={save.isPending}
        onDiscard={() => {
          setDraft(settings.ingress_hostname ?? "");
          setError(null);
          setSaveError(null);
        }}
      />
    </form>
  );
}

// -----------------------------------------------------------------------------
// Certificate authority
// -----------------------------------------------------------------------------

function AcmeForm({ settings }: { settings: InstanceDomainSettings }) {
  const save = useSaveInstanceDomains();
  const [directory, setDirectory] = useState(settings.acme.directory_url);
  const [email, setEmail] = useState(settings.acme.email ?? "");
  const [errors, setErrors] = useState<{ directory?: string; email?: string }>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const url = directory.trim();
  const contact = email.trim();
  const directoryChanged = url !== settings.acme.directory_url;
  const emailChanged = contact !== (settings.acme.email ?? "");

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const next: typeof errors = {};
    if (!/^https:\/\/[^\s]+$/.test(url)) next.directory = "Enter the CA's https:// directory URL.";
    if (contact && !EMAIL.test(contact)) next.email = "Enter an email address, or leave it empty.";
    setErrors(next);
    if (next.directory || next.email) return;
    setSaveError(null);
    save.mutate(
      {
        ...(directoryChanged ? { acme_directory_url: url } : {}),
        ...(emailChanged ? { acme_email: contact || null } : {}),
      },
      {
        onSuccess: (saved) => {
          setDirectory(saved.acme.directory_url);
          setEmail(saved.acme.email ?? "");
          toast({ title: "Certificate authority saved", tone: "success" });
        },
        onError: (cause) => setSaveError(saveErrorMessage(cause)),
      },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Certificate authority">
      <SettingsSection
        title="Certificate authority"
        description="Where the control plane orders certificates in managed mode. Servers ordering their own in Let's Encrypt mode always use Let's Encrypt."
      >
        <SettingsField
          label="ACME directory URL"
          description="Let's Encrypt by default. A new directory starts a new account at the next order."
          hint={`For tests, Let's Encrypt staging: ${LETS_ENCRYPT_STAGING_DIRECTORY}`}
          value={directory}
          onChange={(event) => setDirectory(event.target.value)}
          placeholder={LETS_ENCRYPT_DIRECTORY}
          error={errors.directory}
          inputClassName="font-mono"
          spellCheck={false}
        />
        <SettingsField
          label="Contact email"
          description="Optional. The CA may write about problems with your certificates."
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="ops@example.com"
          error={errors.email}
          autoComplete="email"
        />
        <SettingsRow label="Account" description="Registered with the CA by the first order.">
          <p className="truncate font-mono text-xs text-muted-foreground md:text-right">
            {settings.acme.account_url ?? "Not registered yet"}
          </p>
        </SettingsRow>
      </SettingsSection>
      {saveError ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {saveError}
        </p>
      ) : null}
      <SaveBar
        dirty={directoryChanged || emailChanged}
        saving={save.isPending}
        onDiscard={() => {
          setDirectory(settings.acme.directory_url);
          setEmail(settings.acme.email ?? "");
          setErrors({});
          setSaveError(null);
        }}
      />
    </form>
  );
}

// -----------------------------------------------------------------------------
// Cloudflare DNS
// -----------------------------------------------------------------------------

function CloudflareDnsSection({ settings }: { settings: InstanceDomainSettings }) {
  const save = useSaveInstanceDomains();
  const remove = useSaveInstanceDomains();
  const zone = settings.cloudflare_dns;
  const [replacing, setReplacing] = useState(false);
  const [zoneId, setZoneId] = useState("");
  const [token, setToken] = useState("");
  const [errors, setErrors] = useState<{ zoneId?: string; token?: string }>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const editing = !zone || replacing;
  const dirty = zoneId.trim() !== "" || token !== "";

  function reset() {
    setZoneId("");
    setToken("");
    setErrors({});
    setSaveError(null);
    setReplacing(false);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const id = zoneId.trim().toLowerCase();
    const next: typeof errors = {};
    if (!ZONE_ID.test(id)) next.zoneId = "Enter the 32-character zone ID from the zone's overview.";
    if (token.trim().length < 20) next.token = "Enter the API token.";
    setErrors(next);
    if (next.zoneId || next.token) return;
    setSaveError(null);
    save.mutate(
      { cloudflare_dns: { zone_id: id, api_token: token.trim() } },
      {
        onSuccess: (saved) => {
          reset();
          toast({
            title: `Cloudflare zone ${saved.cloudflare_dns?.zone_name ?? ""} connected`.trim(),
            tone: "success",
          });
        },
        onError: (cause) => setSaveError(saveErrorMessage(cause)),
      },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Cloudflare DNS">
      <SettingsSection
        title="Cloudflare DNS"
        description={
          <>
            Lets the control plane answer DNS-01 challenges in managed mode, which one wildcard
            certificate for the apps domain and wildcard custom domains (*.example.com) need. Use
            the apps domain's zone and a token limited to it with Zone → DNS → Edit and Zone → Zone
            → Read.
          </>
        }
        actions={
          <Badge tone={zone ? "success" : "neutral"}>{zone ? "Connected" : "Not set up"}</Badge>
        }
      >
        {zone ? (
          <SettingsRow
            label="Zone"
            description={
              <>
                <span className="font-mono">{zone.zone_id}</span> · updated{" "}
                <span title={formatTimestamp(zone.updated_at)}>
                  {formatRelativeTime(zone.updated_at)}
                </span>
                . The token is stored sealed and never shown.
              </>
            }
          >
            <div className="flex flex-wrap items-center gap-2 md:justify-end">
              <span className="font-mono text-sm text-foreground">{zone.zone_name}</span>
              {replacing ? null : (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setReplacing(true)}
                >
                  Replace token
                </Button>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={() => setRemoving(true)}>
                Remove
              </Button>
            </div>
          </SettingsRow>
        ) : null}
        <SettingsRow label="What it enables" description="Checked against the current settings.">
          <ul className="grid gap-1 text-sm md:text-right">
            <li>
              Apps wildcard certificate:{" "}
              <span
                className={
                  settings.managed.apps_wildcard ? "text-success" : "text-muted-foreground"
                }
              >
                {settings.managed.apps_wildcard ? "available" : "not available"}
              </span>
            </li>
            <li>
              Wildcard custom domains:{" "}
              <span
                className={
                  settings.managed.wildcard_domains ? "text-success" : "text-muted-foreground"
                }
              >
                {settings.managed.wildcard_domains ? "available" : "not available"}
              </span>
            </li>
          </ul>
        </SettingsRow>
        {editing ? (
          <>
            <SettingsField
              label="Zone ID"
              description="On the zone's Overview page in Cloudflare."
              value={zoneId}
              onChange={(event) => setZoneId(event.target.value)}
              placeholder="0123456789abcdef0123456789abcdef"
              error={errors.zoneId}
              autoComplete="off"
              inputClassName="font-mono"
              spellCheck={false}
            />
            <SettingsField
              label="API token"
              description="Stored write-only; it is never shown again. Saving checks it against the zone."
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              error={errors.token}
              autoComplete="new-password"
              inputClassName="font-mono"
            />
          </>
        ) : null}
      </SettingsSection>
      {saveError ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {saveError}
        </p>
      ) : null}
      {editing ? (
        <SaveBar
          dirty={dirty || replacing}
          saving={save.isPending}
          saveLabel={zone ? "Replace token" : "Connect zone"}
          onDiscard={reset}
        />
      ) : null}
      <ConfirmDialog
        open={removing}
        onOpenChange={(open) => {
          setRemoving(open);
          if (!open) remove.reset();
        }}
        title={
          zone ? `Remove the Cloudflare zone ${zone.zone_name}?` : "Remove the Cloudflare zone?"
        }
        description="Its token is deleted. Certificates already issued keep serving until they expire, but the apps wildcard and wildcard custom domains can't renew, and generated hostnames get certificates one by one."
        confirmLabel="Remove zone"
        pending={remove.isPending}
        error={remove.isError ? saveErrorMessage(remove.error) : null}
        onConfirm={() =>
          remove.mutate(
            { cloudflare_dns: null },
            {
              onSuccess: () => {
                setRemoving(false);
                reset();
                toast({ title: "Cloudflare zone removed", tone: "success" });
              },
            },
          )
        }
      />
    </form>
  );
}

// -----------------------------------------------------------------------------
// Certificates
// -----------------------------------------------------------------------------

const CERTIFICATE_STATUS: Record<Certificate["status"], { label: string; tone: Tone }> = {
  pending: { label: "Pending", tone: "warning" },
  issued: { label: "Issued", tone: "success" },
  renewing: { label: "Renewing", tone: "info" },
  failed: { label: "Failed", tone: "danger" },
};

const CERTIFICATE_KIND: Record<Certificate["kind"], string> = {
  apps_wildcard: "Apps wildcard",
  generated: "Generated",
  custom: "Custom",
};

const date = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);

function Expiry({ certificate, now }: { certificate: Certificate; now: number }) {
  if (certificate.not_after === null) return <span className="text-muted-foreground">—</span>;
  const left = certificate.not_after - now;
  const tone = left <= 0 ? "text-danger" : left < EXPIRY_WARNING_MS ? "text-warning" : "";
  return (
    <span title={formatTimestamp(certificate.not_after)} className={tone}>
      {date(certificate.not_after)}
      <span className="block text-xs text-muted-foreground">
        {left <= 0
          ? `expired ${formatUntil(certificate.not_after, now)}`
          : formatUntil(certificate.not_after, now)}
      </span>
    </span>
  );
}

function Renewal({ certificate, now }: { certificate: Certificate; now: number }) {
  const next = certificate.next_attempt_at;
  if (certificate.status === "failed" || certificate.status === "pending") {
    return next !== null ? (
      <span title={formatTimestamp(next)}>Next try {formatUntil(next, now)}</span>
    ) : (
      <span className="text-muted-foreground">—</span>
    );
  }
  if (certificate.status === "renewing") return <span>Renewing now</span>;
  if (certificate.renew_after === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span title={formatTimestamp(certificate.renew_after)}>
      {certificate.renew_after <= now
        ? "Due"
        : `Renews ${formatUntil(certificate.renew_after, now)}`}
    </span>
  );
}

function CertificateRow({ certificate, now }: { certificate: Certificate; now: number }) {
  const [first, ...rest] = certificate.hostnames;
  const status = CERTIFICATE_STATUS[certificate.status];
  const { acked, sent } = certificate.nodes;
  return (
    <TableRow>
      <TableCell cell="primary" className="max-w-80">
        <span className="block truncate font-mono text-xs" title={certificate.hostnames.join(", ")}>
          {first}
          {rest.length ? <span className="text-muted-foreground"> +{rest.length} more</span> : null}
        </span>
        <span className="block text-[11px] text-muted-foreground">
          {CERTIFICATE_KIND[certificate.kind]} · {certificate.challenge}
          {certificate.issuer ? ` · ${certificate.issuer}` : ""}
        </span>
        {certificate.error ? (
          <span className="mt-1 block text-xs text-danger">
            {certificate.error}
            {certificate.failures > 0
              ? ` (${certificate.failures} failed attempt${certificate.failures === 1 ? "" : "s"} in a row)`
              : ""}
          </span>
        ) : null}
      </TableCell>
      <TableCell>
        <Expiry certificate={certificate} now={now} />
      </TableCell>
      <TableCell className="text-sm">
        <Renewal certificate={certificate} now={now} />
      </TableCell>
      <TableCell className="tabular-nums text-sm">
        <span
          title="Ingress servers that confirmed loading the current certificate, of those sent it"
          className={sent > 0 && acked < sent ? "text-warning" : ""}
        >
          {acked}/{sent}
        </span>
      </TableCell>
      <TableCell cell="action">
        <Badge tone={status.tone}>{status.label}</Badge>
      </TableCell>
    </TableRow>
  );
}

function CertificatesSection({ settings }: { settings: InstanceDomainSettings }) {
  const certificates = useCertificates();
  const now = Date.now();
  return (
    <SettingsSection
      title="Certificates"
      description="Issued by the control plane in managed mode and sent to every ingress server. Renewal starts inside the CA's suggested window, or with a third of the lifetime left; a certificate keeps serving while a renewal fails."
    >
      {certificates.isPending ? (
        <Skeleton className="my-4 h-24 rounded-lg" />
      ) : certificates.isError ? (
        <div className="py-4">
          <ErrorState
            message={errorMessage(certificates.error)}
            onRetry={() => void certificates.refetch()}
          />
        </div>
      ) : certificates.data.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          {settings.tls_mode === "managed"
            ? "No certificates yet. They are ordered once a hostname is routed."
            : "None. Outside managed mode the servers hold their own certificates; each domain's details show its state."}
        </p>
      ) : (
        <Table stack aria-label="Certificates">
          <TableHeader>
            <TableRow>
              <TableHead>Hostnames</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Renewal</TableHead>
              <TableHead>Servers</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {certificates.data.map((certificate) => (
              <CertificateRow key={certificate.id} certificate={certificate} now={now} />
            ))}
          </TableBody>
        </Table>
      )}
    </SettingsSection>
  );
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

/**
 * Settings → Domains & TLS: the TLS mode and its prerequisites, the ingress hostname,
 * the ACME CA, the Cloudflare DNS zone and the certificate list. Instance admins only.
 *
 * @param props - Workspace id, for the settings navigation.
 * @returns The page.
 */
export function DomainsTlsPage({ workspaceId }: { workspaceId: string }) {
  const { data: me } = useMe();
  const admin = canManageInstance(me);
  const settings = useInstanceDomains(admin);

  return (
    <SettingsFrame
      workspaceId={workspaceId}
      title="Domains & TLS"
      description="How every hostname on this instance gets its certificate. Each change is recorded in the instance audit log."
    >
      {!admin ? (
        <EmptyState
          icon={<ShieldIcon />}
          title="Domains & TLS are for instance admins"
          description="The TLS mode, certificate authority and DNS credentials apply to the whole instance."
        />
      ) : settings.isPending ? (
        <Skeleton className="h-56 rounded-lg" />
      ) : settings.isError ? (
        <ErrorState
          message={errorMessage(settings.error)}
          onRetry={() => void settings.refetch()}
        />
      ) : (
        <SettingsStack>
          <IngressForm
            key={`${settings.data.apps_domain}:${settings.data.tls_mode}`}
            settings={settings.data}
          />
          <IngressHostnameForm
            key={settings.data.ingress_hostname ?? ""}
            settings={settings.data}
          />
          <AcmeForm
            key={`${settings.data.acme.directory_url}:${settings.data.acme.email}`}
            settings={settings.data}
          />
          <CloudflareDnsSection settings={settings.data} />
          <CertificatesSection settings={settings.data} />
        </SettingsStack>
      )}
    </SettingsFrame>
  );
}
