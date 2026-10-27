/**
 * Settings → Cloudflare (ADR 0011): the account Cloudflare-provider services deploy to.
 *
 * - **Account**: the account ID and a write-only API token (only its hint is ever
 *   shown), set through `PUT /v1/instance/cloudflare`, which needs a fresh session; the
 *   API client asks for the password and retries.
 * - **Verification**: re-checks the token's scopes and the apps zone, check by check.
 * - **Routing**: whether the apps domain is proxied (Worker routes only run on proxied
 *   hostnames), the Advanced Certificate Manager note, and the `workers.dev` subdomain.
 * - **Image storage**: the account's registry usage against Cloudflare's limit.
 *
 * The edge gateway (ADR 0011, experimental) isn't built yet; its row says so.
 *
 * @module
 */
import {
  Badge,
  Button,
  EmptyState,
  MeterRow,
  SaveBar,
  SettingsRow,
  SettingsSection,
  SettingsStack,
  Skeleton,
  toast,
} from "@roundhouse/ui";
import { Switch } from "@roundhouse/ui/controls";
import { CircleCheckIcon, CircleXIcon, ShieldIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorState } from "../../components/error-state";
import { SettingsField } from "../../components/settings-field";
import { errorMessage, isApiError } from "../../lib/api/client";
import {
  CLOUDFLARE_IMAGE_STORAGE_LIMIT_BYTES,
  type InstanceCloudflare,
} from "../../lib/api/cloudflare-client";
import { formatBytes, formatRelativeTime, formatTimestamp } from "../../lib/format";
import { canManageInstance } from "../../lib/permissions";
import {
  useDeleteInstanceCloudflare,
  useInstanceCloudflare,
  useSaveInstanceCloudflare,
  useVerifyInstanceCloudflare,
} from "../../queries/cloudflare";
import { useInstanceDomains } from "../../queries/instance";
import { useMe } from "../../queries/me";
import { SettingsFrame } from "./settings-frame";

const ACCOUNT_ID = /^[a-f0-9]{32}$/;

/** What the token needs, as Cloudflare's token editor names the permissions. */
export const CLOUDFLARE_TOKEN_PERMISSIONS =
  "Account → Workers Scripts → Edit, Account → Containers → Edit, Account → Account Analytics → Read, and Zone → Workers Routes → Edit on the apps domain's zone";

function saveErrorMessage(cause: unknown): string {
  return isApiError(cause, "reauth_required")
    ? `${errorMessage(cause)} Sign in again, then retry.`
    : errorMessage(cause);
}

// -----------------------------------------------------------------------------
// Account
// -----------------------------------------------------------------------------

function AccountForm({ settings }: { settings: InstanceCloudflare }) {
  const save = useSaveInstanceCloudflare();
  const remove = useDeleteInstanceCloudflare();
  const [replacing, setReplacing] = useState(false);
  const [accountId, setAccountId] = useState(settings.account_id ?? "");
  const [token, setToken] = useState("");
  const [proxied, setProxied] = useState(settings.apps_domain_proxied);
  const proxiedId = useId();
  const [errors, setErrors] = useState<{ accountId?: string; token?: string }>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const editing = !settings.configured || replacing;
  const dirty =
    token !== "" ||
    accountId.trim().toLowerCase() !== (settings.account_id ?? "") ||
    proxied !== settings.apps_domain_proxied;

  function reset() {
    setAccountId(settings.account_id ?? "");
    setToken("");
    setProxied(settings.apps_domain_proxied);
    setErrors({});
    setSaveError(null);
    setReplacing(false);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const id = accountId.trim().toLowerCase();
    const next: typeof errors = {};
    if (!ACCOUNT_ID.test(id)) {
      next.accountId = "Enter the 32-character account ID from the dashboard's sidebar.";
    }
    if (token.trim().length < 20) next.token = "Enter the API token.";
    setErrors(next);
    if (next.accountId || next.token) return;
    setSaveError(null);
    save.mutate(
      { account_id: id, api_token: token.trim(), apps_domain_proxied: proxied },
      {
        onSuccess: (saved) => {
          setToken("");
          setReplacing(false);
          setAccountId(saved.account_id ?? id);
          toast({ title: "Cloudflare account connected", tone: "success" });
        },
        onError: (cause) => setSaveError(saveErrorMessage(cause)),
      },
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate aria-label="Cloudflare account">
      <SettingsSection
        title="Account"
        description={
          <>
            Services set to run on Cloudflare deploy to this account as a Worker with a container.
            Create an API token with {CLOUDFLARE_TOKEN_PERMISSIONS}.
          </>
        }
        actions={
          <Badge tone={settings.configured ? "success" : "neutral"}>
            {settings.configured ? "Connected" : "Not set up"}
          </Badge>
        }
      >
        {settings.configured ? (
          <>
            <SettingsRow label="Account ID">
              <p className="truncate font-mono text-sm text-foreground md:text-right">
                {settings.account_id}
              </p>
            </SettingsRow>
            <SettingsRow
              label="API token"
              description={
                <>
                  Stored sealed and never shown.
                  {settings.validated_at ? (
                    <>
                      {" "}
                      Validated{" "}
                      <span title={formatTimestamp(settings.validated_at)}>
                        {formatRelativeTime(settings.validated_at)}
                      </span>
                      .
                    </>
                  ) : null}
                </>
              }
            >
              <div className="flex flex-wrap items-center gap-2 md:justify-end">
                <span className="font-mono text-sm text-muted-foreground">
                  {settings.token_hint ? `…${settings.token_hint}` : "set"}
                </span>
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
          </>
        ) : null}
        {editing ? (
          <>
            <SettingsField
              label="Account ID"
              description="In the Cloudflare dashboard's sidebar, under Account details."
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              placeholder="0123456789abcdef0123456789abcdef"
              error={errors.accountId}
              autoComplete="off"
              inputClassName="font-mono"
              spellCheck={false}
            />
            <SettingsField
              label="API token"
              description="Stored write-only; it is never shown again. Saving checks its permissions."
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              error={errors.token}
              autoComplete="new-password"
              inputClassName="font-mono"
            />
            <SettingsRow
              label="Apps domain is proxied"
              description="Turn on once the apps domain's wildcard DNS record is proxied (orange cloud) in Cloudflare: Worker routes only run on proxied hostnames."
              htmlFor={proxiedId}
              control="switch"
            >
              <Switch
                id={proxiedId}
                aria-describedby={`${proxiedId}-description`}
                checked={proxied}
                onCheckedChange={setProxied}
              />
            </SettingsRow>
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
          saveLabel={settings.configured ? "Replace token" : "Connect account"}
          onDiscard={reset}
        />
      ) : null}
      <ConfirmDialog
        open={removing}
        onOpenChange={(open) => {
          setRemoving(open);
          if (!open) remove.reset();
        }}
        title="Remove the Cloudflare account?"
        description="Its token is deleted. Services running on Cloudflare keep serving, but they can't be deployed, scaled or switched back to nodes until an account is connected again."
        confirmLabel="Remove account"
        destructive
        pending={remove.isPending}
        error={remove.isError ? saveErrorMessage(remove.error) : null}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => {
              setRemoving(false);
              reset();
              toast({ title: "Cloudflare account removed", tone: "success" });
            },
          })
        }
      />
    </form>
  );
}

// -----------------------------------------------------------------------------
// Verification
// -----------------------------------------------------------------------------

function VerifySection() {
  const verify = useVerifyInstanceCloudflare();
  const result = verify.data;
  return (
    <SettingsSection
      title="Verification"
      description="Checks the stored token's permissions and the apps zone again, without changing anything."
      actions={
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={verify.isPending}
          onClick={() => verify.mutate()}
        >
          Verify
        </Button>
      }
    >
      {verify.isError ? (
        <p role="alert" className="py-3 text-sm text-danger">
          {errorMessage(verify.error)}
        </p>
      ) : null}
      {result ? (
        <ul aria-label="Verification checks" className="divide-y divide-border/70">
          {result.checks.map((check) => (
            <li key={check.name} className="flex items-start gap-2.5 py-3 text-sm">
              {check.ok ? (
                <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              ) : (
                <CircleXIcon className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
              )}
              <span className="min-w-0">
                <span className="font-medium text-foreground">{check.name}</span>
                <span className="sr-only">{check.ok ? " passed" : " failed"}</span>
                <span className="block text-[13px] text-muted-foreground">{check.message}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {result ? (
        <p role="status" className={`py-3 text-sm ${result.ok ? "text-success" : "text-danger"}`}>
          {result.ok ? "Every check passed." : "Some checks failed; fix them in Cloudflare."}
        </p>
      ) : null}
    </SettingsSection>
  );
}

// -----------------------------------------------------------------------------
// Routing and storage
// -----------------------------------------------------------------------------

function RoutingSection({ settings }: { settings: InstanceCloudflare }) {
  const domains = useInstanceDomains();
  const appsDomain = domains.data?.apps_domain ?? null;
  const zone = settings.apps_zone;
  const belowApex = appsDomain && zone && appsDomain !== zone;
  return (
    <SettingsSection
      title="Routing"
      description="Worker routes send each Cloudflare service's hostnames to its Worker. They only run on hostnames Cloudflare proxies."
    >
      <SettingsRow
        label="Apps domain proxied"
        description={
          <>
            Confirmed when connecting the account; change it with Replace token.{" "}
            {belowApex ? (
              <>
                {appsDomain} is below the zone {zone}. Cloudflare's free edge certificate covers one
                level under the apex only, so *.{appsDomain} needs Advanced Certificate Manager on
                the zone.
              </>
            ) : zone ? (
              <>Worker routes are created in the zone {zone}.</>
            ) : (
              <>
                The apps domain isn't a zone in this account, so Worker routes can't be created.
                When it is below a zone's apex, its edge certificate needs Advanced Certificate
                Manager.
              </>
            )}
          </>
        }
      >
        <p className="text-sm md:text-right">
          <Badge tone={settings.apps_domain_proxied ? "success" : "warning"}>
            {settings.apps_domain_proxied ? "Proxied" : "Not proxied"}
          </Badge>
        </p>
      </SettingsRow>
      <SettingsRow
        label="workers.dev subdomain"
        description="Answers only signed warm-up requests, so it is not a second way in."
      >
        <p className="truncate font-mono text-sm text-foreground md:text-right">
          {settings.workers_subdomain
            ? `${settings.workers_subdomain}.workers.dev`
            : "Not known yet"}
        </p>
      </SettingsRow>
      <SettingsRow
        label="Image storage"
        description="Images pushed to Cloudflare's registry. Old tags are kept for rollbacks."
      >
        {settings.image_storage_bytes === null ? (
          <p className="text-sm text-muted-foreground md:text-right">Not known yet</p>
        ) : (
          <MeterRow
            label="Used"
            meterLabel="Image storage"
            percent={(settings.image_storage_bytes / CLOUDFLARE_IMAGE_STORAGE_LIMIT_BYTES) * 100}
            value={`${formatBytes(settings.image_storage_bytes)} of ${formatBytes(CLOUDFLARE_IMAGE_STORAGE_LIMIT_BYTES)}`}
          />
        )}
      </SettingsRow>
      <SettingsRow
        label="Edge gateway (experimental)"
        description="Lets Cloudflare services reach private services on nodes. Not available yet."
      >
        <p className="md:text-right">
          <Badge tone="neutral">Not available</Badge>
        </p>
      </SettingsRow>
    </SettingsSection>
  );
}

/**
 * Settings → Cloudflare. Instance admins only; everyone else sees why.
 *
 * @param props - Workspace id, for the settings frame.
 * @returns The page.
 */
export function CloudflarePage({ workspaceId }: { workspaceId: string }) {
  const { data: me } = useMe();
  const admin = canManageInstance(me);
  const settings = useInstanceCloudflare(admin);
  return (
    <SettingsFrame
      workspaceId={workspaceId}
      title="Cloudflare"
      description="Run app services on Cloudflare Containers instead of your servers. Shared by every workspace on this instance."
    >
      {!admin ? (
        <EmptyState
          icon={<ShieldIcon />}
          title="Cloudflare is set up by instance admins"
          description="The account and its token apply to the whole instance, so only instance admins can change them."
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
          <AccountForm settings={settings.data} />
          {settings.data.configured ? <VerifySection /> : null}
          {settings.data.configured ? <RoutingSection settings={settings.data} /> : null}
        </SettingsStack>
      )}
    </SettingsFrame>
  );
}
