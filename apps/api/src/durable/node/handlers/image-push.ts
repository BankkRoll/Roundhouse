/**
 * The node Durable Object's `image_push_result` handler (ADR 0011
 * "Registry path"): records a builder's answer to `image_push` on the
 * Cloudflare deployment that sent it and wakes that deployment's workflow,
 * like `build_result` does for builds; and files the push's `task` log
 * lines under the deployment's build ({@link imagePushLogBuild}).
 *
 * SECURITY: a result counts only from the node the push was sent to
 * (`cf_deployments.push_node_id`), and only once, so an agent can't answer
 * for another node's push or overwrite a recorded digest.
 *
 * @module
 */
import { builds, cfDeployments, type Db, deployments } from "@roundhouse/db";
import type { ImagePushResult } from "@roundhouse/protocol";
import { ID_PREFIXES } from "@roundhouse/shared";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Env } from "../../../env";
import { wakeWorkflow } from "../../../lib/deployments";

/**
 * Handles one `image_push_result` frame.
 *
 * @param db - Control-plane database.
 * @param env - Worker bindings (the deploy workflow binding).
 * @param nodeId - The reporting node.
 * @param frame - The validated frame.
 * @returns Whether a pending push was settled.
 */
export async function onImagePushResult(
  db: Db,
  env: Pick<Env, "DEPLOY_WORKFLOW">,
  nodeId: string,
  frame: ImagePushResult,
): Promise<boolean> {
  const now = new Date();
  const [settled] = await db
    .update(cfDeployments)
    .set(
      frame.ok
        ? { imageDigest: frame.digest!, updatedAt: now }
        : { status: "failed", error: `Image push failed: ${frame.error}`, updatedAt: now },
    )
    .where(
      and(
        eq(cfDeployments.pushId, frame.push_id),
        eq(cfDeployments.pushNodeId, nodeId),
        eq(cfDeployments.status, "pushing"),
        isNull(cfDeployments.imageDigest),
      ),
    )
    .returning({ deploymentId: cfDeployments.deploymentId });
  if (!settled) return false;
  const deployment = await db.query.deployments.findFirst({
    where: eq(deployments.id, settled.deploymentId),
    columns: { workflowInstanceId: true },
  });
  if (deployment) {
    await wakeWorkflow(env, deployment, "image_push", { ok: frame.ok, bytes: frame.bytes ?? null });
  }
  return true;
}

/**
 * The build whose log a push's `task` log lines belong to: the deployment's
 * build on the node the push was sent to, so the dashboard shows registry
 * progress right after the build output. Lines of any other task, or of a
 * push this node wasn't sent, have no owner.
 *
 * @param db - Control-plane database.
 * @param nodeId - The reporting node.
 * @param taskId - `logs.source.task_id`.
 * @returns The build ID, or `null`.
 */
export async function imagePushLogBuild(
  db: Db,
  nodeId: string,
  taskId: string,
): Promise<string | null> {
  if (!taskId.startsWith(`${ID_PREFIXES.imagePush}_`)) return null;
  const [row] = await db
    .select({ buildId: builds.id })
    .from(cfDeployments)
    .innerJoin(builds, eq(builds.deploymentId, cfDeployments.deploymentId))
    .where(
      and(
        eq(cfDeployments.pushId, taskId),
        eq(cfDeployments.pushNodeId, nodeId),
        eq(builds.nodeId, nodeId),
      ),
    )
    .orderBy(desc(builds.createdAt))
    .limit(1);
  return row?.buildId ?? null;
}
