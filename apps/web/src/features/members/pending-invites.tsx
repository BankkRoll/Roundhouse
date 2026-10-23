import {
  Badge,
  Button,
  SectionLabel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@roundhouse/ui";
import { ErrorState } from "../../components/error-state";
import { errorMessage } from "../../lib/api/client";
import { formatDuration, formatTimestamp } from "../../lib/format";
import { useNow } from "../../lib/use-now";
import { useInvites, useRevokeInvite } from "../../queries/members";

/**
 * Pending invites with a revoke button. Only rendered for members who can manage.
 *
 * @param props - Workspace id.
 * @returns The section, an error with retry, or nothing when there are no pending invites.
 */
export function PendingInvites({ workspaceId }: { workspaceId: string }) {
  const invites = useInvites(workspaceId);
  const revoke = useRevokeInvite(workspaceId);
  const now = useNow(60_000);

  if (invites.isError) {
    return (
      <section aria-labelledby="pending-invites" className="mt-8">
        <SectionLabel id="pending-invites" className="mb-2">
          Pending invites
        </SectionLabel>
        <ErrorState
          title="Could not load pending invites"
          message={errorMessage(invites.error)}
          onRetry={() => void invites.refetch()}
        />
      </section>
    );
  }
  if (!invites.data || invites.data.length === 0) return null;

  return (
    <section aria-labelledby="pending-invites" className="mt-8">
      <SectionLabel id="pending-invites" className="mb-2">
        Pending invites
      </SectionLabel>
      <div className="rounded-lg border border-border bg-surface">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {invites.data.map((invite) => {
              const remaining = invite.expires_at - now;
              return (
                <TableRow key={invite.id}>
                  <TableCell className="font-mono text-xs">{invite.email}</TableCell>
                  <TableCell>
                    <Badge>{invite.role}</Badge>
                  </TableCell>
                  <TableCell
                    className="font-mono text-xs text-muted-foreground"
                    title={formatTimestamp(invite.expires_at)}
                  >
                    {remaining > 0 ? `in ${formatDuration(remaining)}` : "expired"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Revoke invite for ${invite.email}`}
                      disabled={revoke.isPending && revoke.variables === invite.id}
                      onClick={() =>
                        revoke.mutate(invite.id, {
                          onSuccess: () => toast({ title: "Invite revoked", tone: "success" }),
                          onError: (error) =>
                            toast({
                              title: "Could not revoke invite",
                              description: errorMessage(error),
                              tone: "error",
                            }),
                        })
                      }
                    >
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
