/**
 * The node Durable Object's `image_push_result` handler (ADR 0011
 * "Registry path"): records a builder's answer to `image_push` on the
 * Cloudflare deployment that sent it and wakes that deployment's workflow,
 * like `build_result` does for builds.
 *
 * SECURITY: a result counts only from the node the push was sent to
 * (`cf_deployments.push_node_id`), and only once, so an agent can't answer
 * for another node's push or overwrite a recorded digest.
 *
 * @module
 */
import { cfDeployments, type Db, deployments } from "@roundhouse/db";
import type { ImagePushResult } from "@roundhouse/protocol";
import { and, eq, isNull } from "drizzle-orm";
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
