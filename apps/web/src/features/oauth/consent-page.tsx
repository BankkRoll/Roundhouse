import { API_TOKEN_PRESETS, type ApiTokenScope } from "@roundhouse/shared";
import { Button, Checkbox, Label, Select, Skeleton } from "@roundhouse/ui";
import { PlugIcon, TriangleAlertIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { AuthLayout } from "../../components/auth-layout";
import { errorMessage } from "../../lib/api/client";
import type { AuthorizationParams, OAuthConsent } from "../../lib/api/oauth-types";
import { useMe } from "../../queries/me";
import { useDecideOAuthConsent, useOAuthConsent } from "../../queries/oauth";
import { SCOPE_LABELS } from "../settings/token-scopes";

/** Props for {@link ConsentPage}. */
export interface ConsentPageProps {
  /** The authorization request, from the page URL. */
  params: AuthorizationParams;
  /** Leaves the dashboard for the client's redirect URI. Replaced in tests. */
  navigate?: (url: string) => void;
}

const READ_PRESET: readonly string[] = API_TOKEN_PRESETS.read;

/** The scopes ticked when a workspace is picked: its grantable read scopes, else all grantable. */
function defaultScopes(grantable: readonly ApiTokenScope[]): Set<ApiTokenScope> {
  const read = grantable.filter((s) => READ_PRESET.includes(s));
  return new Set(read.length ? read : grantable);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function ConsentForm({
  consent,
  params,
  navigate,
}: {
  consent: OAuthConsent;
  params: AuthorizationParams;
  navigate: (url: string) => void;
}) {
  const { data: me } = useMe();
  const decide = useDecideOAuthConsent();
  const workspaceFieldId = useId();
  const scopeIdPrefix = useId();
  const [workspaceId, setWorkspaceId] = useState(consent.workspaces[0]?.id ?? "");
  const workspace = consent.workspaces.find((w) => w.id === workspaceId);
  const grantable = workspace?.grantable_scopes ?? [];
  const [scopes, setScopes] = useState(() => defaultScopes(grantable));
  const [leaving, setLeaving] = useState(false);

  const pickWorkspace = (id: string) => {
    setWorkspaceId(id);
    setScopes(defaultScopes(consent.workspaces.find((w) => w.id === id)?.grantable_scopes ?? []));
  };
  const toggle = (scope: ApiTokenScope, on: boolean) =>
    setScopes((current) => {
      const next = new Set(current);
      if (on) next.add(scope);
      else next.delete(scope);
      return next;
    });

  const submit = (decision: "approve" | "deny") => {
    decide.mutate(
      {
        request: params,
        consent_token: consent.consent_token,
        decision,
        ...(decision === "approve"
          ? {
              workspace_id: workspaceId,
              scopes: consent.scopes.filter((s) => scopes.has(s)),
            }
          : {}),
      },
      {
        onSuccess: ({ redirect_to }) => {
          setLeaving(true);
          navigate(redirect_to);
        },
      },
    );
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit("approve");
  };

  if (consent.workspaces.length === 0) {
    return (
      <div className="grid gap-4">
        <p className="text-sm text-muted-foreground">
          You aren't a member of any workspace, so there is nothing to connect this app to.
        </p>
        <Button variant="secondary" onClick={() => submit("deny")} loading={decide.isPending}>
          Cancel and return to the app
        </Button>
      </div>
    );
  }

  return (
    <form className="grid gap-5" onSubmit={onSubmit}>
      {me ? (
        <p className="text-xs text-muted-foreground">
          Signed in as <span className="text-foreground">{me.user.email}</span>
        </p>
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor={workspaceFieldId}>Workspace</Label>
        <Select
          id={workspaceFieldId}
          value={workspaceId}
          onChange={(event) => pickWorkspace(event.target.value)}
        >
          {consent.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name} ({w.role})
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted-foreground">The app can only reach this workspace.</p>
      </div>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium text-foreground">Allow it to</legend>
        <ul aria-label="Permissions" className="grid gap-1 rounded-md border border-border p-2">
          {consent.scopes.map((scope) => {
            const allowed = grantable.includes(scope);
            const id = `${scopeIdPrefix}-${scope.replace(":", "-")}`;
            return (
              <li key={scope}>
                <label
                  htmlFor={id}
                  className="flex cursor-pointer items-start gap-2 rounded-sm px-1.5 py-1 text-sm text-foreground hover:bg-muted has-[:disabled]:cursor-not-allowed has-[:disabled]:text-muted-foreground has-[:disabled]:hover:bg-transparent"
                  title={allowed ? scope : `${scope}: your role here can't grant this`}
                >
                  <Checkbox
                    id={id}
                    checked={allowed && scopes.has(scope)}
                    disabled={!allowed}
                    onChange={(event) => toggle(scope, event.target.checked)}
                    className="mt-1"
                  />
                  <span>
                    {SCOPE_LABELS[scope]}
                    {allowed ? null : (
                      <span className="text-xs"> (your role here can't grant this)</span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-muted-foreground">
          It never gets more than your role allows, and loses access if your role changes. You can
          disconnect it at any time under Settings → MCP clients.
        </p>
      </fieldset>
      <p className="text-xs text-muted-foreground">
        Approving sends you back to{" "}
        <span className="font-mono text-foreground">{hostOf(consent.redirect_uri)}</span>.
      </p>
      {decide.isError ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(decide.error)}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="secondary"
          onClick={() => submit("deny")}
          disabled={decide.isPending || leaving}
        >
          Deny
        </Button>
        <Button
          type="submit"
          variant="primary"
          loading={decide.isPending || leaving}
          disabled={scopes.size === 0 || !workspace}
        >
          Authorize
        </Button>
      </div>
    </form>
  );
}

/**
 * The consent screen an MCP client's sign-in lands on (`/authorize`): who is asking (name,
 * logo and, always, the domain its identity is served from), a workspace picker, and the
 * permissions to grant, limited to what the user's role there allows. Approving or denying
 * returns the browser to the client.
 *
 * @param props - The authorization request and, in tests, a navigation stub.
 * @returns The page.
 */
export function ConsentPage({
  params,
  navigate = (url) => window.location.assign(url),
}: ConsentPageProps) {
  const consent = useOAuthConsent(params);

  if (consent.isPending) {
    return (
      <AuthLayout title="Connect an app" width={480}>
        <Skeleton className="h-64" />
      </AuthLayout>
    );
  }
  if (consent.isError) {
    return (
      <AuthLayout title="This sign-in link can't be used" width={480}>
        <div role="alert" className="flex items-start gap-2 text-sm text-muted-foreground">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" />
          <p>{errorMessage(consent.error)} Start signing in again from the app.</p>
        </div>
      </AuthLayout>
    );
  }

  const { client } = consent.data;
  return (
    <AuthLayout
      width={480}
      title={`Connect ${client.name}`}
      description={
        <div className="flex items-center gap-3">
          {client.logo_uri ? (
            <img
              src={client.logo_uri}
              alt=""
              referrerPolicy="no-referrer"
              className="size-8 shrink-0 rounded-md border border-border object-contain"
            />
          ) : (
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border">
              <PlugIcon className="size-4" />
            </span>
          )}
          <p>
            An MCP client from <span className="font-mono text-foreground">{client.domain}</span>{" "}
            wants to act on your behalf in Roundhouse.
          </p>
        </div>
      }
    >
      <ConsentForm consent={consent.data} params={params} navigate={navigate} />
    </AuthLayout>
  );
}
