/**
 * The resource sections of the canvas service panel: the service's volume, its custom
 * domains and its "connects to" edges. Volume and domain edits stage like every other
 * canvas edit (ADR 0006) and apply through the same checks as their direct routes;
 * connections are display data, saved at once.
 *
 * @module
 */

import { MAX_VOLUME_MB, MIN_VOLUME_MB, VOLUME_DELETE_GRACE_MS } from "@roundhouse/shared";
import { Badge, Button, Select } from "@roundhouse/ui";
import { ArrowRightIcon, LinkIcon, Trash2Icon, XIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { FormField } from "../../components/form-field";
import type { CanvasEdge, CanvasNode, StagedOpInput } from "../../lib/api/changes-types";
import { errorMessage } from "../../lib/api/client";

/** Stages (or, with staging off, applies) ops; rejects with the API's error. */
export type Commit = (ops: StagedOpInput[]) => Promise<void>;

const GRACE_HOURS = VOLUME_DELETE_GRACE_MS / 3_600_000;

function Section({
  title,
  onFocus,
  children,
}: {
  title: string;
  onFocus?: () => void;
  children: ReactNode;
}) {
  return (
    <fieldset className="grid gap-2.5" onFocus={onFocus}>
      <legend className="mb-2 font-mono text-[11px] tracking-wider text-muted-foreground uppercase">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

/** Runs an action and reports its error inline, so each section keeps its own state. */
function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, setError, busy, run };
}

function ActionError({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-xs text-danger">
      {error}
    </p>
  ) : null;
}

/**
 * The service's volume in the canvas's environment: add one, grow it, or delete it.
 * Volumes only grow; a deleted volume's data stays for {@link VOLUME_DELETE_GRACE_MS}
 * (72 h) and can be undeleted from the service's page until then.
 *
 * @param props - The node, whether the caller may change it, and how to commit.
 * @returns The section.
 */
export function VolumeSection({
  node,
  canManage,
  commit,
  onFocus,
}: {
  node: CanvasNode;
  canManage: boolean;
  commit: Commit;
  onFocus?: () => void;
}) {
  const volume = node.volume;
  const [mountPath, setMountPath] = useState("/data");
  const [size, setSize] = useState(String(volume?.staged_size_mb ?? volume?.size_mb ?? 1024));
  const action = useAction();
  const deleting = volume?.status === "pending_deletion";

  const sizeMb = Number(size);
  const sizeProblem =
    !/^\d+$/.test(size.trim()) || sizeMb < MIN_VOLUME_MB || sizeMb > MAX_VOLUME_MB
      ? `Size is a whole number of MiB from ${MIN_VOLUME_MB} to ${MAX_VOLUME_MB}`
      : volume && sizeMb < volume.size_mb
        ? `Volumes only grow; this one is ${volume.size_mb} MiB`
        : null;

  const stageSet = () => {
    if (sizeProblem) {
      action.setError(sizeProblem);
      return;
    }
    if (!volume && !mountPath.startsWith("/")) {
      action.setError("Mount paths are absolute, like /data");
      return;
    }
    void action.run(() =>
      commit([
        volume
          ? { type: "volume.set", service: node.id, size_mb: sizeMb }
          : { type: "volume.set", service: node.id, mount_path: mountPath, size_mb: sizeMb },
      ]),
    );
  };

  return (
    <Section title="Volume" onFocus={onFocus}>
      {volume ? (
        <div className="grid gap-1 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-foreground">{volume.mount_path}</span>
            <span className="text-muted-foreground">{volume.size_mb} MiB</span>
            {volume.status ? (
              <span className="text-xs text-muted-foreground">
                {volume.status.replace(/_/g, " ")}
              </span>
            ) : null}
            {volume.staged === "create" ? <Badge tone="accent">staged</Badge> : null}
            {volume.staged === "resize" ? (
              <Badge tone="accent">grows to {volume.staged_size_mb} MiB</Badge>
            ) : null}
            {volume.staged === "delete" ? <Badge tone="danger">staged for deletion</Badge> : null}
          </p>
          {deleting && volume.delete_after ? (
            <p className="text-xs text-warning">
              Deleted. Its data is removed after {new Date(volume.delete_after).toLocaleString()}{" "}
              unless it is undeleted on the service's page.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No volume in this environment.</p>
      )}
      {canManage && !deleting && volume?.staged !== "delete" ? (
        <div className="grid gap-2">
          <div className="grid grid-cols-2 gap-2">
            {volume ? null : (
              <FormField
                label="Mount path"
                value={mountPath}
                onChange={(e) => setMountPath(e.target.value)}
                inputClassName="font-mono"
              />
            )}
            <FormField
              label="Size (MiB)"
              inputMode="numeric"
              value={size}
              onChange={(e) => setSize(e.target.value)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" loading={action.busy} onClick={stageSet}>
              {volume ? "Grow volume" : "Add volume"}
            </Button>
            {volume?.id && volume.staged !== "create" ? (
              <Button
                size="sm"
                variant="danger-outline"
                disabled={action.busy}
                onClick={() =>
                  void action.run(() => commit([{ type: "volume.delete", service: node.id }]))
                }
                title={`Its data is kept for ${GRACE_HOURS} hours and can be undeleted until then`}
              >
                <Trash2Icon />
                Delete volume
              </Button>
            ) : null}
          </div>
          {volume?.id ? (
            <p className="text-xs text-subtle-foreground">
              A deleted volume's data is kept for {GRACE_HOURS} hours before it is removed.
            </p>
          ) : null}
        </div>
      ) : null}
      <ActionError error={action.error} />
    </Section>
  );
}

/**
 * The service's custom domains in the canvas's environment: add or remove them. The
 * same hostname rules and per-service cap as the Domains page apply when the change is
 * applied; DNS verification happens on the Domains page afterwards.
 *
 * @param props - The node, whether the caller may change it, and how to commit.
 * @returns The section.
 */
export function DomainsSection({
  node,
  canManage,
  commit,
  onFocus,
}: {
  node: CanvasNode;
  canManage: boolean;
  commit: Commit;
  onFocus?: () => void;
}) {
  const [hostname, setHostname] = useState("");
  const action = useAction();
  const add = () => {
    const value = hostname.trim();
    if (!value.includes(".")) {
      action.setError("Enter a hostname such as shop.example.com");
      return;
    }
    void action
      .run(() => commit([{ type: "domain.add", service: node.id, hostname: value }]))
      .then((ok) => {
        if (ok) setHostname("");
      });
  };
  return (
    <Section title="Custom domains" onFocus={onFocus}>
      {node.domains.length ? (
        <ul className="grid gap-1">
          {node.domains.map((d) => (
            <li key={d.id ?? `new:${d.hostname}`} className="flex items-center gap-2 text-sm">
              <span
                className={
                  d.staged === "remove"
                    ? "truncate font-mono text-muted-foreground line-through"
                    : "truncate font-mono text-foreground"
                }
              >
                {d.hostname}
              </span>
              {d.status ? (
                <span className="text-xs text-muted-foreground">{d.status.replace(/_/g, " ")}</span>
              ) : null}
              {d.staged === "add" ? <Badge tone="accent">staged</Badge> : null}
              {d.staged === "remove" ? <Badge tone="danger">staged removal</Badge> : null}
              {canManage && d.id && d.staged === null ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto"
                  aria-label={`Remove ${d.hostname}`}
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(() => commit([{ type: "domain.remove", domain_id: d.id! }]))
                  }
                >
                  <XIcon />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No custom domains in this environment.</p>
      )}
      {canManage ? (
        <div className="flex items-end gap-2">
          <FormField
            label="Add a domain"
            className="grid flex-1 content-start gap-1.5"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            inputClassName="font-mono"
            placeholder="shop.example.com"
            autoComplete="off"
          />
          <Button size="sm" variant="secondary" loading={action.busy} onClick={add}>
            Add
          </Button>
        </div>
      ) : null}
      <ActionError error={action.error} />
    </Section>
  );
}

/**
 * The service's explicit "connects to" edges: dependencies no variable reference shows,
 * such as a hard-coded URL or a queue. They are display data and change no networking,
 * so they are saved at once rather than staged.
 *
 * @param props - The node, the canvas's nodes and edges, permissions and handlers.
 * @returns The section.
 */
export function ConnectionsSection({
  node,
  nodes,
  edges,
  canManage,
  onAdd,
  onRemove,
  onFocus,
}: {
  node: CanvasNode;
  nodes: readonly CanvasNode[];
  edges: readonly CanvasEdge[];
  canManage: boolean;
  onAdd: (to: string) => Promise<unknown>;
  onRemove: (edgeId: string) => Promise<unknown>;
  onFocus?: () => void;
}) {
  const [target, setTarget] = useState("");
  const action = useAction();
  const nameOf = (id: string) => nodes.find((n) => n.id === id)?.name ?? id;
  const mine = edges.filter(
    (e) => e.kind === "explicit" && (e.from === node.id || e.to === node.id),
  );
  const connected = new Set(mine.filter((e) => e.from === node.id).map((e) => e.to));
  const candidates = nodes.filter(
    (n) => n.id !== node.id && n.staged !== "create" && !connected.has(n.id),
  );
  return (
    <Section title="Connects to" onFocus={onFocus}>
      {mine.length ? (
        <ul className="grid gap-1">
          {mine.map((e) => (
            <li key={e.id} className="flex items-center gap-2 text-sm">
              <LinkIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
              <span className="truncate text-foreground">{nameOf(e.from)}</span>
              <ArrowRightIcon className="size-3.5 text-muted-foreground" aria-label="connects to" />
              <span className="truncate text-foreground">{nameOf(e.to)}</span>
              {canManage ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto"
                  aria-label={`Disconnect ${nameOf(e.from)} from ${nameOf(e.to)}`}
                  disabled={action.busy}
                  onClick={() => void action.run(() => onRemove(e.id))}
                >
                  <XIcon />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No drawn connections. References between variables show on their own.
        </p>
      )}
      {canManage && candidates.length ? (
        <div className="flex items-center gap-2">
          <Select
            aria-label={`Connect ${node.name} to`}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="flex-1"
          >
            <option value="">Connect to…</option>
            {candidates.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            variant="secondary"
            disabled={!target}
            loading={action.busy}
            onClick={() =>
              void action
                .run(() => onAdd(target))
                .then((ok) => {
                  if (ok) setTarget("");
                })
            }
          >
            Connect
          </Button>
        </div>
      ) : null}
      <ActionError error={action.error} />
    </Section>
  );
}
