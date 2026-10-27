/**
 * Draining a server (ADR 0005, "Node lifecycle"), on its detail page: Drain moves the
 * server's stateless replicas to other servers and leaves it in maintenance, safe to
 * reboot; Resume takes it back into service. Shows the latest drain's moves and the
 * volume services that block it. Actions need `nodes:manage`.
 *
 * @module
 */
import {
  Badge,
  Button,
  Checkbox,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@roundhouse/ui";
import { PlayIcon, WrenchIcon } from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { SectionHeader } from "../../components/section-header";
import { errorMessage, isApiError } from "../../lib/api/client";
import type { NodeDrain } from "../../lib/api/mesh-client";
import type { Node } from "../../lib/api/types";
import { EMPTY, formatRelativeTime } from "../../lib/format";
import { useDrainNode, useNodeDrain, useResumeNode } from "../../queries/mesh";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

/** How each drain status reads. */
export const DRAIN_STATUS_META: Record<NodeDrain["status"], { label: string; tone: Tone }> = {
  running: { label: "Draining", tone: "info" },
  blocked: { label: "Blocked", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
  completed: { label: "Drained", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

/** How each move state reads. */
export const MOVE_STATE_META: Record<
  NodeDrain["moves"][number]["state"],
  { label: string; tone: Tone }
> = {
  pending: { label: "Waiting", tone: "neutral" },
  moving: { label: "Moving", tone: "info" },
  done: { label: "Moved", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  stopped: { label: "Stopped", tone: "warning" },
};

/** Why a drain or resume was refused, in words. */
function drainErrorMessage(err: unknown): string {
  if (isApiError(err) && err.code === "drain_in_progress")
    return "This server is already draining.";
  if (isApiError(err) && err.code === "node_not_drainable") {
    return "This server hasn't connected yet, so there is nothing to drain.";
  }
  if (isApiError(err) && err.code === "node_not_draining") return "This server isn't drained.";
  return errorMessage(err);
}

/**
 * The server's maintenance controls and its latest drain.
 *
 * @param props - The workspace, the server, whether the caller may manage servers, and now.
 */
export function DrainSection({
  workspaceId,
  node,
  canManage,
  now,
}: {
  workspaceId: string;
  node: Node;
  canManage: boolean;
  now: number;
}) {
  const drain = useNodeDrain(workspaceId, node.id);
  const start = useDrainNode(workspaceId, node.id);
  const resume = useResumeNode(workspaceId, node.id);
  const [confirming, setConfirming] = useState(false);
  const [force, setForce] = useState(false);
  const forceId = useId();
  const current = drain.data?.drain ?? null;
  const out = node.status === "draining" || node.status === "maintenance";
  const services = new Map(current?.blocked.map((b) => [b.service_id, b.service_name]) ?? []);

  return (
    <section aria-labelledby="drain-heading">
      <SectionHeader
        id="drain-heading"
        title="Maintenance"
        meta={
          current ? (
            <Badge tone={DRAIN_STATUS_META[current.status].tone}>
              {DRAIN_STATUS_META[current.status].label}
            </Badge>
          ) : undefined
        }
        action={
          canManage ? (
            out ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={resume.isPending}
                onClick={() =>
                  resume.mutate(undefined, {
                    onSuccess: () =>
                      toast({ title: `${node.name} is back in service`, tone: "success" }),
                    onError: (err) => toast({ title: drainErrorMessage(err), tone: "error" }),
                  })
                }
              >
                <PlayIcon />
                Resume
              </Button>
            ) : (
              <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
                <WrenchIcon />
                Drain
              </Button>
            )
          ) : undefined
        }
      />
      <p className="mb-4 text-sm text-muted-foreground">
        {node.status === "maintenance"
          ? "Drained and safe to reboot. New replicas don't land here until it is resumed."
          : node.status === "draining"
            ? "Taking no new replicas while its replicas move to other servers."
            : "Draining moves this server's replicas to other servers and leaves it safe to reboot."}
      </p>
      {current?.status === "blocked" && current.blocked.length > 0 ? (
        <div role="alert" className="mb-4 grid gap-1 text-sm">
          <p className="text-warning">
            These services keep their data on this server, so they don't move on their own:
          </p>
          <ul className="list-disc pl-5 text-foreground">
            {current.blocked.map((b) => (
              <li key={`${b.service_id}:${b.environment_id}`}>{b.service_name}</li>
            ))}
          </ul>
          <p className="text-muted-foreground">
            Move each volume to another server from the service's Volume settings, or drain with
            "Stop services with volumes" to stop them for the maintenance.
          </p>
        </div>
      ) : null}
      {current?.error ? (
        <p role="alert" className="mb-4 text-sm text-danger">
          {current.error}
        </p>
      ) : null}
      {current && current.moves.length > 0 ? (
        <Table stack aria-label="Replica moves">
          <TableHeader>
            <TableRow>
              <TableHead>Replica</TableHead>
              <TableHead>State</TableHead>
              <TableHead>To</TableHead>
              <TableHead>Note</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {current.moves.map((m) => (
              <TableRow key={m.workload_id}>
                <TableCell>
                  {services.get(m.service_id) ?? m.service_id} #{m.replica}
                </TableCell>
                <TableCell>
                  <Badge tone={MOVE_STATE_META[m.state].tone}>
                    {MOVE_STATE_META[m.state].label}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{m.to_node_id ?? EMPTY}</TableCell>
                <TableCell className="text-muted-foreground">{m.error ?? EMPTY}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : current ? (
        <p className="text-sm text-muted-foreground">
          Started {formatRelativeTime(current.started_at, now)}; no replicas had to move.
        </p>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          if (!open) {
            start.reset();
            setForce(false);
          }
        }}
        title={`Drain ${node.name}?`}
        description={`${node.name} stops taking new replicas. Its stateless replicas move to other servers, each removed here only once its replacement is healthy, and it ends in maintenance, safe to reboot.`}
        confirmLabel="Drain server"
        destructive={false}
        pending={start.isPending}
        error={start.isError ? drainErrorMessage(start.error) : null}
        onConfirm={() =>
          start.mutate(force, {
            onSuccess: () => {
              setConfirming(false);
              toast({ title: `Draining ${node.name}`, tone: "success" });
            },
          })
        }
      >
        <div className="flex items-start gap-2">
          <Checkbox
            id={forceId}
            checked={force}
            onChange={(event) => setForce(event.target.checked)}
            className="mt-0.5"
          />
          <label htmlFor={forceId} className="cursor-pointer text-sm text-foreground">
            Stop services with volumes
            <span className="block text-xs text-muted-foreground">
              Their data stays on this server; they are stopped and marked degraded until it is
              resumed.
            </span>
          </label>
        </div>
      </ConfirmDialog>
    </section>
  );
}
