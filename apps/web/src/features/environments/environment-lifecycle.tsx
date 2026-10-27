import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SettingsSection,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@roundhouse/ui";
import { Switch } from "@roundhouse/ui/controls";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorState } from "../../components/error-state";
import { errorMessage } from "../../lib/api/client";
import type { Environment } from "../../lib/api/deploy-types";
import type { EnvironmentDiff } from "../../lib/api/environments-client";
import { useProjectPermissions } from "../../lib/permissions";
import {
  useCreateEnvironment,
  useDeleteEnvironment,
  useEnvironmentDiff,
  usePromoteEnvironment,
} from "../../queries/environments";

/** Props for {@link EnvironmentLifecycle}. */
export interface EnvironmentLifecycleProps {
  workspaceId: string;
  projectId: string;
  environments: readonly Environment[];
}

const CHANGE_TONE = {
  added: "success",
  removed: "danger",
  changed: "warning",
  same: "neutral",
} as const;

/**
 * A project's environments with their lifecycle (ADR 0007): create blank or as a
 * clone, compare two, propose promoting one into another (a change set to review), and
 * delete one by typing its slug. Production can never be deleted.
 *
 * @param props - Ids and the project's environments.
 * @returns The section.
 */
export function EnvironmentLifecycle({
  workspaceId,
  projectId,
  environments,
}: EnvironmentLifecycleProps) {
  const permissions = useProjectPermissions(workspaceId, projectId);
  const canManage = permissions.loaded && permissions.can("environments:manage");
  const [creating, setCreating] = useState(false);
  const [comparing, setComparing] = useState<Environment | null>(null);
  const [promoting, setPromoting] = useState<Environment | null>(null);
  const [deleting, setDeleting] = useState<Environment | null>(null);
  const remove = useDeleteEnvironment(projectId);

  return (
    <SettingsSection
      title="Manage environments"
      description="Clone an environment to try a change, compare two, then promote the tested one, exact images included."
      actions={
        canManage ? (
          <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
            New environment
          </Button>
        ) : null
      }
    >
      <Table aria-label="Environments">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {environments.map((env) => (
            <TableRow key={env.id}>
              <TableCell>
                <span className="font-medium text-foreground">{env.name}</span>{" "}
                <span className="font-mono text-xs text-muted-foreground">{env.slug}</span>
              </TableCell>
              <TableCell>
                <Badge tone={env.kind === "production" ? "accent" : "neutral"}>{env.kind}</Badge>
                {env.protected ? (
                  <Badge tone="info" className="ml-1.5">
                    protected
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-1.5">
                  {environments.length > 1 ? (
                    <Button size="sm" variant="ghost" onClick={() => setComparing(env)}>
                      Compare
                    </Button>
                  ) : null}
                  {canManage && environments.length > 1 ? (
                    <Button size="sm" variant="ghost" onClick={() => setPromoting(env)}>
                      Promote into
                    </Button>
                  ) : null}
                  {canManage && env.kind !== "production" ? (
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(env)}>
                      Delete
                    </Button>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <CreateDialog
        open={creating}
        onOpenChange={setCreating}
        projectId={projectId}
        environments={environments}
      />
      <CompareDialog
        target={comparing}
        onClose={() => setComparing(null)}
        projectId={projectId}
        environments={environments}
      />
      <PromoteDialog
        target={promoting}
        onClose={() => setPromoting(null)}
        workspaceId={workspaceId}
        projectId={projectId}
        environments={environments}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
            remove.reset();
          }
        }}
        title={`Delete ${deleting?.name ?? ""}?`}
        description="Its deployments stop, its domains go, and its volumes are deleted after a 72-hour grace period. A preview it belongs to closes."
        confirmLabel="Delete environment"
        confirmText={deleting?.slug}
        pending={remove.isPending}
        error={remove.isError ? errorMessage(remove.error) : null}
        onConfirm={() =>
          deleting &&
          remove.mutate(
            { environmentId: deleting.id, confirm: deleting.slug },
            {
              onSuccess: () => {
                toast({ title: `Deleted ${deleting.name}`, tone: "success" });
                setDeleting(null);
              },
            },
          )
        }
      />
    </SettingsSection>
  );
}

function CreateDialog({
  open,
  onOpenChange,
  projectId,
  environments,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  environments: readonly Environment[];
}) {
  const ids = { name: useId(), from: useId(), vars: useId(), volumes: useId() };
  const [name, setName] = useState("");
  const [from, setFrom] = useState("");
  const [variables, setVariables] = useState<"all" | "non_secret" | "none">("all");
  const [volumes, setVolumes] = useState<"empty" | "latest_backup">("empty");
  const create = useCreateEnvironment(projectId);
  const sources = environments.filter((env) => env.kind !== "preview");

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    create.mutate(
      {
        name: name.trim(),
        kind: "staging",
        ...(from ? { clone: { from_environment_id: from, variables, volumes } } : {}),
      },
      {
        onSuccess: (env) => {
          toast({ title: `Created ${env.name}`, tone: "success" });
          setName("");
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) create.reset();
      }}
    >
      <DialogContent>
        <form onSubmit={onSubmit} aria-label="New environment">
          <DialogHeader>
            <DialogTitle>New environment</DialogTitle>
            <DialogDescription>
              A clone copies configs and variables; every database starts empty with credentials of
              its own.
            </DialogDescription>
          </DialogHeader>
          <div className="my-4 grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={ids.name}>Name</Label>
              <Input
                id={ids.name}
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={100}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.from}>Copy from</Label>
              <Select id={ids.from} value={from} onChange={(event) => setFrom(event.target.value)}>
                <option value="">Nothing (blank)</option>
                {sources.map((env) => (
                  <option key={env.id} value={env.id}>
                    {env.name}
                  </option>
                ))}
              </Select>
            </div>
            {from ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor={ids.vars}>Variables</Label>
                  <Select
                    id={ids.vars}
                    value={variables}
                    onChange={(event) => setVariables(event.target.value as typeof variables)}
                  >
                    <option value="all">All, secrets included</option>
                    <option value="non_secret">Plain ones only</option>
                    <option value="none">None</option>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor={ids.volumes}>Databases</Label>
                  <Select
                    id={ids.volumes}
                    value={volumes}
                    onChange={(event) => setVolumes(event.target.value as typeof volumes)}
                  >
                    <option value="empty">Start empty</option>
                    <option value="latest_backup">Restore the latest dump</option>
                  </Select>
                </div>
              </>
            ) : null}
            {create.isError ? (
              <p role="alert" className="text-sm text-danger">
                {errorMessage(create.error)}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CompareDialog({
  target,
  onClose,
  projectId,
  environments,
}: {
  target: Environment | null;
  onClose: () => void;
  projectId: string;
  environments: readonly Environment[];
}) {
  const baseId = useId();
  const [base, setBase] = useState("");
  const others = environments.filter((env) => env.id !== target?.id);
  const chosen = base || others[0]?.id;
  const diff = useEnvironmentDiff(projectId, chosen, target?.id);
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Compare {target?.name}</DialogTitle>
          <DialogDescription>
            Secrets are compared by fingerprint; no value is shown.
          </DialogDescription>
        </DialogHeader>
        <div className="my-3 flex items-center gap-2">
          <Label htmlFor={baseId}>With</Label>
          <Select
            id={baseId}
            value={chosen ?? ""}
            onChange={(event) => setBase(event.target.value)}
            className="w-48"
          >
            {others.map((env) => (
              <option key={env.id} value={env.id}>
                {env.name}
              </option>
            ))}
          </Select>
        </div>
        {diff.isError ? (
          <ErrorState message={errorMessage(diff.error)} onRetry={() => void diff.refetch()} />
        ) : diff.data ? (
          <DiffView diff={diff.data} />
        ) : (
          <p className="text-sm text-muted-foreground">Comparing…</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The diff as one row per service: presence, changed config paths, variables that
 * differ, and both images.
 */
function DiffView({ diff }: { diff: EnvironmentDiff }) {
  const sharedChanges = diff.shared_variables.filter((v) => v.change !== "same");
  return (
    <div className="max-h-[60vh] overflow-auto">
      <Table aria-label="Differences">
        <TableHeader>
          <TableRow>
            <TableHead>Service</TableHead>
            <TableHead>Config</TableHead>
            <TableHead>Variables</TableHead>
            <TableHead>Image</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {diff.services.map((s) => {
            const vars = s.variables.filter((v) => v.change !== "same");
            return (
              <TableRow key={s.service_id}>
                <TableCell>
                  <span className="font-mono text-xs">{s.slug}</span>
                  {s.presence !== "both" ? (
                    <Badge tone="warning" className="ml-1.5">
                      {s.presence === "only_base" ? "only in base" : "only here"}
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {s.config.length ? s.config.map((e) => e.path).join(", ") : "same"}
                </TableCell>
                <TableCell>
                  {vars.length
                    ? vars.map((v) => (
                        <Badge key={v.key} tone={CHANGE_TONE[v.change]} className="mr-1">
                          {v.key} {v.change}
                          {v.secret ? " (secret)" : ""}
                        </Badge>
                      ))
                    : "same"}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {s.image.base === s.image.target ? "same" : "differs"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {sharedChanges.length ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Shared variables:{" "}
          {sharedChanges
            .map((v) => `${v.key} ${v.change}${v.secret ? " (secret)" : ""}`)
            .join(", ")}
        </p>
      ) : null}
    </div>
  );
}

function PromoteDialog({
  target,
  onClose,
  workspaceId,
  projectId,
  environments,
}: {
  target: Environment | null;
  onClose: () => void;
  workspaceId: string;
  projectId: string;
  environments: readonly Environment[];
}) {
  const navigate = useNavigate();
  const ids = { from: useId(), vars: useId(), config: useId(), image: useId() };
  const sources = environments.filter((env) => env.id !== target?.id);
  const [from, setFrom] = useState("");
  const [config, setConfig] = useState(true);
  const [image, setImage] = useState(true);
  const [variables, setVariables] = useState<"none" | "non_secret" | "all">("non_secret");
  const promote = usePromoteEnvironment(projectId);
  const source = from || sources.find((env) => env.kind !== "preview")?.id || sources[0]?.id;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!target || !source) return;
    promote.mutate(
      {
        environmentId: target.id,
        body: { from_environment_id: source, include: { config, variables, image } },
      },
      {
        onSuccess: (set) => {
          toast({
            title: `Proposed ${set.op_count} changes to ${target.name}`,
            description: "Review and apply them in Canvas.",
            tone: "success",
          });
          onClose();
          void navigate({ to: "/w/$workspaceId/canvas", params: { workspaceId } });
        },
      },
    );
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
          promote.reset();
        }
      }}
    >
      <DialogContent>
        <form onSubmit={onSubmit} aria-label="Promote">
          <DialogHeader>
            <DialogTitle>Promote into {target?.name}</DialogTitle>
            <DialogDescription>
              Proposes a change set to review; nothing changes until it is applied. Images are
              deployed as they are, without a rebuild.
            </DialogDescription>
          </DialogHeader>
          <div className="my-4 grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor={ids.from}>From</Label>
              <Select
                id={ids.from}
                value={source ?? ""}
                onChange={(event) => setFrom(event.target.value)}
              >
                {sources.map((env) => (
                  <option key={env.id} value={env.id}>
                    {env.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span id={ids.config}>Config</span>
              <Switch aria-labelledby={ids.config} checked={config} onCheckedChange={setConfig} />
            </div>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span id={ids.image}>Images</span>
              <Switch aria-labelledby={ids.image} checked={image} onCheckedChange={setImage} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor={ids.vars}>Variables</Label>
              <Select
                id={ids.vars}
                value={variables}
                onChange={(event) => setVariables(event.target.value as typeof variables)}
              >
                <option value="non_secret">Plain ones only</option>
                <option value="all">All, secrets included</option>
                <option value="none">None</option>
              </Select>
            </div>
            {promote.isError ? (
              <p role="alert" className="text-sm text-danger">
                {errorMessage(promote.error)}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={promote.isPending || !source}>
              Propose
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
