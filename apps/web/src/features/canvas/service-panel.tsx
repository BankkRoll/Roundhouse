import { isReservedBuildName, type PresenceEditPart } from "@roundhouse/shared";
import { Badge, Button, Checkbox, Label, StatusBadge } from "@roundhouse/ui";
import { Link } from "@tanstack/react-router";
import { ExternalLinkIcon, Trash2Icon, XIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { FormField } from "../../components/form-field";
import type { CanvasEdge, CanvasNode, StagedOpInput } from "../../lib/api/changes-types";
import { errorMessage } from "../../lib/api/client";
import { useServiceConfig } from "../../queries/services";
import { useServiceVariables } from "../../queries/variables";
import type { ServiceView } from "../projects/service-list";
import { ConnectionsSection, DomainsSection, VolumeSection } from "./service-resources";

/** Props for {@link ServicePanel}. */
export interface ServicePanelProps {
  workspaceId: string;
  projectId: string;
  environmentId: string;
  envParam?: string;
  node: CanvasNode;
  view: ServiceView | undefined;
  /** May stage config and service changes. */
  canManageServices: boolean;
  /** May stage variable changes. */
  canManageVariables: boolean;
  /** Stages ops in order; with `apply`, applies the whole draft afterwards. */
  onStage: (ops: StagedOpInput[], options: { apply: boolean }) => Promise<void>;
  /** Removes a staged creation (for `new:<n>` nodes). */
  onUnstageCreate?: () => void;
  onClose: () => void;
  /** Draft size, so "Apply now" can say it applies everything staged. */
  stagedCount: number;
  /**
   * The workspace stages canvas edits (`staged_changes`). Off, every edit here is
   * applied as it is saved, like the service's own pages.
   */
  staging?: boolean;
  /** Every node and edge of the canvas, for the connections section. */
  nodes?: readonly CanvasNode[];
  edges?: readonly CanvasEdge[];
  /** Draws a "connects to" edge from this service. */
  onAddEdge?: (to: string) => Promise<unknown>;
  onRemoveEdge?: (edgeId: string) => Promise<unknown>;
  /** The part of the service being edited changed (for presence). */
  onEditing?: (part: PresenceEditPart | null) => void;
}

interface ConfigForm {
  replicas: string;
  cpu: string;
  memory: string;
  start: string;
}

/** The quick-add variable form; a `null` flag follows what is stored for the key. */
const EMPTY_VAR: {
  key: string;
  value: string;
  secret: boolean;
  confirm: boolean;
  build: boolean | null;
  file: boolean | null;
} = { key: "", value: "", secret: false, confirm: false, build: null, file: null };

/**
 * Side panel for one service on the canvas: its status, a few quick config edits and a
 * new variable. Edits stage into the environment's draft; "Apply now" stages them and
 * applies the draft in one step (ADR 0006: single edits can be applied from the drawer).
 * Everything else lives on the service's own pages, linked from the header.
 *
 * @param props - The node, its live state, permissions and handlers.
 * @returns The panel.
 */
export function ServicePanel({
  workspaceId,
  projectId,
  environmentId,
  envParam,
  node,
  view,
  canManageServices,
  canManageVariables,
  onStage,
  onUnstageCreate,
  onClose,
  stagedCount,
  staging = true,
  nodes = [],
  edges = [],
  onAddEdge,
  onRemoveEdge,
  onEditing,
}: ServicePanelProps) {
  const live = node.staged !== "create";
  const config = useServiceConfig(node.id, live ? environmentId : undefined);
  const variables = useServiceVariables(node.id, environmentId, live);
  const [form, setForm] = useState<ConfigForm | null>(null);
  const [variable, setVariable] = useState(EMPTY_VAR);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"stage" | "apply" | null>(null);
  const titleId = useId();
  const buildHintId = useId();
  const fileHintId = useId();
  const stored = variables.data?.find((v) => v.key === variable.key.trim());
  const flagKey = variable.key.trim() || "KEY";

  useEffect(() => {
    if (!config.data) return;
    setForm({
      replicas: String(config.data.deploy.replicas),
      cpu: String(config.data.resources.cpu_millis),
      memory: String(config.data.resources.memory_mb),
      start: config.data.deploy.start_command ?? "",
    });
  }, [config.data]);

  function pendingOps(): StagedOpInput[] | string {
    const ops: StagedOpInput[] = [];
    if (form && config.data) {
      const deploy: Record<string, unknown> = {};
      const resources: Record<string, unknown> = {};
      const int = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s) : Number.NaN);
      const replicas = int(form.replicas);
      const cpu = int(form.cpu);
      const memory = int(form.memory);
      if ([replicas, cpu, memory].some(Number.isNaN))
        return "Replicas, CPU and memory must be whole numbers";
      if (replicas !== config.data.deploy.replicas) deploy.replicas = replicas;
      if (form.start.trim() !== (config.data.deploy.start_command ?? "")) {
        if (!form.start.trim()) return "Clear the start command on the service's settings page";
        deploy.start_command = form.start.trim();
      }
      if (cpu !== config.data.resources.cpu_millis) resources.cpu_millis = cpu;
      if (memory !== config.data.resources.memory_mb) resources.memory_mb = memory;
      if (Object.keys(deploy).length || Object.keys(resources).length) {
        ops.push({
          type: "config.patch",
          service: node.id,
          patch: {
            ...(Object.keys(deploy).length ? { deploy } : {}),
            ...(Object.keys(resources).length ? { resources } : {}),
          },
        });
      }
    }
    if (variable.key.trim() || variable.value) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.key.trim()))
        return "Variable names look like DATABASE_URL";
      if (variable.secret && !variable.confirm)
        return "Confirm that the secret can never be read back";
      if (variable.build && isReservedBuildName(variable.key.trim()))
        return `${variable.key.trim()} is reserved for the builder's own environment and can't be passed to a build`;
      ops.push({
        type: "variable.set",
        scope: "service",
        service: node.id,
        key: variable.key.trim(),
        value: variable.value,
        ...(variable.secret ? { tier: "secret" as const, confirm_write_only: true } : {}),
        ...(variable.build !== null ? { available_at_build: variable.build } : {}),
        ...(variable.file !== null ? { mount_as_file: variable.file } : {}),
      });
    }
    return ops;
  }

  async function submit(apply: boolean) {
    const ops = pendingOps();
    if (typeof ops === "string") {
      setError(ops);
      return;
    }
    if (!ops.length && !apply) {
      setError("Nothing changed");
      return;
    }
    setError(null);
    setBusy(apply ? "apply" : "stage");
    try {
      await onStage(ops, { apply });
      setVariable(EMPTY_VAR);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void submit(!staging);
  }

  const commit = (ops: StagedOpInput[]) => onStage(ops, { apply: !staging });
  const editing = (part: PresenceEditPart) => () => onEditing?.(part);

  const set = (key: keyof ConfigForm) => (event: { target: { value: string } }) =>
    setForm((f) => (f ? { ...f, [key]: event.target.value } : f));

  return (
    <aside
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      className="flex max-h-full w-full flex-col overflow-hidden rounded-md border border-border-strong bg-surface shadow-2xl shadow-black/30"
    >
      <header className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-sm font-semibold text-foreground">
            {node.name}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{node.slug}</span>
            <span>
              {node.database ? `${node.database.engine} ${node.database.version}` : node.kind}
            </span>
            {node.staged === "create" ? <Badge tone="accent">staged for creation</Badge> : null}
            {node.staged === "delete" ? <Badge tone="danger">staged for deletion</Badge> : null}
            {view?.latest ? <StatusBadge status={view.latest.status} kind="deployment" /> : null}
          </p>
        </div>
        {live ? (
          <Button asChild variant="ghost" size="icon-sm">
            <Link
              to="/w/$workspaceId/p/$projectId/s/$serviceId"
              params={{ workspaceId, projectId, serviceId: node.id }}
              search={{ env: envParam }}
              aria-label={`Open ${node.name}`}
            >
              <ExternalLinkIcon />
            </Link>
          </Button>
        ) : null}
        <Button variant="ghost" size="icon-sm" aria-label="Close panel" onClick={onClose}>
          <XIcon />
        </Button>
      </header>

      {live ? (
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="grid flex-1 gap-5 overflow-y-auto px-4 py-4">
            <fieldset
              className="grid gap-3"
              disabled={!canManageServices || !form}
              onFocus={editing("config")}
            >
              <legend className="mb-2 font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
                Deploy
              </legend>
              <div className="grid grid-cols-3 gap-3">
                <FormField
                  label="Replicas"
                  inputMode="numeric"
                  value={form?.replicas ?? ""}
                  onChange={set("replicas")}
                />
                <FormField
                  label="CPU (m)"
                  inputMode="numeric"
                  value={form?.cpu ?? ""}
                  onChange={set("cpu")}
                />
                <FormField
                  label="Memory (MB)"
                  inputMode="numeric"
                  value={form?.memory ?? ""}
                  onChange={set("memory")}
                />
              </div>
              <FormField
                label="Start command"
                value={form?.start ?? ""}
                onChange={set("start")}
                inputClassName="font-mono"
                placeholder="From the image"
              />
            </fieldset>

            <fieldset
              className="grid gap-3"
              disabled={!canManageVariables}
              onFocus={editing("variables")}
            >
              <legend className="mb-2 font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
                Add a variable
              </legend>
              {variables.data?.length ? (
                <p className="text-xs text-muted-foreground">
                  Has {variables.data.map((v) => v.key).join(", ")}. Setting an existing key
                  replaces it.
                </p>
              ) : null}
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField
                  label="Name"
                  value={variable.key}
                  onChange={(e) => setVariable((v) => ({ ...v, key: e.target.value }))}
                  inputClassName="font-mono"
                  placeholder="DATABASE_URL"
                  autoComplete="off"
                />
                <FormField
                  label="Value"
                  type={variable.secret ? "password" : "text"}
                  value={variable.value}
                  onChange={(e) => setVariable((v) => ({ ...v, value: e.target.value }))}
                  inputClassName="font-mono"
                  placeholder="${{db.DATABASE_URL}}"
                  autoComplete="off"
                />
              </div>
              <div className="grid gap-2">
                <Label className="flex items-center gap-2 font-normal">
                  <Checkbox
                    checked={variable.secret}
                    onChange={(e) =>
                      setVariable((v) => ({ ...v, secret: e.target.checked, confirm: false }))
                    }
                  />
                  Secret (write-only)
                </Label>
                {variable.secret ? (
                  <Label className="flex items-center gap-2 font-normal text-warning">
                    <Checkbox
                      checked={variable.confirm}
                      onChange={(e) => setVariable((v) => ({ ...v, confirm: e.target.checked }))}
                    />
                    Nobody can read this value back, including you
                  </Label>
                ) : null}
                <Label className="flex items-start gap-2 font-normal">
                  <Checkbox
                    className="mt-0.5"
                    checked={variable.build ?? stored?.available_at_build ?? false}
                    aria-describedby={buildHintId}
                    onChange={(e) => setVariable((v) => ({ ...v, build: e.target.checked }))}
                  />
                  <span className="grid gap-0.5">
                    Available at build
                    <span id={buildHintId} className="text-xs text-muted-foreground">
                      {variable.secret
                        ? `A BuildKit secret, read with RUN --mount=type=secret,id=${flagKey}; never in image layers or fork and PR preview builds.`
                        : "A build arg, recorded in the image, so it can't reference a secret."}
                    </span>
                  </span>
                </Label>
                <Label className="flex items-start gap-2 font-normal">
                  <Checkbox
                    className="mt-0.5"
                    checked={variable.file ?? stored?.mount_as_file ?? false}
                    aria-describedby={fileHintId}
                    onChange={(e) => setVariable((v) => ({ ...v, file: e.target.checked }))}
                  />
                  <span className="grid gap-0.5">
                    Mount as file
                    <span id={fileHintId} className="text-xs text-muted-foreground">
                      A read-only file at /run/secrets/{flagKey} instead of an environment variable,
                      kept out of docker inspect. No {flagKey}_FILE is injected.
                    </span>
                  </span>
                </Label>
              </div>
            </fieldset>

            {node.staged !== "delete" ? (
              <>
                <VolumeSection
                  node={node}
                  canManage={canManageServices}
                  commit={commit}
                  onFocus={editing("volume")}
                />
                <DomainsSection
                  node={node}
                  canManage={canManageServices}
                  commit={commit}
                  onFocus={editing("domains")}
                />
              </>
            ) : null}
            {onAddEdge && onRemoveEdge ? (
              <ConnectionsSection
                node={node}
                nodes={nodes}
                edges={edges}
                canManage={canManageServices}
                onAdd={onAddEdge}
                onRemove={onRemoveEdge}
                onFocus={editing("connections")}
              />
            ) : null}

            {canManageServices && node.staged !== "delete" ? (
              <div>
                <Button
                  variant="danger-outline"
                  size="sm"
                  onClick={() =>
                    // NOTE: Always staged, even with staging off: a deletion goes through
                    // the review panel rather than happening on one click.
                    void onStage([{ type: "service.delete", service_id: node.id }], {
                      apply: false,
                    }).catch((err) => setError(errorMessage(err)))
                  }
                >
                  <Trash2Icon />
                  Stage deletion
                </Button>
              </div>
            ) : null}
          </div>

          <footer className="grid gap-2 border-t border-border px-4 py-3">
            {error ? (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            ) : null}
            {staging ? null : (
              <div className="flex justify-end">
                <Button
                  type="submit"
                  variant="primary"
                  loading={busy === "apply"}
                  disabled={busy !== null || (!canManageServices && !canManageVariables)}
                >
                  Save
                </Button>
              </div>
            )}
            {staging ? (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  variant="secondary"
                  loading={busy === "apply"}
                  disabled={busy !== null || (!canManageServices && !canManageVariables)}
                  onClick={() => void submit(true)}
                  title={
                    stagedCount
                      ? `Also applies the ${stagedCount} change(s) already staged`
                      : undefined
                  }
                >
                  Apply now
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  loading={busy === "stage"}
                  disabled={busy !== null || (!canManageServices && !canManageVariables)}
                >
                  Stage
                </Button>
              </div>
            ) : null}
            {staging && stagedCount ? (
              <p className="text-right text-xs text-subtle-foreground">
                Apply now also applies the {stagedCount} change{stagedCount === 1 ? "" : "s"}{" "}
                already staged.
              </p>
            ) : null}
          </footer>
        </form>
      ) : (
        <div className="grid gap-3 px-4 py-4 text-sm text-muted-foreground">
          <p>This service is created when the staged changes are applied.</p>
          {onUnstageCreate ? (
            <div>
              <Button variant="secondary" size="sm" onClick={onUnstageCreate}>
                Remove from staged changes
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </aside>
  );
}
