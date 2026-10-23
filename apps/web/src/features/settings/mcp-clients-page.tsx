import {
  Button,
  CodeBlock,
  EmptyState,
  SettingsRow,
  SettingsSection,
  Skeleton,
  toast,
} from "@roundhouse/ui";
import { PlugIcon } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorState } from "../../components/error-state";
import { errorMessage } from "../../lib/api/client";
import type { ConnectedMcpClient } from "../../lib/api/oauth-types";
import { formatRelativeTime, formatTimestamp } from "../../lib/format";
import { useNow } from "../../lib/use-now";
import { useConnectedClients, useRevokeConnectedClient } from "../../queries/oauth";
import { SettingsFrame } from "./settings-frame";
import { summarizeScopes } from "./token-scopes";

function ClientRow({
  client,
  now,
  onDisconnect,
}: {
  client: ConnectedMcpClient;
  now: number;
  onDisconnect: () => void;
}) {
  return (
    <SettingsRow
      control="switch"
      label={
        <>
          {client.name}{" "}
          <span className="font-mono text-xs font-normal text-muted-foreground">
            {client.domain}
          </span>
        </>
      }
      description={
        <>
          {client.workspace.name} · {summarizeScopes(client.scopes)} · connected{" "}
          <time
            dateTime={new Date(client.created_at).toISOString()}
            title={formatTimestamp(client.created_at)}
          >
            {formatRelativeTime(client.created_at, now)}
          </time>
          {" · "}
          {client.last_used_at === null ? (
            "never used"
          ) : (
            <>
              last used{" "}
              <time
                dateTime={new Date(client.last_used_at).toISOString()}
                title={formatTimestamp(client.last_used_at)}
              >
                {formatRelativeTime(client.last_used_at, now)}
              </time>
            </>
          )}
        </>
      }
    >
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Disconnect ${client.name} from ${client.workspace.name}`}
        onClick={onDisconnect}
      >
        Disconnect
      </Button>
    </SettingsRow>
  );
}

/**
 * Settings → MCP clients: the coding agents and other MCP clients the signed-in user
 * has connected through OAuth, in every workspace, with what each may do and when it
 * was last used; disconnecting one ends its access at once. Also tells the user the URL
 * to give a client.
 *
 * @param props - Workspace id, for the settings navigation.
 * @returns The page.
 */
export function McpClientsPage({ workspaceId }: { workspaceId: string }) {
  const clients = useConnectedClients();
  const revoke = useRevokeConnectedClient();
  const [revoking, setRevoking] = useState<ConnectedMcpClient | null>(null);
  const now = useNow(60_000);
  const endpoint = `${window.location.origin}/mcp`;

  return (
    <SettingsFrame
      workspaceId={workspaceId}
      title="MCP clients"
      description="Coding agents you've connected to Roundhouse. Each acts as you, never with more than your role allows."
    >
      <div className="grid gap-10">
        <SettingsSection title="Connect a client">
          <SettingsRow
            label="Server URL"
            description="Add this URL to an MCP client. It opens a Roundhouse sign-in and asks which workspace and permissions to grant."
          >
            <CodeBlock code={endpoint} dense />
          </SettingsRow>
        </SettingsSection>
        <SettingsSection title="Connected">
          {clients.isPending ? (
            <Skeleton className="h-24" />
          ) : clients.isError ? (
            <ErrorState
              message={errorMessage(clients.error)}
              onRetry={() => void clients.refetch()}
            />
          ) : clients.data.length === 0 ? (
            <EmptyState
              icon={<PlugIcon />}
              title="No MCP clients connected"
              description="Clients you authorize appear here, in every workspace you belong to."
              className="py-10"
            />
          ) : (
            clients.data.map((client) => (
              <ClientRow
                key={client.id}
                client={client}
                now={now}
                onDisconnect={() => setRevoking(client)}
              />
            ))
          )}
        </SettingsSection>
      </div>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRevoking(null);
            revoke.reset();
          }
        }}
        title={`Disconnect ${revoking?.name ?? "client"}?`}
        description="Its access ends at once: the next request it makes is refused. To use it again, connect it from the client."
        confirmLabel="Disconnect"
        pending={revoke.isPending}
        error={revoke.isError ? errorMessage(revoke.error) : null}
        onConfirm={() => {
          if (!revoking) return;
          revoke.mutate(revoking.id, {
            onSuccess: () => {
              toast({ title: `Disconnected ${revoking.name}`, tone: "success" });
              setRevoking(null);
            },
          });
        }}
      />
    </SettingsFrame>
  );
}
