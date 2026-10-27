/**
 * A service's published TCP port (ADR 0004, "TCP proxy"): off by default; turning it on
 * opens an allowlist editor with the exposure spelled out, and once published the
 * section shows its status, the public endpoint and, for a database, the reference
 * apps outside the project use to reach it.
 *
 * @module
 */
import {
  Badge,
  Button,
  Checkbox,
  Label,
  SettingsRow,
  SettingsSection,
  Skeleton,
  Textarea,
  toast,
} from "@roundhouse/ui";
import { Switch } from "@roundhouse/ui/controls";
import { TriangleAlertIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { errorMessage, isApiError } from "../../lib/api/client";
import type { TcpProxy } from "../../lib/api/data-client";
import type { Environment, Service } from "../../lib/api/deploy-types";
import { usePermissions } from "../../lib/permissions";
import { useDeleteTcpProxy, usePutTcpProxy, useTcpProxy } from "../../queries/databases";
import { parseAllowlist } from "./allowlist";
import { actionError } from "./backups-tab";
import { CopyButton } from "./copy-button";
import { variableReference } from "./database-meta";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const STATUS: Record<TcpProxy["status"], { label: string; tone: Tone }> = {
  active: { label: "Active", tone: "success" },
  pending: { label: "Pending", tone: "warning" },
  unsupported: { label: "Unsupported", tone: "danger" },
};

/** Variable a database template derives from the published endpoint. */
export const PUBLIC_URL_VARIABLE = "DATABASE_PUBLIC_URL";

function statusText(proxy: TcpProxy, serviceName: string): string {
  switch (proxy.status) {
    case "active":
      return "Published: the server drops every connection from outside the allowlist.";
    case "pending":
      return `Not placed yet: the port opens once ${serviceName} runs on a server.`;
    case "unsupported":
      return "The agent on this server can't enforce a source allowlist, so nothing is published. Upgrade the agent to open the port.";
  }
}

// -----------------------------------------------------------------------------
// Editor
// -----------------------------------------------------------------------------

function AllowlistEditor({
  service,
  environment,
  proxy,
  onDone,
}: {
  service: Service;
  environment: Environment;
  proxy: TcpProxy | null;
  onDone: () => void;
}) {
  const put = usePutTcpProxy(service.id);
  const [text, setText] = useState(proxy ? proxy.allowed_cidrs.join("\n") : "");
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string[]>([]);
  const fieldId = useId();
  const ackId = useId();
  const parsed = parseAllowlist(text);
  const invalid = [
    ...new Set([...parsed.invalid, ...rejected.filter((e) => parsed.entries.includes(e))]),
  ];
  const fieldError = submitted
    ? (parsed.error ??
      (invalid.length > 0 ? `Not an address or CIDR block: ${invalid.join(", ")}` : null))
    : null;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    setError(null);
    if (parsed.error || parsed.invalid.length > 0) return;
    if (parsed.open && !acknowledged) {
      setError("Confirm that the port is open to the whole internet first.");
      return;
    }
    put.mutate(
      {
        environment_id: environment.id,
        allowed_cidrs: parsed.entries,
        ...(parsed.open ? { acknowledge_open: true } : {}),
      },
      {
        onSuccess: (saved) => {
          setRejected([]);
          toast({
            title: proxy
              ? "Allowlist saved"
              : `Publishing ${service.name} on port ${saved.public_port}`,
            tone: "success",
          });
          onDone();
        },
        onError: (cause) => {
          if (isApiError(cause, "invalid_request") && cause.details.length > 0) {
            setRejected(cause.details.map((detail) => detail.message));
          }
          if (isApiError(cause, "confirmation_required")) setAcknowledged(false);
          setError(actionError(cause));
        },
      },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="TCP allowlist" className="grid gap-4 py-4">
      <div
        role="note"
        className="grid gap-1 rounded-lg border border-danger/50 bg-danger/10 px-3.5 py-2.5 text-sm text-foreground"
      >
        <p className="flex items-center gap-2 font-medium">
          <TriangleAlertIcon className="size-4 shrink-0 text-danger" aria-hidden="true" />
          This port becomes reachable from the internet
        </p>
        <p className="text-[13px] text-muted-foreground">
          Anyone connecting from an address on this list reaches {service.name} directly, with no
          proxy in front. The connection is unencrypted unless the client and the{" "}
          {service.database ? "database" : "service"} negotiate TLS. List only the addresses that
          need it, never a whole network you don't control.
        </p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={fieldId}>Allowed sources</Label>
        <Textarea
          id={fieldId}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={"203.0.113.7\n198.51.100.0/24\n2001:db8::/48"}
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={`${fieldId}-hint`}
          spellCheck={false}
          rows={4}
        />
        <p
          id={`${fieldId}-hint`}
          className={fieldError ? "text-xs text-danger" : "text-xs text-muted-foreground"}
        >
          {fieldError ??
            "One per line: IPv4 or IPv6 addresses or CIDR blocks. A bare address admits only itself."}
        </p>
      </div>
      {parsed.open ? (
        <div className="flex items-start gap-2 rounded-lg border border-danger/50 px-3 py-2">
          <Checkbox
            id={ackId}
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <Label htmlFor={ackId} className="grid gap-0.5 font-normal">
            <span className="text-sm text-foreground">
              I understand this opens the port to every address on the internet
            </span>
            <span className="text-xs text-muted-foreground">
              0.0.0.0/0 and ::/0 admit anyone. Only the{" "}
              {service.database ? "database's" : "service's"} own authentication stands in the way.
            </span>
          </Label>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={put.isPending}>
          {proxy ? "Save allowlist" : "Publish port"}
        </Button>
      </div>
    </form>
  );
}

// -----------------------------------------------------------------------------
// Section
// -----------------------------------------------------------------------------

/** Props for {@link TcpProxySection}. */
export interface TcpProxySectionProps {
  workspaceId: string;
  service: Service;
  environment: Environment | undefined;
}

/**
 * Publishing a service's TCP port to the internet behind a source allowlist. Off by
 * default; the switch opens the allowlist editor, and turning it off stops publishing
 * after a confirmation. Saving needs a fresh session.
 *
 * @param props - Workspace, the service and the selected environment.
 * @returns The section.
 */
export function TcpProxySection({ workspaceId, service, environment }: TcpProxySectionProps) {
  const { can } = usePermissions(workspaceId);
  const query = useTcpProxy(service.id, environment?.id);
  const remove = useDeleteTcpProxy(service.id, environment?.id ?? "");
  const [editing, setEditing] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const switchId = useId();
  const canManage = can("services:manage");
  const proxy = query.data ?? null;
  const endpoint = proxy?.host ? `${proxy.host}:${proxy.public_port}` : null;

  return (
    <SettingsSection
      id="tcp-proxy"
      title="TCP proxy"
      description="Publishes the service's port on its server's public address, for clients outside the project. Single-replica services only."
      className="scroll-mt-20"
      actions={
        proxy ? <Badge tone={STATUS[proxy.status].tone}>{STATUS[proxy.status].label}</Badge> : null
      }
    >
      {query.isPending || !environment ? (
        <Skeleton className="my-4 h-12" />
      ) : query.isError ? (
        <SettingsRow label="Could not load the TCP proxy" description={errorMessage(query.error)} />
      ) : (
        <>
          <SettingsRow
            label="Public TCP port"
            description={
              proxy
                ? `Port ${proxy.container_port} in the container, published as ${proxy.public_port}.`
                : "Off. The service is reachable only on the project's private network."
            }
            htmlFor={switchId}
            control="switch"
          >
            <Switch
              id={switchId}
              aria-describedby={`${switchId}-description`}
              checked={proxy !== null || editing}
              disabled={!canManage}
              onCheckedChange={(on) => {
                if (on) setEditing(true);
                else if (proxy) setDisabling(true);
                else setEditing(false);
              }}
            />
          </SettingsRow>
          {editing ? (
            <AllowlistEditor
              service={service}
              environment={environment}
              proxy={proxy}
              onDone={() => setEditing(false)}
            />
          ) : null}
          {proxy ? (
            <>
              <SettingsRow label="Status" description={statusText(proxy, service.name)}>
                <p className="text-sm text-foreground md:text-right">
                  {STATUS[proxy.status].label}
                </p>
              </SettingsRow>
              <SettingsRow
                label="Endpoint"
                description={endpoint ? undefined : "Shown once the service is placed on a server."}
              >
                {endpoint ? (
                  <div className="flex items-center gap-1 md:justify-end">
                    <code className="truncate font-mono text-sm text-foreground">{endpoint}</code>
                    <CopyButton value={endpoint} label="Endpoint" />
                  </div>
                ) : null}
              </SettingsRow>
              {editing ? null : (
                <SettingsRow
                  label="Allowed sources"
                  description={
                    proxy.open_to_all
                      ? "Open to every address on the internet."
                      : "Every other source is dropped on the server."
                  }
                >
                  <div className="grid gap-2 md:justify-items-end">
                    <ul aria-label="Allowed sources" className="grid gap-0.5 md:text-right">
                      {proxy.allowed_cidrs.map((cidr) => (
                        <li key={cidr} className="font-mono text-[13px] text-foreground">
                          {cidr}
                        </li>
                      ))}
                    </ul>
                    {proxy.open_to_all ? (
                      <p className="flex items-center gap-1.5 text-xs text-danger">
                        <TriangleAlertIcon className="size-3.5" aria-hidden="true" />
                        Open to the internet
                      </p>
                    ) : null}
                    {canManage ? (
                      <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                        Edit allowlist
                      </Button>
                    ) : null}
                  </div>
                </SettingsRow>
              )}
              {service.database ? (
                <SettingsRow
                  label="Connect from an app"
                  description={
                    <>
                      Reference{" "}
                      <code className="font-mono text-foreground">
                        {variableReference(service.slug, PUBLIC_URL_VARIABLE)}
                      </code>{" "}
                      in the app's variables. Its value holds the password, so it is write-only and
                      never shown.
                    </>
                  }
                >
                  <div className="md:flex md:justify-end">
                    <CopyButton
                      value={variableReference(service.slug, PUBLIC_URL_VARIABLE)}
                      label={`${PUBLIC_URL_VARIABLE} reference`}
                    />
                  </div>
                </SettingsRow>
              ) : null}
            </>
          ) : null}
          <ConfirmDialog
            open={disabling}
            onOpenChange={(open) => {
              setDisabling(open);
              if (!open) remove.reset();
            }}
            title="Stop publishing this port?"
            description={
              endpoint
                ? `Clients connecting to ${endpoint} are cut off. Apps on the project's private network keep working.`
                : "Clients outside the project lose access. Apps on the project's private network keep working."
            }
            confirmLabel="Stop publishing"
            pending={remove.isPending}
            error={remove.isError ? errorMessage(remove.error) : null}
            onConfirm={() =>
              remove.mutate(undefined, {
                onSuccess: () => {
                  setDisabling(false);
                  setEditing(false);
                  toast({ title: "TCP port closed", tone: "success" });
                },
              })
            }
          />
        </>
      )}
    </SettingsSection>
  );
}
