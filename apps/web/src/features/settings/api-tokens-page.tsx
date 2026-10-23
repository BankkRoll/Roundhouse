import {
  Badge,
  Button,
  EmptyState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@openrail/ui";
import { KeyRoundIcon, LockIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorState } from "../../components/error-state";
import { errorMessage } from "../../lib/api/client";
import type { ApiToken } from "../../lib/api/deploy-types";
import { formatDuration, formatRelativeTime, formatTimestamp } from "../../lib/format";
import { usePermissions } from "../../lib/permissions";
import { useNow } from "../../lib/use-now";
import {
  type ApiTokenState,
  apiTokenState,
  useApiTokens,
  useRevokeApiToken,
} from "../../queries/tokens";
import { CreateTokenDialog } from "./create-token-dialog";
import { SettingsFrame } from "./settings-frame";
import { SCOPE_LABELS, summarizeScopes } from "./token-scopes";

const STATE_LABELS: Record<ApiTokenState, string> = {
  active: "Active",
  expired: "Expired",
  revoked: "Revoked",
};

const STATE_TONES: Record<ApiTokenState, "success" | "warning" | "neutral"> = {
  active: "success",
  expired: "warning",
  revoked: "neutral",
};

/** `name (tok_ab12…)`, which tells tokens with the same name apart. */
function tokenLabel(token: ApiToken): string {
  return token.prefix ? `${token.name} (${token.prefix}…)` : token.name;
}

function Expiry({ token, now }: { token: ApiToken; now: number }) {
  if (token.expires_at === null) return <>never</>;
  const remaining = token.expires_at - now;
  return (
    <time
      dateTime={new Date(token.expires_at).toISOString()}
      title={formatTimestamp(token.expires_at)}
    >
      {remaining > 0
        ? `in ${formatDuration(remaining).split(" ")[0]}`
        : formatRelativeTime(token.expires_at, now)}
    </time>
  );
}

function TokensTable({
  tokens,
  now,
  onRevoke,
}: {
  tokens: ApiToken[];
  now: number;
  onRevoke: (token: ApiToken) => void;
}) {
  return (
    <Table stack>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Name</TableHead>
          <TableHead>Permissions</TableHead>
          <TableHead className="hidden lg:table-cell">Created by</TableHead>
          <TableHead className="hidden md:table-cell">Last used</TableHead>
          <TableHead>Expires</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tokens.map((token) => {
          const state = apiTokenState(token, now);
          return (
            <TableRow key={token.id} data-state={state}>
              <TableCell cell="primary" className="max-w-0 min-w-40">
                <p className="truncate text-sm text-foreground">{token.name}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {token.prefix ? `${token.prefix}…` : "legacy token"}
                </p>
              </TableCell>
              <TableCell
                className="text-xs text-muted-foreground"
                title={token.scopes.map((scope) => SCOPE_LABELS[scope]).join("\n")}
              >
                {summarizeScopes(token.scopes)}
              </TableCell>
              <TableCell
                cell="hide-mobile"
                className="hidden text-xs text-muted-foreground lg:table-cell"
              >
                <span className="text-foreground">{token.created_by?.name ?? "Deleted user"}</span>
                <br />
                <time
                  dateTime={new Date(token.created_at).toISOString()}
                  title={formatTimestamp(token.created_at)}
                  className="tabular-nums"
                >
                  {formatRelativeTime(token.created_at, now)}
                </time>
              </TableCell>
              <TableCell
                className="hidden text-xs text-muted-foreground tabular-nums md:table-cell"
                title={formatTimestamp(token.last_used_at)}
              >
                {token.last_used_at === null
                  ? "never"
                  : formatRelativeTime(token.last_used_at, now)}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground tabular-nums">
                <Expiry token={token} now={now} />
              </TableCell>
              <TableCell>
                <Badge tone={STATE_TONES[state]}>{STATE_LABELS[state]}</Badge>
              </TableCell>
              <TableCell cell="action" className="text-right">
                {state === "revoked" ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Revoke ${tokenLabel(token)}`}
                    onClick={() => onRevoke(token)}
                  >
                    Revoke
                  </Button>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * Workspace settings → API tokens: every token with its permissions, creator, last use,
 * expiry and state; creating one (its secret shown once) and revoking with confirmation.
 * Only roles with `tokens:manage` see the list; the API enforces the same rule.
 *
 * @param props - Workspace id.
 * @returns The page.
 */
export function ApiTokensPage({ workspaceId }: { workspaceId: string }) {
  const { can, role } = usePermissions(workspaceId);
  const allowed = can("tokens:manage");
  const tokens = useApiTokens(workspaceId, allowed);
  const revoke = useRevokeApiToken(workspaceId);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const now = useNow(60_000);
  const active = tokens.data?.filter((token) => apiTokenState(token, now) === "active").length;

  const createButton = (
    <Button variant="primary" onClick={() => setCreating(true)}>
      <PlusIcon />
      Create token
    </Button>
  );

  return (
    <SettingsFrame
      workspaceId={workspaceId}
      title="API tokens"
      description={
        active === undefined
          ? "Tokens let CI, scripts and the CLI call the API for this workspace."
          : `${active} active. Tokens let CI, scripts and the CLI call the API for this workspace.`
      }
      actions={allowed ? createButton : null}
    >
      {!allowed ? (
        role === undefined ? (
          <Skeleton className="h-48" />
        ) : (
          <EmptyState
            icon={<LockIcon />}
            title="API tokens are for owners and admins"
            description="Ask a workspace owner or admin for a token if a script or CI job needs to call the API."
          />
        )
      ) : tokens.isPending ? (
        <Skeleton className="h-48" />
      ) : tokens.isError ? (
        <ErrorState message={errorMessage(tokens.error)} onRetry={() => void tokens.refetch()} />
      ) : tokens.data.length === 0 ? (
        <EmptyState
          icon={<KeyRoundIcon />}
          title="No API tokens yet"
          description="Tokens let CI, scripts and the CLI call the API for this workspace with only the permissions you give them."
          action={createButton}
          className="py-16"
        />
      ) : (
        <TokensTable tokens={tokens.data} now={now} onRevoke={setRevoking} />
      )}
      <CreateTokenDialog workspaceId={workspaceId} open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRevoking(null);
            revoke.reset();
          }
        }}
        title={`Revoke ${revoking ? tokenLabel(revoking) : "token"}?`}
        description="Anything using it stops working at once: its next request is refused. This can't be undone; create a new token to restore access."
        confirmLabel="Revoke token"
        pending={revoke.isPending}
        error={revoke.isError ? errorMessage(revoke.error) : null}
        onConfirm={() => {
          if (!revoking) return;
          revoke.mutate(revoking.id, {
            onSuccess: () => {
              toast({ title: `Revoked ${revoking.name}`, tone: "success" });
              setRevoking(null);
            },
          });
        }}
      />
    </SettingsFrame>
  );
}
