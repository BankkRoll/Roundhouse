import { LOCAL_APPS_DOMAIN, type TlsMode } from "@roundhouse/shared";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  EmptyState,
  Label,
  Select,
  Skeleton,
  toast,
} from "@roundhouse/ui";
import { ExternalLinkIcon, ShieldIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ErrorState } from "../../components/error-state";
import { FormField } from "../../components/form-field";
import { GithubIcon } from "../../components/github-mark";
import { PageHeader } from "../../components/page-header";
import { errorMessage } from "../../lib/api/client";
import type { GithubStatus, InstanceSettings } from "../../lib/api/deploy-types";
import { formatRelativeTime } from "../../lib/format";
import { canManageInstance, usePermissions } from "../../lib/permissions";
import {
  useCreateGithubManifest,
  useGithubStatus,
  useInstanceSettings,
  useUpdateInstanceSettings,
} from "../../queries/instance";
import { useMe } from "../../queries/me";
import { submitGithubManifest } from "./github-manifest";
import { SettingsTabs } from "./settings-tabs";

const HOSTNAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const TLS_COPY: Record<TlsMode, { label: string; hint: string }> = {
  acme: {
    label: "ACME (Let's Encrypt)",
    hint: "Certificates are issued on demand for each hostname. Needs public DNS pointing at your servers.",
  },
  internal: {
    label: "Internal CA",
    hint: "Caddy's local CA signs certificates. For development; browsers warn until you trust the CA.",
  },
  off: { label: "Off (plain HTTP)", hint: "No TLS. Only for tests on a private network." },
};

function IngressForm({ settings }: { settings: InstanceSettings }) {
  const update = useUpdateInstanceSettings();
  const [domain, setDomain] = useState(settings.apps_domain ?? "");
  const [mode, setMode] = useState<TlsMode>(settings.tls_mode);
  const [error, setError] = useState<string | null>(null);
  const modeId = useId();
  const normalized = domain
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  const dirty = normalized !== (settings.apps_domain ?? "") || mode !== settings.tls_mode;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (normalized && (!HOSTNAME.test(normalized) || normalized.length > 253)) {
      setError("Enter a hostname like apps.example.com.");
      return;
    }
    setError(null);
    update.mutate(
      {
        ...(normalized !== (settings.apps_domain ?? "") ? { apps_domain: normalized || null } : {}),
        ...(mode !== settings.tls_mode ? { tls_mode: mode } : {}),
      },
      {
        onSuccess: () => toast({ title: "Platform settings saved", tone: "success" }),
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  }

  return (
    <Card>
      <form onSubmit={onSubmit} noValidate aria-label="Ingress">
        <CardHeader>
          <div>
            <CardTitle>Ingress</CardTitle>
            <CardDescription>
              Generated domains are{" "}
              <span className="font-mono">service-env-xxxx.&lt;apps domain&gt;</span>. Point a
              wildcard DNS record at your servers. Existing hostnames keep working when this
              changes; new ones use the new domain.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid max-w-lg gap-4">
          <FormField
            label="Apps domain"
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            placeholder="apps.example.com"
            error={error}
            hint={`Empty disables generated domains. For local development use ${LOCAL_APPS_DOMAIN}.`}
            inputClassName="font-mono"
            spellCheck={false}
          />
          <div className="grid gap-1.5">
            <Label htmlFor={modeId}>TLS mode</Label>
            <Select
              id={modeId}
              value={mode}
              onChange={(event) => setMode(event.target.value as TlsMode)}
            >
              {(Object.keys(TLS_COPY) as TlsMode[]).map((value) => (
                <option key={value} value={value}>
                  {TLS_COPY[value].label}
                </option>
              ))}
            </Select>
            <p className="text-xs text-subtle-foreground">{TLS_COPY[mode].hint}</p>
          </div>
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" variant="primary" disabled={!dirty} loading={update.isPending}>
            Save
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function CreateAppForm({ workspaceId }: { workspaceId: string }) {
  const create = useCreateGithubManifest();
  const [organization, setOrganization] = useState("");
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const org = organization.trim();
    if (org && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(org)) {
      setError("Enter a GitHub organization login, like acme.");
      return;
    }
    setError(null);
    create.mutate(
      { workspace_id: workspaceId, organization: org || undefined },
      {
        onSuccess: ({ manifest, post_url }) => {
          try {
            submitGithubManifest(manifest, post_url);
          } catch (cause) {
            setError(errorMessage(cause));
          }
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-3" aria-label="Create GitHub App">
      <p className="text-sm text-muted-foreground">
        Roundhouse creates a private GitHub App for this instance with read access to code and push
        events. You confirm it on GitHub, then install it on the accounts whose repositories you
        want to deploy. Public repositories work without it.
      </p>
      <div className="grid max-w-sm">
        <FormField
          label="Organization (optional)"
          value={organization}
          onChange={(event) => setOrganization(event.target.value)}
          placeholder="Your personal account"
          hint="Create the App under an organization you administer instead of your account."
          error={error}
          spellCheck={false}
        />
      </div>
      <div>
        <Button type="submit" variant="primary" loading={create.isPending}>
          <GithubIcon />
          Create GitHub App
        </Button>
      </div>
    </form>
  );
}

function GithubSection({
  workspaceId,
  status,
  canCreate,
}: {
  workspaceId: string;
  status: GithubStatus;
  canCreate: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>GitHub App</CardTitle>
          <CardDescription>Builds private repositories and deploys on push.</CardDescription>
        </div>
        <Badge tone={status.configured ? "success" : "neutral"}>
          {status.configured ? "connected" : "not set up"}
        </Badge>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!status.app ? (
          canCreate ? (
            <CreateAppForm workspaceId={workspaceId} />
          ) : (
            <p className="text-sm text-muted-foreground">
              A workspace owner can create the GitHub App for this instance.
            </p>
          )
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <GithubIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{status.app.name}</p>
                  <a
                    href={status.app.html_url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="font-mono text-[11px] text-muted-foreground hover:underline"
                  >
                    github.com/apps/{status.app.slug}
                  </a>
                </div>
              </div>
              <Button asChild variant="primary">
                <a href={status.app.install_url} rel="noreferrer noopener">
                  <ExternalLinkIcon />
                  Install on GitHub
                </a>
              </Button>
            </div>
            <div className="grid gap-2">
              <h4 className="font-mono text-[10px] uppercase tracking-[0.12em] text-subtle-foreground">
                Installations in this workspace
              </h4>
              {status.installations.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Not installed anywhere yet. Install it on an account or organization to pick its
                  repositories when adding a service.
                </p>
              ) : (
                <ul className="rounded-md border border-border" aria-label="Installations">
                  {status.installations.map((installation) => (
                    <li
                      key={installation.id}
                      className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-0"
                    >
                      <span className="font-mono text-xs text-foreground">
                        {installation.account_login}
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {installation.account_type.toLowerCase()} · added{" "}
                        {formatRelativeTime(installation.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Install-wide settings: the apps domain and TLS mode for generated domains (owners),
 * and the GitHub App with its installations. Owners can create the App through GitHub's
 * manifest flow; anyone who manages projects can install it.
 *
 * @param props - Workspace id (installations are per workspace).
 * @returns The page.
 */
export function PlatformPage({ workspaceId }: { workspaceId: string }) {
  const { data: me } = useMe();
  const { can } = usePermissions(workspaceId);
  const owner = canManageInstance(me);
  const settings = useInstanceSettings(owner);
  const github = useGithubStatus(workspaceId, can("projects:read"));

  return (
    <>
      <PageHeader title="Settings" subline="Platform: shared by every workspace on this instance" />
      <SettingsTabs workspaceId={workspaceId} />
      <div className="grid max-w-3xl gap-4">
        {owner ? (
          settings.isPending ? (
            <Skeleton className="h-56 rounded-lg" />
          ) : settings.isError ? (
            <ErrorState
              message={errorMessage(settings.error)}
              onRetry={() => void settings.refetch()}
            />
          ) : (
            <IngressForm settings={settings.data} />
          )
        ) : (
          <EmptyState
            icon={<ShieldIcon />}
            title="Ingress settings are for owners"
            description="The apps domain and TLS mode apply to the whole instance, so only workspace owners can change them."
          />
        )}
        {github.isPending ? (
          <Skeleton className="h-40 rounded-lg" />
        ) : github.isError ? (
          <ErrorState message={errorMessage(github.error)} onRetry={() => void github.refetch()} />
        ) : (
          <GithubSection workspaceId={workspaceId} status={github.data} canCreate={owner} />
        )}
      </div>
    </>
  );
}
