import { Badge, Button, copyText, EmptyState, Skeleton, Tooltip, toast } from "@openrail/ui";
import { Link } from "@tanstack/react-router";
import { CopyIcon, ExternalLinkIcon, GlobeIcon, LockIcon, PlusIcon } from "lucide-react";
import { ErrorState } from "../../../components/error-state";
import { errorMessage } from "../../../lib/api/client";
import type { Domain } from "../../../lib/api/deploy-types";
import { formatRelativeTime } from "../../../lib/format";
import { useDomains, useServiceConfig } from "../../../queries/services";
import { useProjectEnvironment } from "../../projects/use-project-environment";
import type { ServicePageProps } from "../service-layout";

const TLS_TONE: Record<Domain["tls_status"], "success" | "warning" | "danger" | "neutral"> = {
  issued: "success",
  pending: "warning",
  failed: "danger",
  disabled: "neutral",
};

function DomainRow({ domain }: { domain: Domain }) {
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-0">
      <GlobeIcon className="size-4 text-muted-foreground" aria-hidden="true" />
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
        <p className="font-mono text-[11px] text-muted-foreground">
          {domain.type} · port {domain.target_port} · added {formatRelativeTime(domain.created_at)}
        </p>
      </div>
      <Badge tone={TLS_TONE[domain.tls_status]}>
        <LockIcon className="size-2.5" aria-hidden="true" />
        tls {domain.tls_status}
      </Badge>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Copy ${domain.hostname}`}
        onClick={() =>
          void copyText(domain.url).then((ok) =>
            toast({ title: ok ? "URL copied" : "Could not copy", tone: ok ? "success" : "error" }),
          )
        }
      >
        <CopyIcon />
      </Button>
      <Button asChild variant="secondary" size="sm">
        <a
          href={domain.url}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={`Open ${domain.hostname}`}
        >
          <ExternalLinkIcon />
          Open
        </a>
      </Button>
    </li>
  );
}

/**
 * A service's domains: the generated hostname with copy and open. Custom domains ship
 * in Phase 3, so their action is shown but disabled with the reason.
 *
 * @param props - Workspace, project and service ids.
 * @returns The tab.
 */
export function DomainsTab({ workspaceId, projectId, serviceId }: ServicePageProps) {
  const { environment, envParam } = useProjectEnvironment(projectId);
  const domains = useDomains(serviceId, environment?.id);
  const config = useServiceConfig(serviceId, environment?.id);

  const addCustom = (
    <Tooltip content="Custom domains arrive in Phase 3">
      <Button
        variant="secondary"
        aria-disabled="true"
        aria-describedby="custom-domain-note"
        onClick={(event) => event.preventDefault()}
        className="aria-disabled:pointer-events-auto aria-disabled:cursor-not-allowed"
      >
        <PlusIcon />
        Add custom domain
      </Button>
    </Tooltip>
  );

  return (
    <section aria-label="Domains" className="grid max-w-4xl gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p id="custom-domain-note" className="text-sm text-muted-foreground">
          Generated hostnames come with TLS. Custom domains (your own DNS name, verified and with
          its own certificate) arrive in Phase 3.
        </p>
        {addCustom}
      </div>
      {domains.isPending ? (
        <Skeleton className="h-16 rounded-lg" />
      ) : domains.isError ? (
        <ErrorState message={errorMessage(domains.error)} onRetry={() => void domains.refetch()} />
      ) : domains.data.length === 0 ? (
        <EmptyState
          icon={<GlobeIcon />}
          title="No domains"
          description={
            config.data?.networking.port === null
              ? "This service has no port, so it isn't reachable over HTTP. Set a port to give it a hostname."
              : "Turn on the generated domain in Settings → Networking. An owner must set the instance's apps domain first."
          }
          action={
            <Button asChild variant="secondary">
              <Link
                to="/w/$workspaceId/p/$projectId/s/$serviceId/settings"
                params={{ workspaceId, projectId, serviceId }}
                search={{ env: envParam }}
              >
                Open settings
              </Link>
            </Button>
          }
          className="py-12"
        />
      ) : (
        <ul className="rounded-lg border border-border bg-surface" aria-label="Domain list">
          {domains.data.map((domain) => (
            <DomainRow key={domain.id} domain={domain} />
          ))}
        </ul>
      )}
    </section>
  );
}
