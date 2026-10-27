/**
 * What a preview looks like from outside: its services with their links and
 * latest deployments, and the `Preview` wire shape. Shared by the routes,
 * the MCP tool and the GitHub comment, so all three show the same thing.
 *
 * Nothing here reads a variable or a log line.
 *
 * @module
 */
import {
  builds,
  type Db,
  deployments,
  domains,
  environments,
  previewEnvironments,
  services,
} from "@roundhouse/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { z } from "zod";
import type { PreviewSchema, PreviewServiceSchema } from "../../contracts/previews";
import { getIngressSettings } from "../settings";
import type { PreviewRow } from "./environment";

/** One service of a preview. */
export type PreviewServiceView = z.infer<typeof PreviewServiceSchema>;

/**
 * The services of a preview environment, by name, with their public URL and
 * newest deployment.
 *
 * @param db - Database client.
 * @param environmentId - The preview environment, or `null` for none.
 * @returns One entry per service with a deployment or a domain there.
 */
export async function previewServices(
  db: Db,
  environmentId: string | null,
): Promise<PreviewServiceView[]> {
  if (!environmentId) return [];
  const [rows, hosts, ingress] = await Promise.all([
    db
      .select({ deployment: deployments, service: services, commitSha: builds.commitSha })
      .from(deployments)
      .innerJoin(services, eq(services.id, deployments.serviceId))
      .leftJoin(builds, eq(builds.id, deployments.buildId))
      .where(and(eq(deployments.environmentId, environmentId), isNull(services.deletedAt)))
      .orderBy(desc(deployments.id)),
    db
      .select({ serviceId: domains.serviceId, hostname: domains.hostname })
      .from(domains)
      .where(and(eq(domains.environmentId, environmentId), eq(domains.type, "generated"))),
    getIngressSettings(db),
  ]);
  const scheme = ingress.tlsMode === "off" ? "http" : "https";
  const url = new Map(hosts.map((h) => [h.serviceId, `${scheme}://${h.hostname}`]));
  const out = new Map<string, PreviewServiceView>();
  for (const r of rows) {
    if (out.has(r.service.id)) continue;
    out.set(r.service.id, {
      service_id: r.service.id,
      slug: r.service.slug,
      name: r.service.name,
      url: url.get(r.service.id) ?? null,
      deployment_id: r.deployment.id,
      status: r.deployment.status,
      commit_sha: r.commitSha ?? null,
    });
  }
  const missing = [...url.keys()].filter((id) => !out.has(id));
  if (missing.length) {
    const rest = await db
      .select({ id: services.id, slug: services.slug, name: services.name })
      .from(services)
      .where(and(inArray(services.id, missing), isNull(services.deletedAt)));
    for (const s of rest) {
      out.set(s.id, {
        service_id: s.id,
        slug: s.slug,
        name: s.name,
        url: url.get(s.id) ?? null,
        deployment_id: null,
        status: null,
        commit_sha: null,
      });
    }
  }
  return [...out.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * The `Preview` wire shape.
 *
 * @param db - Database client.
 * @param p - The preview row.
 * @returns The API object, with its services.
 */
export async function toApiPreview(db: Db, p: PreviewRow): Promise<z.infer<typeof PreviewSchema>> {
  const [env] = p.environmentId
    ? await db
        .select({ slug: environments.slug })
        .from(environments)
        .where(eq(environments.id, p.environmentId))
        .limit(1)
    : [];
  return {
    id: p.id,
    project_id: p.projectId,
    environment_id: p.environmentId,
    environment_slug: env?.slug ?? null,
    repo_full_name: p.repoFullName,
    pr_number: p.prNumber,
    pr_url: `https://github.com/${p.repoFullName}/pull/${p.prNumber}`,
    title: p.title,
    head_ref: p.headRef,
    head_sha: p.headSha,
    head_repo_full_name: p.headRepoFullName,
    is_fork: p.isFork,
    withheld: p.withheld,
    author_login: p.authorLogin,
    author_association: p.authorAssociation,
    draft: p.draft,
    status: p.status,
    approved_sha: p.approvedSha,
    approved_by_login: p.approvedByLogin,
    last_activity_at: +p.lastActivityAt,
    expires_at: p.expiresAt ? +p.expiresAt : null,
    closed_at: p.closedAt ? +p.closedAt : null,
    error: p.error,
    services: await previewServices(db, p.environmentId),
    created_at: +p.createdAt,
    updated_at: +p.updatedAt,
  };
}

/**
 * A preview by ID.
 *
 * @param db - Database client.
 * @param previewId - The preview.
 * @returns The row, or `undefined`.
 */
export async function findPreview(db: Db, previewId: string): Promise<PreviewRow | undefined> {
  const [row] = await db
    .select()
    .from(previewEnvironments)
    .where(eq(previewEnvironments.id, previewId))
    .limit(1);
  return row;
}
