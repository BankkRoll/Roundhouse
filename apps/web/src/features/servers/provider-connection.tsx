import { PROVIDERS, type ProviderId } from "@roundhouse/providers";
import { Button } from "@roundhouse/ui";
import { CircleCheckIcon, ExternalLinkIcon } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { FormField } from "../../components/form-field";
import { errorMessage, isApiError } from "../../lib/api/client";
import type { ProviderIntegration } from "../../lib/api/providers-types";
import { formatRelativeTime } from "../../lib/format";
import { useConnectProvider, useDisconnectProvider } from "../../queries/providers";

/** Mirrors the API's `ConnectProviderSchema`: printable ASCII, 16-512 characters. */
function tokenError(token: string): string | null {
  if (token === "") return "Paste the API token.";
  if (token.length < 16 || token.length > 512 || !/^[\x21-\x7e]+$/.test(token)) {
    return "That doesn't look like a whole API token.";
  }
  return null;
}

function connectErrorMessage(error: unknown): string {
  if (isApiError(error, "reauth_required")) {
    return `${errorMessage(error)} Sign in again, then retry.`;
  }
  return errorMessage(error);
}

/** Props for {@link ProviderConnection}. */
export interface ProviderConnectionProps {
  /** Workspace the provider is connected to. */
  workspaceId: string;
  /** The provider's integration from the API. */
  integration: ProviderIntegration;
}

/**
 * A provider's connection as a settings row: who the token belongs to and its last four
 * characters, with Replace token and Disconnect, or the form that connects it.
 *
 * @param props - Workspace and the provider's integration.
 * @returns The row or form.
 */
export function ProviderConnection({ workspaceId, integration }: ProviderConnectionProps) {
  const [replacing, setReplacing] = useState(false);
  const disconnect = useDisconnectProvider(workspaceId);
  const provider = integration.provider;
  const name = PROVIDERS[provider].displayName;

  if (!integration.connected || replacing) {
    return (
      <ConnectForm
        // NOTE: Keyed so switching provider starts from an empty field and no stale error.
        key={provider}
        workspaceId={workspaceId}
        provider={provider}
        replacing={integration.connected}
        onCancel={() => setReplacing(false)}
        onConnected={() => setReplacing(false)}
      />
    );
  }

  const conflict = isApiError(disconnect.error, "conflict");
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="flex min-w-0 items-center gap-2 text-sm text-foreground">
          <CircleCheckIcon className="size-4 shrink-0 text-success" aria-hidden="true" />
          <span className="min-w-0 truncate">
            Connected as {integration.account_label ?? `a ${name} token`}
            <span className="font-mono text-muted-foreground"> · …{integration.token_last4}</span>
          </span>
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => setReplacing(true)}>
            Replace token
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={disconnect.isPending}
            onClick={() => disconnect.mutate({ provider })}
          >
            Disconnect
          </Button>
        </div>
      </div>
      {integration.last_validated_at !== null ? (
        <p className="text-xs text-subtle-foreground">
          Checked {formatRelativeTime(integration.last_validated_at)}
        </p>
      ) : null}
      {disconnect.isError ? (
        <div role="alert" className="grid gap-2 text-sm">
          <p className="text-danger">{errorMessage(disconnect.error)}</p>
          {conflict ? (
            <div>
              <Button
                size="sm"
                variant="danger-outline"
                loading={disconnect.isPending}
                onClick={() => disconnect.mutate({ provider, force: true })}
              >
                Disconnect anyway
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ConnectForm({
  workspaceId,
  provider,
  replacing,
  onCancel,
  onConnected,
}: {
  workspaceId: string;
  provider: ProviderId;
  replacing: boolean;
  onCancel: () => void;
  onConnected: () => void;
}) {
  const info = PROVIDERS[provider];
  const connect = useConnectProvider(workspaceId);
  // SECURITY: The token stays in the DOM input only (uncontrolled, never React state or
  // the query cache) and the field is emptied as soon as the provider accepts it.
  const input = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const field = input.current;
    if (!field) return;
    const token = field.value.trim();
    const problem = tokenError(token);
    setLocalError(problem);
    if (problem) return;
    connect.mutate(
      { provider, token: { value: token } },
      {
        onSuccess: () => {
          field.value = "";
          onConnected();
        },
      },
    );
  }

  const error = localError ?? (connect.isError ? connectErrorMessage(connect.error) : null);
  return (
    <form onSubmit={onSubmit} className="grid gap-3" aria-label={`Connect ${info.displayName}`}>
      <p className="text-sm text-muted-foreground">{info.tokenHint}</p>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>Needs</span>
        {info.requiredScopes.map((scope) => (
          <span
            key={scope}
            className="rounded-sm border border-border-strong px-1 font-mono text-[11px] text-foreground"
          >
            {scope}
          </span>
        ))}
      </div>
      <FormField
        ref={input}
        label={`${info.displayName} API token`}
        type="password"
        autoComplete="off"
        spellCheck={false}
        inputClassName="font-mono"
        error={error}
        hint="Stored encrypted and never shown again; only its last four characters are."
        onChange={() => {
          if (localError) setLocalError(null);
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <a
            href={info.tokenUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-accent-text hover:underline"
          >
            Create a token
            <ExternalLinkIcon className="size-3" aria-hidden="true" />
          </a>
          <a
            href={info.tokenDocsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
          >
            How to
            <ExternalLinkIcon className="size-3" aria-hidden="true" />
          </a>
        </div>
        <div className="flex gap-2">
          {replacing ? (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          ) : null}
          <Button size="sm" type="submit" variant="primary" loading={connect.isPending}>
            {replacing ? "Replace token" : `Connect ${info.displayName}`}
          </Button>
        </div>
      </div>
    </form>
  );
}
