/**
 * The project canvas (ADR 0006 "Canvas data model"): nodes are the live
 * services plus those the environment's draft creates, edges are derived on
 * read from `${{slug.VAR}}` references (before and after the draft), and
 * positions are stored per project.
 *
 * SECURITY: Edges are computed from decrypted values, staged ones included,
 * but only the referenced names (`slug.NAME`) leave this module, which a
 * `variables:read` caller can already infer from keys and fingerprints.
 *
 * @module
 */
import { canvasLayouts, type Db, services } from "@roundhouse/db";
import {
  isNewServiceRef,
  type ServiceKind,
  SHARED_NAMESPACE,
  serviceOfOp,
  variableDependencies,
} from "@roundhouse/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { KeyEnv, Sealed } from "../crypto";
import { ApiError } from "../errors";
import { slugFor } from "../projects";
import { loadEnvironmentVariables, projectKey } from "../variables";
import { openStagedValue } from "./secrets";
import {
  type EnvironmentRow,
  findDraft,
  loadOps,
  type ProjectRow,
  toApiChangeSetSummary,
} from "./store";

/** One canvas position. */
export interface Position {
  x: number;
  y: number;
}

type EdgeState = "current" | "staged" | "removed";

const PRIVATE_DOMAIN = ".ROUNDHOUSE_PRIVATE_DOMAIN";

/**
 * The stored layout of a project.
 *
 * @param db - Database client.
 * @param projectId - The project.
 * @returns Positions and version (0 before the first write).
 */
export async function loadLayout(db: Db, projectId: string) {
  const row = await db.query.canvasLayouts.findFirst({
    where: eq(canvasLayouts.projectId, projectId),
  });
  return { positions: row?.positions ?? {}, version: row?.version ?? 0 };
}

/**
 * Builds the canvas of one environment.
 *
 * @param ctx - Database, keyring bindings, project and environment.
 * @returns The `Canvas` wire shape.
 */
export async function buildCanvas(ctx: {
  db: Db;
  keys: KeyEnv;
  project: ProjectRow;
  environment: EnvironmentRow;
}) {
  const { db, project, environment } = ctx;
  const [live, draft, layout] = await Promise.all([
    db
      .select()
      .from(services)
      .where(and(eq(services.projectId, project.id), isNull(services.deletedAt)))
      .orderBy(services.id),
    findDraft(db, environment.id),
    loadLayout(db, project.id),
  ]);
  const rows = draft ? (await loadOps(db, draft.id)).filter((r) => r.status !== "applied") : [];

  const nodes = new Map<
    string,
    {
      id: string;
      name: string;
      slug: string;
      kind: ServiceKind;
      icon: string | null;
      staged: "create" | "update" | "delete" | null;
      staged_ops: number;
    }
  >();
  for (const s of live) {
    nodes.set(s.id, {
      id: s.id,
      name: s.name,
      slug: s.slug,
      kind: s.kind,
      icon: s.icon,
      staged: null,
      staged_ops: 0,
    });
  }
  for (const r of rows) {
    if (r.op.type !== "service.create") continue;
    nodes.set(r.op.ref, {
      id: r.op.ref,
      name: r.op.name,
      slug: r.op.slug ?? slugFor(r.op.name, "service"),
      kind: r.op.kind,
      icon: r.op.icon ?? null,
      staged: "create",
      staged_ops: 0,
    });
  }
  for (const r of rows) {
    const id = serviceOfOp(r.op);
    const node = id ? nodes.get(id) : undefined;
    if (!node) continue;
    node.staged_ops += 1;
    if (r.op.type === "service.delete") node.staged = "delete";
    else if (node.staged === null) node.staged = "update";
  }

  // Raw values before and after the draft, by slug.
  const dek = await projectKey(db, ctx.keys, project.id);
  const current = await loadEnvironmentVariables(db, dek, project.id, environment.id);
  const idBySlugBefore = new Map(live.map((s) => [s.slug, s.id]));
  const slugAfter = new Map<string, string>(live.map((s) => [s.id, s.slug]));
  for (const r of rows) {
    if (r.op.type === "service.delete") slugAfter.delete(r.op.service_id);
    if (r.op.type === "service.update" && r.op.slug && slugAfter.has(r.op.service_id)) {
      slugAfter.set(r.op.service_id, r.op.slug);
    }
    if (r.op.type === "service.create") {
      slugAfter.set(r.op.ref, r.op.slug ?? slugFor(r.op.name, "service"));
    }
  }
  const idBySlugAfter = new Map([...slugAfter].map(([id, slug]) => [slug, id]));
  const after: Record<string, Record<string, string>> = {};
  for (const [id, slug] of slugAfter) {
    const before = live.find((s) => s.id === id)?.slug;
    after[slug] = { ...(before ? (current.services[before] ?? {}) : {}) };
  }
  for (const r of rows) {
    const op = r.op;
    if ((op.type !== "variable.set" && op.type !== "variable.delete") || op.scope !== "service") {
      continue;
    }
    const slug = slugAfter.get(op.service!);
    if (!slug) continue;
    if (op.type === "variable.delete") {
      delete after[slug]![op.key];
    } else if (r.valueSealed) {
      after[slug]![op.key] = await openStagedValue(
        dek,
        {
          changeSetId: r.changeSetId,
          stagedChangeId: r.id,
          scope: op.scope,
          service: op.service!,
          key: op.key,
        },
        r.valueSealed as Sealed,
      );
    }
  }

  const edges = new Map<
    string,
    { from: string; to: string; variables: Set<string>; before: boolean; after: boolean }
  >();
  const add = (
    deps: ReturnType<typeof variableDependencies>,
    idOf: Map<string, string>,
    side: "before" | "after",
  ) => {
    for (const d of deps) {
      if (d.to === SHARED_NAMESPACE) continue;
      const from = idOf.get(d.from);
      const to = idOf.get(d.to);
      if (!from || !to) continue;
      const id = `${from}->${to}`;
      const edge = edges.get(id) ?? { from, to, variables: new Set(), before: false, after: false };
      for (const v of d.variables) edge.variables.add(v);
      edge[side] = true;
      edges.set(id, edge);
    }
  };
  add(variableDependencies(current.services), idBySlugBefore, "before");
  add(variableDependencies(after), idBySlugAfter, "after");

  const known = new Set(nodes.keys());
  return {
    project_id: project.id,
    environment_id: environment.id,
    environment_protected: environment.protected,
    nodes: [...nodes.values()],
    edges: [...edges]
      .filter(([, e]) => known.has(e.from) && known.has(e.to))
      .map(([id, e]) => {
        const variables = [...e.variables].sort();
        const state: EdgeState = e.before && e.after ? "current" : e.after ? "staged" : "removed";
        return {
          id,
          from: e.from,
          to: e.to,
          kind: variables.some((v) => v.endsWith(PRIVATE_DOMAIN))
            ? ("private_network" as const)
            : ("reference" as const),
          variables,
          state,
        };
      }),
    positions: Object.fromEntries(
      Object.entries(layout.positions).filter(([id]) => known.has(id) && !isNewServiceRef(id)),
    ),
    layout_version: layout.version,
    draft: draft ? toApiChangeSetSummary(draft, rows) : null,
  };
}

/**
 * Merges positions into a project's layout, guarded on its version. Only
 * live services of the project are kept.
 *
 * @param db - Database client.
 * @param projectId - The project.
 * @param patch - New positions; `null` removes one.
 * @param expectedVersion - The version the caller started from (0 before the first write).
 * @returns The stored layout.
 * @throws {ApiError} 409 with the current version when someone else moved services first.
 */
export async function updateLayout(
  db: Db,
  projectId: string,
  patch: Readonly<Record<string, Position | null>>,
  expectedVersion: number,
) {
  const stored = await loadLayout(db, projectId);
  if (stored.version !== expectedVersion) {
    throw new ApiError(
      409,
      "conflict",
      `The layout changed; it is at version ${stored.version}. Reload and try again`,
    );
  }
  const liveIds = new Set(
    (
      await db
        .select({ id: services.id })
        .from(services)
        .where(and(eq(services.projectId, projectId), isNull(services.deletedAt)))
    ).map((s) => s.id),
  );
  const positions: Record<string, Position> = {};
  for (const [id, p] of Object.entries({ ...stored.positions, ...patch })) {
    if (p && liveIds.has(id)) positions[id] = { x: Math.round(p.x), y: Math.round(p.y) };
  }
  const now = new Date();
  const [row] =
    expectedVersion === 0
      ? await db
          .insert(canvasLayouts)
          .values({ projectId, positions, version: 1 })
          .onConflictDoNothing()
          .returning()
      : await db
          .update(canvasLayouts)
          .set({ positions, version: expectedVersion + 1, updatedAt: now })
          .where(
            and(eq(canvasLayouts.projectId, projectId), eq(canvasLayouts.version, expectedVersion)),
          )
          .returning();
  if (!row) {
    const latest = await loadLayout(db, projectId);
    throw new ApiError(
      409,
      "conflict",
      `The layout changed; it is at version ${latest.version}. Reload and try again`,
    );
  }
  return { positions: row.positions, version: row.version };
}
