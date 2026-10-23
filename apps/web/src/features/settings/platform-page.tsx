import {
  DEFAULT_LOG_RETENTION_DAYS,
  LOCAL_APPS_DOMAIN,
  MAX_LOG_RETENTION_DAYS,
  PRODUCT_NAME,
  type TlsMode,
} from "@roundhouse/shared";
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
  toast,
} from "@roundhouse/ui";
import { Switch } from "@roundhouse/ui/controls";
import { ExternalLinkIcon, ShieldIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ErrorState } from "../../components/error-state";
import { FormField } from "../../components/form-field";
import { GithubIcon } from "../../components/github-mark";
import { SettingsField } from "../../components/settings-field";
import { errorMessage, isApiError } from "../../lib/api/client";
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
import { SettingsFrame } from "./settings-frame";
import { SigningKeysSection } from "./signing-keys-section";

/** The MCP section of the API README: endpoint, tools, scopes and client setup. */
export const MCP_DOCS_URL =
  "https://github.com/BankkRoll/Roundhouse/blob/main/apps/api/README.md#mcp";

const HOSTNAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const TLS_COPY: Record<TlsMode, { label: string; hint: string }> = {
  acme: {
    label: "Let's Encrypt (automatic)",
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
          description="How hostnames under the apps domain get their certificates."
          htmlFor={modeId}
        >
          <Select
            id={modeId}
            value={mode}
            aria-describedby={`${modeId}-description ${modeId}-hint`}
            onChange={(event) => setMode(event.target.value as TlsMode)}
          >
            {(Object.keys(TLS_COPY) as TlsMode[]).map((value) => (
              <option key={value} value={value}>
                {TLS_COPY[value].label}
              </option>
            ))}
          </Select>
          <p id={`${modeId}-hint`} className="mt-1.5 text-xs text-muted-foreground">
            {TLS_COPY[mode].hint}
          </p>
        </SettingsRow>
      </SettingsSection>
      <SaveBar
        dirty={dirty}
        saving={update.isPending}
        onDiscard={() => {
          setDomain(settings.apps_domain ?? "");
          setMode(settings.tls_mode);
          setError(null);
        }}
      />
    </form>
  );
}

function parseRetention(value: string): number | string {
  const days = Number(value.trim());
  if (!value.trim() || !Number.isInteger(days) || days < 1 || days > MAX_LOG_RETENTION_DAYS) {
    return `Enter a whole number of days from 1 to ${MAX_LOG_RETENTION_DAYS}.`;
  }
  return days;
}

function LogRetentionForm({ settings }: { settings: InstanceSettings }) {
  const update = useUpdateInstanceSettings();
  // NOTE: `null` until the user types, so the field follows the saved value.
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const value = draft ?? String(settings.log_retention_days);
  const parsed = parseRetention(value);
  const dirty = draft !== null && parsed !== settings.log_retention_days;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (typeof parsed === "string") {
      setError(parsed);
      return;
    }
    setError(null);
    update.mutate(
      { log_retention_days: parsed },
      {
        onSuccess: () => {
          setDraft(null);
          toast({ title: "Log retention saved", tone: "success" });
        },
        onError: (cause) => setError(errorMessage(cause)),
      },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Logs">
      <SettingsSection
        title="Logs"
        description="Runtime and build logs of every workspace are kept this long, then deleted by an hourly cleanup. A shorter period takes effect at the next run."
      >
        <SettingsField
          label="Keep logs for (days)"
          description={`1 to ${MAX_LOG_RETENTION_DAYS} days. The default is ${DEFAULT_LOG_RETENTION_DAYS}.`}
          type="number"
          inputMode="numeric"
          min={1}
          max={MAX_LOG_RETENTION_DAYS}
          step={1}
          value={value}
          onChange={(event) => setDraft(event.target.value)}
          error={error}
          inputClassName="w-28 tabular-nums"
        />
      </SettingsSection>
      <SaveBar
        dirty={dirty}
        saving={update.isPending}
        onDiscard={() => {
          setDraft(null);
          setError(null);
        }}
      />
    </form>
  );
}

function McpSection({ settings }: { settings: InstanceSettings }) {
  const update = useUpdateInstanceSettings();
  const [error, setError] = useState<string | null>(null);
  const switchId = useId();

  function onChange(enabled: boolean) {
    setError(null);
    update.mutate(
      { mcp_enabled: enabled },
      {
        onSuccess: () =>
          toast({ title: enabled ? "MCP enabled" : "MCP disabled", tone: "success" }),
        onError: (cause) =>
          setError(
            isApiError(cause, "reauth_required")
              ? `${errorMessage(cause)} Sign in again, then retry.`
              : errorMessage(cause),
          ),
      },
    );
  }

  return (
    <SettingsSection
      title="MCP"
      description="A remote MCP server at /mcp lets coding agents list projects, read logs, deploy and set variables with a workspace API token, limited by the token's scopes and its owner's role."
      actions={
        <Badge tone={settings.mcp_enabled ? "success" : "neutral"}>
          {settings.mcp_enabled ? "On" : "Off"}
        </Badge>
      }
    >
      <SettingsRow
        label="Allow coding agents"
        description={
          <>
            Off by default. While off, /mcp answers 404 to everyone.{" "}
            <a
              href={MCP_DOCS_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="text-accent-text underline-offset-4 hover:underline"
            >
              How agents connect
            </a>
          </>
        }
        htmlFor={switchId}
        control="switch"
      >
        <Switch
          id={switchId}
          checked={settings.mcp_enabled}
          disabled={update.isPending}
          onCheckedChange={onChange}
          aria-describedby={error ? `${switchId}-error` : undefined}
        />
      </SettingsRow>
      {error ? (
        <p id={`${switchId}-error`} role="alert" className="pb-4 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </SettingsSection>
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
      setError("Enter a GitHub organization login, like my-org.");
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
    <form onSubmit={onSubmit} noValidate aria-label="Create GitHub App">
      <SettingsRow
        label="Create the GitHub App"
        description={`${PRODUCT_NAME} creates a private GitHub App for this instance with read access to code and push events. You confirm it on GitHub, then install it on the accounts whose repositories you want to deploy. Public repositories work without it.`}
        control="wide"
      >
        <div className="grid max-w-sm gap-3">
          <FormField
            label="Organization (optional)"
            value={organization}
            onChange={(event) => setOrganization(event.target.value)}
            placeholder="Your personal account"
            hint="Create the App under an organization you administer instead of your account."
            error={error}
            spellCheck={false}
          />
          <div>
            <Button type="submit" variant="primary" loading={create.isPending}>
              <GithubIcon />
              Create GitHub App
            </Button>
          </div>
        </div>
      </SettingsRow>
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
    <SettingsSection
      title="GitHub App"
      description="Builds private repositories and deploys on push."
      actions={
        <Badge tone={status.configured ? "success" : "neutral"}>
          {status.configured ? "Connected" : "Not set up"}
        </Badge>
      }
    >
      {!status.app ? (
        canCreate ? (
          <CreateAppForm workspaceId={workspaceId} />
        ) : (
          <SettingsRow
            label="Not created yet"
            description="A workspace owner can create the GitHub App for this instance."
          />
        )
      ) : (
        <>
          <SettingsRow
            label={
              <span className="flex items-center gap-2">
                <GithubIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                {status.app.name}
              </span>
            }
            description={
              <a
                href={status.app.html_url}
                target="_blank"
                rel="noreferrer noopener"
                className="font-mono text-xs hover:underline"
              >
                github.com/apps/{status.app.slug}
              </a>
            }
          >
            <div className="md:flex md:justify-end">
              <Button asChild variant="secondary">
                <a href={status.app.install_url} rel="noreferrer noopener">
                  <ExternalLinkIcon />
                  Install on GitHub
                </a>
              </Button>
            </div>
          </SettingsRow>
          <SettingsRow
            label="Installations in this workspace"
            description={
              status.installations.length === 0
                ? "Not installed anywhere yet. Install it on an account or organization to pick its repositories when adding a service."
                : "Accounts whose repositories this workspace can deploy."
            }
            control="wide"
          >
            {status.installations.length > 0 ? (
              <ul aria-label="Installations" className="divide-y divide-border/70">
                {status.installations.map((installation) => (
                  <li
                    key={installation.id}
                    className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                  >
                    <span className="font-mono text-sm text-foreground">
                      {installation.account_login}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {installation.account_type.toLowerCase()} · added{" "}
                      {formatRelativeTime(installation.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : undefined}
          </SettingsRow>
        </>
      )}
    </SettingsSection>
  );
}

/**
 * Install-wide settings: the apps domain and TLS mode for generated domains, how long
 * logs are kept, whether the MCP endpoint is on, and the control-plane signing key and its
 * rollover (instance admins), and the GitHub App with its installations. Owners can
 * create the App through GitHub's manifest flow; anyone who manages projects can install
 * it.
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
    <SettingsFrame
      workspaceId={workspaceId}
      title="Platform"
      description={
        owner
          ? "Shared by every workspace on this instance. Each change is recorded in the audit log of every workspace you own."
          : "Shared by every workspace on this instance."
      }
    >
      <SettingsStack>
        {owner ? (
          settings.isPending ? (
            <Skeleton className="h-56 rounded-lg" />
          ) : settings.isError ? (
            <ErrorState
              message={errorMessage(settings.error)}
              onRetry={() => void settings.refetch()}
            />
          ) : (
            <>
              <IngressForm settings={settings.data} />
              <LogRetentionForm settings={settings.data} />
              <McpSection settings={settings.data} />
              <SigningKeysSection />
            </>
          )
        ) : (
          <EmptyState
            icon={<ShieldIcon />}
            title="Instance settings are for owners"
            description="The apps domain, TLS mode and log retention apply to the whole instance, so only workspace owners can change them."
          />
        )}
        {github.isPending ? (
          <Skeleton className="h-40 rounded-lg" />
        ) : github.isError ? (
          <ErrorState message={errorMessage(github.error)} onRetry={() => void github.refetch()} />
        ) : (
          <GithubSection workspaceId={workspaceId} status={github.data} canCreate={owner} />
        )}
      </SettingsStack>
    </SettingsFrame>
  );
}
