import type { PresenceEditPart } from "@roundhouse/shared";
import { toast } from "@roundhouse/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/confirm-dialog";
import { ErrorState } from "../../components/error-state";
import type { ChangeSet, StagedChange, StagedOpInput } from "../../lib/api/changes-types";
import { errorMessage } from "../../lib/api/client";
import type { Environment } from "../../lib/api/deploy-types";
import { usePermissions } from "../../lib/permissions";
import { useRealtime } from "../../lib/realtime/provider";
import {
  useAddEdge,
  useApply,
  useCanvas,
  useChangeSet,
  useDecide,
  useDiscard,
  useDraft,
  useRebase,
  useRemoveEdge,
  useResolve,
  useStage,
  useSubmit,
  useUnstage,
  useUpdateLayout,
} from "../../queries/changes";
import { useMe } from "../../queries/me";
import { useMembers } from "../../queries/members";
import type { ServiceView } from "../projects/service-list";
import { changeCount } from "./diff-format";
import type { Point } from "./layout";
import { peerMarks } from "./presence";
import { ProjectCanvas } from "./project-canvas";
import { ReviewPanel } from "./review-panel";
import { ServicePanel } from "./service-panel";
import { StagedBar } from "./staged-bar";

/** Props for {@link CanvasView}. */
export interface CanvasViewProps {
  workspaceId: string;
  projectId: string;
  environment: Environment;
  envParam?: string;
  views: readonly ServiceView[];
  /** A change set to open in review (from `?review=`), e.g. one an agent proposed. */
  reviewId?: string;
  /** The review named by `reviewId` was closed. */
  onReviewClosed?: () => void;
}

/** How long node moves gather before they are saved (ADR 0006: 500 ms). */
const LAYOUT_DEBOUNCE_MS = 500;

/**
 * The project canvas page body: the graph, the panel of the selected service, the staged
 * changes bar, and the review panel. Every edit made here stages into the environment's
 * shared draft; nothing changes what runs until the draft is applied.
 *
 * @param props - Project, environment, live service state and the review to open.
 * @returns The view.
 */
export function CanvasView({
  workspaceId,
  projectId,
  environment,
  envParam,
  views,
  reviewId,
  onReviewClosed,
}: CanvasViewProps) {
  const scope = { projectId, environmentId: environment.id };
  const canvas = useCanvas(projectId, environment.id);
  const draft = useDraft(environment.id);
  const linked = useChangeSet(reviewId && reviewId !== draft.data?.id ? reviewId : undefined);
  const { can } = usePermissions(workspaceId);
  const stage = useStage(scope);
  const apply = useApply(scope);
  const discard = useDiscard(scope);
  const unstage = useUnstage(scope);
  const resolve = useResolve(scope);
  const layout = useUpdateLayout(projectId);
  const submitReview = useSubmit(scope);
  const decide = useDecide(scope);
  const rebase = useRebase(scope);
  const addEdge = useAddEdge(projectId);
  const removeEdge = useRemoveEdge(projectId);
  const realtime = useRealtime();
  const userId = useMe().data?.user.id;
  const members = useMembers(workspaceId);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<PresenceEditPart | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    if (reviewId) setReviewing(true);
  }, [reviewId]);

  const reviewSet: ChangeSet | null | undefined =
    reviewId && linked.data ? linked.data : draft.data;
  const viewById = useMemo(() => new Map(views.map((v) => [v.service.id, v])), [views]);
  // NOTE: Direct edits elsewhere (a service created or deleted on its own page) reach the
  // project's service list first; the canvas follows it rather than its own fetch.
  const graph = useMemo(() => {
    if (!canvas.data) return undefined;
    const nodes = canvas.data.nodes.filter((n) => n.staged === "create" || viewById.has(n.id));
    for (const { service } of views) {
      if (!nodes.some((n) => n.id === service.id)) {
        nodes.push({
          id: service.id,
          name: service.name,
          slug: service.slug,
          kind: service.kind,
          icon: service.icon,
          staged: null,
          staged_ops: 0,
          database: null,
          volume: null,
          domains: [],
        });
      }
    }
    return { ...canvas.data, nodes };
  }, [canvas.data, views, viewById]);
  const nodes = graph?.nodes;
  const nameOf = useCallback(
    (ref: string) => nodes?.find((n) => n.id === ref)?.name ?? ref,
    [nodes],
  );
  const userName = useCallback(
    (id: string) =>
      id === userId
        ? "you"
        : (members.data?.find((m) => m.user_id === id)?.name ??
          realtime?.presence.find((p) => p.user_id === id)?.name ??
          "a teammate"),
    [members.data, realtime?.presence, userId],
  );

  // Presence: tell the room what this tab shows, and mark what everyone else shows.
  const updatePresence = realtime?.updatePresence;
  useEffect(() => {
    updatePresence?.({
      environment_id: environment.id,
      selection: selected ? [selected] : [],
      editing: selected && editing ? { service_id: selected, part: editing } : null,
    });
  }, [updatePresence, environment.id, selected, editing]);
  const peers = useMemo(
    () => peerMarks(realtime?.presence ?? [], userId, environment.id),
    [realtime?.presence, userId, environment.id],
  );
  const select = useCallback((id: string | null) => {
    setSelected(id);
    setEditing(null);
  }, []);

  // Layout writes are batched and sent with the version they started from.
  const moves = useRef<Record<string, Point>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const version = canvas.data?.layout_version ?? 0;
  const versionRef = useRef(version);
  versionRef.current = version;
  const flush = useCallback(() => {
    const positions = moves.current;
    moves.current = {};
    if (Object.keys(positions).length) layout.mutate({ positions, version: versionRef.current });
  }, [layout]);
  const onMove = useCallback(
    (id: string, position: Point) => {
      moves.current[id] = position;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, LAYOUT_DEBOUNCE_MS);
      setAnnouncement(`Moved ${nameOf(id)}`);
    },
    [flush, nameOf],
  );
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const pendingCount = draft.data?.op_count ?? 0;
  const previous = useRef(pendingCount);
  useEffect(() => {
    if (previous.current !== pendingCount) setAnnouncement(`${changeCount(pendingCount)} staged`);
    previous.current = pendingCount;
  }, [pendingCount]);

  async function runApply(set: ChangeSet, deploy: "affected" | "none") {
    const result = await apply.mutateAsync({ setId: set.id, revision: set.revision, deploy });
    const deploying = result.deployment_ids.length;
    toast({
      title: `Applied ${changeCount(result.change_set.op_count)}`,
      description: deploying
        ? `Deploying ${deploying} service${deploying === 1 ? "" : "s"} to ${environment.name}`
        : environment.name,
      tone: "success",
    });
    setReviewing(false);
    if (reviewId) onReviewClosed?.();
  }

  async function stageOps(ops: StagedOpInput[], options: { apply: boolean }) {
    let set = draft.data ?? null;
    for (const op of ops) set = await stage.mutateAsync({ op });
    if (options.apply && set) await runApply(set, "affected");
    else if (ops.length)
      toast({
        title: "Staged",
        description: changeCount(set?.op_count ?? ops.length),
        tone: "success",
      });
  }

  const onApply = (deploy: "affected" | "none") => {
    if (!reviewSet) return;
    runApply(reviewSet, deploy).catch(() => undefined);
  };

  const onUnstage = (change: StagedChange) => {
    if (!reviewSet) return;
    unstage.mutate(
      { setId: reviewSet.id, opId: change.id, revision: reviewSet.revision },
      {
        onError: (err) =>
          toast({ title: "Could not unstage", description: errorMessage(err), tone: "error" }),
      },
    );
  };

  const onResolve = (change: StagedChange, keep: "mine" | "theirs") => {
    if (!reviewSet) return;
    resolve.mutate(
      { setId: reviewSet.id, opId: change.id, keep, revision: reviewSet.revision },
      {
        onError: (err) =>
          toast({ title: "Could not resolve", description: errorMessage(err), tone: "error" }),
      },
    );
  };

  const reviewScope = reviewSet ? { setId: reviewSet.id, revision: reviewSet.revision } : null;
  const onSubmit = (note: string | undefined) => {
    if (!reviewScope) return;
    submitReview.mutate(
      { ...reviewScope, ...(note ? { note } : {}) },
      {
        onSuccess: () => toast({ title: "Asked for a review", tone: "success" }),
        onError: (err) =>
          toast({
            title: "Could not ask for a review",
            description: errorMessage(err),
            tone: "error",
          }),
      },
    );
  };
  const onDecide = (decision: "approve" | "reject", note: string | undefined) => {
    if (!reviewScope) return;
    decide.mutate(
      { ...reviewScope, decision, ...(note ? { note } : {}) },
      {
        onSuccess: () =>
          toast({
            title: decision === "approve" ? "Approved staged changes" : "Rejected staged changes",
            tone: "success",
          }),
        onError: (err) =>
          toast({
            title: decision === "approve" ? "Could not approve" : "Could not reject",
            description: errorMessage(err),
            tone: "error",
          }),
      },
    );
  };
  const onRebase = () => {
    if (!reviewScope) return;
    rebase.mutate(reviewScope, {
      onSuccess: (result) =>
        toast({
          title: result.conflicts.length
            ? `Rebased; ${result.conflicts.length} conflict${result.conflicts.length === 1 ? "" : "s"} to resolve`
            : "Rebased onto the current state",
          tone: result.conflicts.length ? "info" : "success",
        }),
      onError: (err) =>
        toast({ title: "Could not rebase", description: errorMessage(err), tone: "error" }),
    });
  };

  if (canvas.isError) {
    return (
      <ErrorState message={errorMessage(canvas.error)} onRetry={() => void canvas.refetch()} />
    );
  }

  const selectedNode = graph?.nodes.find((n) => n.id === selected);
  const canEdit = can("services:manage") || can("variables:manage");
  const needsApproval =
    (canvas.data?.environment_requires_approval ?? false) &&
    !(draft.data?.review_status === "approved" && draft.data.approved_by !== userId);
  const createChange =
    selectedNode?.staged === "create"
      ? draft.data?.changes.find(
          (c) => c.op.type === "service.create" && c.op.ref === selectedNode.id,
        )
      : undefined;

  return (
    <div className="grid gap-3">
      <div className="relative">
        {graph ? (
          <ProjectCanvas
            canvas={graph}
            views={viewById}
            selectedId={selected}
            onOpen={select}
            onClearSelection={() => select(null)}
            onMove={can("services:manage") ? onMove : undefined}
            peers={peers}
            className="h-[min(68dvh,720px)] min-h-[26rem]"
          />
        ) : (
          <div
            aria-busy="true"
            className="h-[min(68dvh,720px)] min-h-[26rem] animate-pulse rounded-md border border-border bg-surface/40"
          />
        )}
        {selectedNode ? (
          <div className="absolute inset-x-2 top-2 bottom-14 z-10 flex sm:inset-x-auto sm:right-3 sm:w-[23rem]">
            <ServicePanel
              key={selectedNode.id}
              workspaceId={workspaceId}
              projectId={projectId}
              environmentId={environment.id}
              envParam={envParam}
              node={selectedNode}
              view={viewById.get(selectedNode.id)}
              canManageServices={can("services:manage")}
              canManageVariables={can("variables:manage")}
              onStage={stageOps}
              onUnstageCreate={createChange ? () => onUnstage(createChange) : undefined}
              onClose={() => select(null)}
              stagedCount={pendingCount}
              staging={canvas.data?.staging ?? true}
              nodes={graph?.nodes}
              edges={graph?.edges}
              onAddEdge={(to) => addEdge.mutateAsync({ from: selectedNode.id, to })}
              onRemoveEdge={(edgeId) => removeEdge.mutateAsync(edgeId)}
              onEditing={setEditing}
            />
          </div>
        ) : null}
      </div>

      {draft.data && pendingCount > 0 ? (
        <StagedBar
          draft={draft.data}
          className="sticky bottom-4 z-20"
          onReview={() => setReviewing(true)}
          onDiscard={() => setConfirmDiscard(true)}
          onDeploy={
            canEdit && !needsApproval
              ? () => runApply(draft.data!, "affected").catch(() => setReviewing(true))
              : undefined
          }
          needsApproval={needsApproval}
          deploying={apply.isPending}
        />
      ) : null}

      {reviewSet ? (
        <ReviewPanel
          open={reviewing}
          onOpenChange={(open) => {
            setReviewing(open);
            if (!open) {
              apply.reset();
              if (reviewId) onReviewClosed?.();
            }
          }}
          set={reviewSet}
          environmentName={environment.name}
          protectedEnvironment={canvas.data?.environment_protected ?? false}
          nameOf={nameOf}
          onUnstage={canEdit && reviewSet.status === "open" ? onUnstage : undefined}
          onResolve={canEdit && reviewSet.status === "open" ? onResolve : undefined}
          onApply={canEdit && reviewSet.status === "open" ? onApply : undefined}
          onDiscard={
            canEdit && reviewSet.status === "open" ? () => setConfirmDiscard(true) : undefined
          }
          applying={apply.isPending}
          error={apply.error}
          userId={userId}
          userName={userName}
          onSubmit={canEdit && reviewSet.status === "open" ? onSubmit : undefined}
          onDecide={can("changes:approve") && reviewSet.status === "open" ? onDecide : undefined}
          onRebase={canEdit && reviewSet.status === "open" ? onRebase : undefined}
          reviewing={submitReview.isPending || decide.isPending || rebase.isPending}
        />
      ) : null}

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard staged changes?"
        description={`${changeCount(reviewSet?.op_count ?? 0)} to ${environment.name} will be thrown away. Nothing that runs changes.`}
        confirmLabel="Discard"
        pending={discard.isPending}
        error={discard.error ? errorMessage(discard.error) : null}
        onConfirm={() => {
          if (!reviewSet) return;
          discard.mutate(
            { setId: reviewSet.id, revision: reviewSet.revision },
            {
              onSuccess: () => {
                setConfirmDiscard(false);
                setReviewing(false);
                toast({ title: "Discarded staged changes", tone: "success" });
              },
            },
          );
        }}
      />

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
