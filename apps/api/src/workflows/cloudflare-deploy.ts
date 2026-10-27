/**
 * The Cloudflare Containers branch of the deploy pipeline (ADR 0011
 * "Deploy and switching"), run by `DeployWorkflow` after
 * `resolve-variables` and the build when the deployment's config selects
 * `placement.provider = "cloudflare"`.
 *
 * Steps (each a workflow step, so each retries on its own):
 * 1. `cf-prepare`: re-check eligibility, choose the image (a rollback reuses
 *    its source's Cloudflare image; a git build is pushed; Docker Hub, ECR
 *    and Artifact Registry images are referenced directly), record the
 *    `cf_deployments` row with the next runtime generation, and move the
 *    deployment to `deploying`.
 * 2. Push (git builds): mint 15-minute registry push credentials, seal them
 *    to the builder that holds the image and send `image_push`; wait for
 *    `image_push_result` (the node Durable Object records it and wakes the
 *    workflow). A builder below `IMAGE_PUSH_PROTOCOL_VERSION` fails the
 *    deployment with `builder_outdated`.
 * 3. `cf-script`: upload the runtime script with this generation's
 *    `RH_CONFIG` and token, enable `workers.dev`, find the Durable Object
 *    namespace.
 * 4. `cf-application`: create the container application, or start a
 *    rollout of the new image; poll until the rollout ends (≤ 10 minutes).
 * 5. `cf-warm-*`: request the health path on `workers.dev` with `RH-Warm`
 *    until it answers 2xx.
 * 6. `cf-routes`: list-then-create a Worker route per hostname.
 * 7. When nodes served before, wait `drain_s` (at least 30 s), then the
 *    shared `finalize` (which retires the node replicas) and `cf-finalize`.
 *
 * {@link switchBackFromCloudflare} runs after a node deployment is active:
 * routes deleted, drain, `max_instances` 0, runtime disabled with
 * `delete_after` 24 h out.
 *
 * Failures carry Cloudflare's error verbatim onto the deployment and the
 * `cf_deployments` row. A failure after the script step re-uploads the
 * previous Cloudflare deployment's script (new generation) and rolls its
 * image back, best effort, so the previous deployment keeps serving.
 *
 * @module
 */
import type { WorkflowStep } from "cloudflare:workers";
import {
  cfDeployments,
  cfRuntimes,
  createDb,
  type Db,
  deployments,
  nodes,
  placements,
  serviceConfigs,
  services,
} from "@roundhouse/db";
import {
  IMAGE_PUSH_PROTOCOL_VERSION,
  imagePushAad,
  REGISTRY_LISTEN,
  sealBox,
} from "@roundhouse/protocol";
import {
  type DeploymentStatus,
  instanceTypeFor,
  newId,
  type ServiceConfigSpec,
} from "@roundhouse/shared";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { RUNTIME_WARM_HEADER, type RuntimeConfig, warmHeaderValue } from "../cf-runtime";
import type { Env } from "../env";
import {
  type CloudflareClient,
  CloudflareProviderError,
  sendWarmUp,
} from "../lib/cloudflare/client";
import { cloudflareFactsFor, cloudflareProblems } from "../lib/cloudflare/eligibility";
import {
  cloudflareImageTarget,
  cloudflareScriptName,
  isDirectlyPullable,
} from "../lib/cloudflare/naming";
import {
  type CfDeploymentRow,
  type CfRuntimeRow,
  CLOUDFLARE_DELETE_GRACE_MS,
  collectImageTags,
  disableRuntime,
  ensureRuntimeRow,
  MIN_CLOUDFLARE_DRAIN_S,
  removeRoutes,
  runtimeHostnames,
  runtimeOf,
  switchRoutes,
  uploadRuntime,
  workersDevUrl,
} from "../lib/cloudflare/runtime";
import { mintRuntimeToken } from "../lib/cloudflare/runtime-token";
import {
  type CloudflareAccount,
  clientFor,
  loadCloudflareAccount,
} from "../lib/cloudflare/settings";
import {
  addDeploymentEvent,
  disposeRpc,
  IllegalTransitionError,
  transitionDeployment,
} from "../lib/deployments";
import { specOf } from "../lib/projects";

// -----------------------------------------------------------------------------
// Types shared with the deploy workflow
// -----------------------------------------------------------------------------

/** A failed step, as `DeployWorkflow` records it. */
export interface CfFailure {
  kind: "fail";
  reason: string;
  /** JSON-encoded event data. */
  data?: string;
}

/** A step's verdict. */
export type CfVerdict<T> =
  | ({ kind: "ok" } & T)
  | { kind: "stop"; status: DeploymentStatus }
  | CfFailure;

/** What the pipeline needs to know about the deployment (a subset of the workflow's plan). */
export interface CfPlan {
  deploymentId: string;
  projectId: string;
  workspaceId: string;
  serviceId: string;
  environmentId: string;
  configVersion: number;
  isRollback: boolean;
}

/** Hooks into `DeployWorkflow` the Cloudflare branch reuses. */
export interface CloudflareHost {
  env: Env;
  step: WorkflowStep;
  plan: CfPlan;
  /** The workflow's wait loop: D1 check, then wait for an `image_push` wake-up. */
  waitForPush<T>(
    deadline: number,
    check: (i: number) => Promise<CfVerdict<T> | { kind: "pending" }>,
  ): Promise<CfVerdict<T> | { kind: "timeout" }>;
  /** The shared `finalize` step: active, supersede the previous deployment, retire its replicas. */
  finalize(): Promise<CfVerdict<object>>;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DB_STEP = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

const NETWORK_STEP = {
  retries: { limit: 4, delay: "5 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} as const;

/** Builder's own limit for one push. */
const PUSH_TIMEOUT_S = 1800;

/** How long a rollout may take (ADR 0011: ≤ 10 min). */
const ROLLOUT_TIMEOUT_MS = 10 * 60 * 1000;

/** Between rollout polls. */
const ROLLOUT_POLL_MS = 10_000;

/** Between warm-up attempts. */
const WARM_POLL_MS = 5_000;

/** How long the warm-up keeps trying: a cold start plus the app's own start. */
const WARM_TIMEOUT_MS = 5 * 60 * 1000;

/** Upper bound on poll iterations, so a replay walks a bounded sequence. */
const MAX_POLLS = 120;

/** Statuses a step of this branch runs in once the deployment is `deploying`. */
const DEPLOYING: DeploymentStatus[] = ["deploying"];

const fail = (reason: string, data?: Record<string, unknown>): CfFailure => ({
  kind: "fail",
  reason,
  ...(data ? { data: JSON.stringify(data) } : {}),
});

/**
 * Runs a Cloudflare call inside a step: a refusal (4xx) fails the
 * deployment with Cloudflare's words; an outage (5xx, 429, unreachable)
 * throws so the step retries.
 */
async function cfCall<T>(fn: () => Promise<T>): Promise<T | CfFailure> {
  try {
    return await fn();
  } catch (err) {
    if (
      err instanceof CloudflareProviderError &&
      err.status !== 0 &&
      err.status !== 429 &&
      err.status < 500
    ) {
      return fail(err.message);
    }
    throw err;
  }
}

const isFailure = (v: unknown): v is CfFailure =>
  typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "fail";

/** Everything later steps need, captured once. Serialisable and secret-free. */
interface Prepared {
  cfdId: string;
  scriptName: string;
  imageRef: string;
  /** Set when the image must be copied from a builder. */
  push: { pushId: string; nodeId: string; source: string; target: string } | null;
  generation: number;
  instanceType: string;
  maxInstances: number;
  regions: string[] | null;
  port: number;
  sleepAfter: string;
  healthPath: string;
  drainS: number;
  /** Nodes served the previous deployment, so its replicas drain after the routes switch. */
  previousOnNodes: boolean;
  /** The runtime served traffic before this deployment. */
  wasActive: boolean;
}

// -----------------------------------------------------------------------------
// Pipeline
// -----------------------------------------------------------------------------

/**
 * Runs the Cloudflare branch of one deployment.
 *
 * @param host - The deploy workflow's hooks.
 * @param image - The deployment's image: the local registry reference of a
 *   git build, an image source, or a rollback's image.
 * @param registryNodeId - The builder holding a locally built image.
 * @returns `stop` with the final status, or the failure for `failDeployment`.
 */
export async function runCloudflareDeploy(
  host: CloudflareHost,
  image: string,
  registryNodeId: string | null,
): Promise<{ kind: "stop"; status: DeploymentStatus } | CfFailure> {
  const { step } = host;
  const ops = new CloudflareOps(host);
  const prepared = await step.do("cf-prepare", DB_STEP, () => ops.prepare(image, registryNodeId));
  if (prepared.kind !== "ok") return prepared;
  const prep = prepared.prep;
  let scriptTouched = false;
  try {
    if (prep.push) {
      const sent = await step.do("cf-push-send", NETWORK_STEP, () => ops.sendPush(prep));
      if (sent.kind !== "ok") return await ops.abandon(prep, sent, false);
      const deadline = await step.do(
        "cf-push-deadline",
        async () => Date.now() + (PUSH_TIMEOUT_S + 60) * 1000,
      );
      const pushed = await host.waitForPush(deadline, (i) =>
        step.do(`cf-check-push-${i}`, DB_STEP, () => ops.checkPush(prep)),
      );
      if (pushed.kind !== "ok") {
        return await ops.abandon(
          prep,
          pushed.kind === "timeout"
            ? fail(
                `The builder did not finish pushing the image within ${PUSH_TIMEOUT_S / 60} minutes`,
              )
            : pushed,
          false,
        );
      }
    }

    scriptTouched = true;
    const script = await step.do("cf-script", NETWORK_STEP, () => ops.script(prep, prep.cfdId));
    if (script.kind !== "ok") return await ops.abandon(prep, script, scriptTouched);

    const app = await step.do("cf-application", NETWORK_STEP, () => ops.application(prep));
    if (app.kind !== "ok") return await ops.abandon(prep, app, scriptTouched);
    if (app.rolloutId) {
      const rolled = await ops.waitRollout(prep, app.applicationId, app.rolloutId);
      if (rolled.kind !== "ok") return await ops.abandon(prep, rolled, scriptTouched);
    }

    const warm = await ops.warm(prep);
    if (warm.kind !== "ok") return await ops.abandon(prep, warm, scriptTouched);

    const routed = await step.do("cf-routes", NETWORK_STEP, () => ops.routes(prep));
    if (routed.kind !== "ok") return await ops.abandon(prep, routed, scriptTouched);

    if (prep.previousOnNodes) {
      await step.sleep("cf-drain", Math.max(MIN_CLOUDFLARE_DRAIN_S, prep.drainS) * 1000);
    }
    const done = await host.finalize();
    if (done.kind !== "ok") return done;
    await step.do("cf-finalize", DB_STEP, () => ops.finalize(prep));
    if (prep.push) await step.do("cf-gc", NETWORK_STEP, () => ops.collect(prep));
    return { kind: "stop", status: "active" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return await ops.abandon(prep, fail(reason), scriptTouched);
  }
}

/**
 * After a node deployment of a service that ran on Cloudflare became
 * active: deletes the Worker routes (traffic falls through to the ingress
 * nodes), waits `drain_s` (at least 30 s), sets `max_instances` to 0 and
 * disables the runtime with `delete_after` 24 h out. Problems are recorded
 * on the deployment's timeline; the node deployment stays active.
 *
 * @param host - The deploy workflow's hooks.
 */
export async function switchBackFromCloudflare(
  host: Omit<CloudflareHost, "waitForPush" | "finalize">,
) {
  const { step } = host;
  const ops = new CloudflareOps({ ...host, waitForPush: never, finalize: never });
  const check = await step.do("cf-switch-check", DB_STEP, () => ops.switchCheck());
  if (!check.active) return;
  const unrouted = await step.do("cf-unroute", NETWORK_STEP, () => ops.unroute());
  if (!unrouted) return;
  await step.sleep("cf-switch-drain", Math.max(MIN_CLOUDFLARE_DRAIN_S, check.drainS) * 1000);
  await step.do("cf-disable", NETWORK_STEP, () => ops.disableAfterSwitch());
}

const never = (): never => {
  throw new Error("not available during a switch back");
};

// -----------------------------------------------------------------------------
// Step bodies
// -----------------------------------------------------------------------------

class CloudflareOps {
  private readonly env: Env;
  private readonly plan: CfPlan;
  private readonly host: CloudflareHost;

  constructor(host: CloudflareHost) {
    this.host = host;
    this.env = host.env;
    this.plan = host.plan;
  }

  private db(): Db {
    return createDb(this.env.DB);
  }

  private ctx() {
    return { db: this.db(), env: this.env };
  }

  private event(
    type: Parameters<typeof addDeploymentEvent>[3],
    message: string,
    data?: Record<string, unknown>,
  ) {
    return addDeploymentEvent(
      this.ctx(),
      this.plan.projectId,
      this.plan.deploymentId,
      type,
      message,
      data,
    );
  }

  private async stopped(
    expected: DeploymentStatus[],
  ): Promise<{ kind: "stop"; status: DeploymentStatus } | null> {
    const row = await this.db().query.deployments.findFirst({
      where: eq(deployments.id, this.plan.deploymentId),
      columns: { status: true },
    });
    if (!row) return { kind: "stop", status: "failed" };
    return expected.includes(row.status) ? null : { kind: "stop", status: row.status };
  }

  private async account(): Promise<CloudflareAccount> {
    const account = await loadCloudflareAccount(this.db(), this.env);
    if (!account)
      throw new Error(
        "Cloudflare is not configured: connect an account under Settings → Cloudflare",
      );
    return account;
  }

  private async cfd(id: string): Promise<CfDeploymentRow> {
    const row = await this.db().query.cfDeployments.findFirst({ where: eq(cfDeployments.id, id) });
    if (!row) throw new Error("The Cloudflare deployment record is gone");
    return row;
  }

  private async setCfd(id: string, values: Partial<typeof cfDeployments.$inferInsert>) {
    await this.db()
      .update(cfDeployments)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(cfDeployments.id, id));
  }

  private async runtime(): Promise<CfRuntimeRow> {
    const row = await runtimeOf(this.db(), this.plan.serviceId, this.plan.environmentId);
    if (!row) throw new Error("The Cloudflare runtime record is gone");
    return row;
  }

  private async setRuntime(values: Partial<typeof cfRuntimes.$inferInsert>) {
    await this.db()
      .update(cfRuntimes)
      .set({ ...values, updatedAt: new Date() })
      .where(
        and(
          eq(cfRuntimes.serviceId, this.plan.serviceId),
          eq(cfRuntimes.environmentId, this.plan.environmentId),
        ),
      );
  }

  // ---------------------------------------------------------------------------
  // 1. Prepare
  // ---------------------------------------------------------------------------

  async prepare(
    image: string,
    registryNodeId: string | null,
  ): Promise<
    { kind: "ok"; prep: Prepared } | { kind: "stop"; status: DeploymentStatus } | CfFailure
  > {
    const db = this.db();
    const plan = this.plan;
    const existing = await db.query.cfDeployments.findFirst({
      where: eq(cfDeployments.deploymentId, plan.deploymentId),
    });
    const stopped = await this.stopped(
      existing ? ["deploying"] : ["queued", "building", "deploying"],
    );
    if (stopped) return stopped;

    const account = await loadCloudflareAccount(db, this.env);
    const [config] = await db
      .select()
      .from(serviceConfigs)
      .where(
        and(
          eq(serviceConfigs.serviceId, plan.serviceId),
          eq(serviceConfigs.environmentId, plan.environmentId),
          eq(serviceConfigs.version, plan.configVersion),
        ),
      )
      .limit(1);
    if (!config) return fail(`Config version ${plan.configVersion} no longer exists`);
    const spec: ServiceConfigSpec = specOf(config);
    const placement = spec.placement.cloudflare;
    const service = await db.query.services.findFirst({ where: eq(services.id, plan.serviceId) });
    if (!service) return fail("The service was deleted");
    const facts = await cloudflareFactsFor(db, service, plan.environmentId, spec);
    const problems = await cloudflareProblems(db, facts);
    if (problems.length || !account || !placement || spec.networking.port === null) {
      return fail(
        `provider_ineligible: ${problems.map((p) => p.message).join("; ") || "placement.cloudflare is missing"}`,
        { problems },
      );
    }
    const instanceType = placement.instance_type ?? instanceTypeFor(spec.resources);
    if (!instanceType)
      return fail("provider_ineligible: no instance type fits the service's resources");

    const scriptName = await cloudflareScriptName(plan.serviceId, plan.environmentId);
    const runtime = await ensureRuntimeRow(db, plan.serviceId, plan.environmentId, scriptName);

    let imageRef: string;
    let digest: string | null = null;
    let push: Prepared["push"] = null;
    const deployment = await db.query.deployments.findFirst({
      where: eq(deployments.id, plan.deploymentId),
      columns: { rollbackOf: true },
    });
    const source = deployment?.rollbackOf
      ? await db.query.cfDeployments.findFirst({
          where: eq(cfDeployments.deploymentId, deployment.rollbackOf),
        })
      : undefined;
    if (existing) {
      imageRef = existing.imageRef;
      digest = existing.imageDigest;
      push =
        existing.pushId && existing.pushNodeId && image.startsWith(`${REGISTRY_LISTEN}/`)
          ? {
              pushId: existing.pushId,
              nodeId: existing.pushNodeId,
              source: image,
              target: existing.imageRef,
            }
          : null;
    } else if (source && source.status !== "failed") {
      // Rollback: the source's tag is still in Cloudflare's registry, so no push.
      imageRef = source.imageRef;
      digest = source.imageDigest;
    } else if (image.startsWith(`${REGISTRY_LISTEN}/`)) {
      if (!registryNodeId) return fail("No builder node holds the image to push to Cloudflare");
      imageRef = cloudflareImageTarget(account.account_id, scriptName, plan.deploymentId);
      push = {
        pushId: newId("imagePush"),
        nodeId: registryNodeId,
        source: image,
        target: imageRef,
      };
    } else if (isDirectlyPullable(image)) {
      imageRef = normalizeDockerHub(image);
    } else {
      return fail(
        `Cloudflare pulls images directly only from Docker Hub, Amazon ECR and Google Artifact Registry; ${image.split("/")[0]} is none of them. Deploy from git, or publish the image to one of those registries`,
      );
    }

    const previous = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.serviceId, plan.serviceId),
          eq(deployments.environmentId, plan.environmentId),
          inArray(deployments.status, ["active", "crashed"]),
          ne(deployments.id, plan.deploymentId),
        ),
      );
    const onNodes = previous.length
      ? await db
          .select({ id: placements.id })
          .from(placements)
          .where(
            inArray(
              placements.deploymentId,
              previous.map((p) => p.id),
            ),
          )
          .limit(1)
      : [];

    const generation = existing?.runtimeGeneration ?? runtime.generation + 1;
    const cfdId = existing?.id ?? newId("cfDeployment");
    if (!existing) {
      await db.batch([
        db.insert(cfDeployments).values({
          id: cfdId,
          deploymentId: plan.deploymentId,
          serviceId: plan.serviceId,
          environmentId: plan.environmentId,
          scriptName,
          namespaceId: runtime.namespaceId,
          applicationId: runtime.applicationId,
          imageRef,
          imageDigest: digest,
          pushId: push?.pushId ?? null,
          pushNodeId: push?.nodeId ?? null,
          runtimeGeneration: generation,
          instanceType,
          maxInstances: placement.max_instances,
          status: push ? "pushing" : "uploading",
        }),
        // A quick return to Cloudflare reuses the disabled runtime.
        db
          .update(cfRuntimes)
          .set({ deleteAfter: null, updatedAt: new Date() })
          .where(
            and(
              eq(cfRuntimes.serviceId, plan.serviceId),
              eq(cfRuntimes.environmentId, plan.environmentId),
            ),
          ),
      ]);
    }
    try {
      await transitionDeployment(this.ctx(), plan.projectId, plan.deploymentId, "deploying", {
        data: { provider: "cloudflare", script: scriptName },
      });
    } catch (err) {
      if (err instanceof IllegalTransitionError) return { kind: "stop", status: err.from };
      throw err;
    }
    return {
      kind: "ok",
      prep: {
        cfdId,
        scriptName,
        imageRef,
        push,
        generation,
        instanceType,
        maxInstances: placement.max_instances,
        regions: placement.regions?.length ? placement.regions : null,
        port: spec.networking.port,
        sleepAfter: placement.sleep_after,
        healthPath:
          spec.healthcheck?.type === "http" && spec.healthcheck.path ? spec.healthcheck.path : "/",
        drainS: spec.deploy.drain_s,
        previousOnNodes: onNodes.length > 0,
        wasActive: runtime.status === "active",
      },
    };
  }

  // ---------------------------------------------------------------------------
  // 2. Push
  // ---------------------------------------------------------------------------

  async sendPush(prep: Prepared): Promise<CfVerdict<object>> {
    const stopped = await this.stopped(DEPLOYING);
    if (stopped) return stopped;
    const push = prep.push!;
    const cfd = await this.cfd(prep.cfdId);
    if (cfd.imageDigest) return { kind: "ok" };
    if (cfd.status === "failed") return fail(cfd.error ?? "Image push failed");
    const node = await this.db().query.nodes.findFirst({
      where: eq(nodes.id, push.nodeId),
      columns: { name: true, encryptionPublicKey: true, protocolVersion: true },
    });
    if (!node) return fail("The builder node holding the image was removed");
    if (node.protocolVersion < IMAGE_PUSH_PROTOCOL_VERSION) {
      return builderOutdated(node.name, node.protocolVersion);
    }
    if (!node.encryptionPublicKey)
      return fail("The builder node has no encryption key for the registry login");
    const account = await this.account();
    const creds = await cfCall(() => clientFor(account).registryCredentials(["push"]));
    if (isFailure(creds)) return creds;
    // SECURITY: the registry login reaches the builder only inside a box it alone opens.
    const credentialSealed = await sealBox(
      node.encryptionPublicKey,
      JSON.stringify({ username: creds.username, password: creds.password }),
      "image-push",
      imagePushAad(push.nodeId, push.pushId),
    );
    const stub = this.env.NODE_CONNECTION.get(this.env.NODE_CONNECTION.idFromName(push.nodeId));
    const result = await stub.sendImagePush({
      push_id: push.pushId,
      source: push.source,
      target: push.target,
      platform: "linux/amd64",
      credential_sealed: credentialSealed,
      timeout_s: PUSH_TIMEOUT_S,
    });
    disposeRpc(result);
    if (!result.sent && result.reason === "protocol_too_old") {
      return builderOutdated(node.name, node.protocolVersion);
    }
    // Thrown so the step retries: the builder may be mid-reconnect.
    if (!result.sent) throw new Error(`The builder node ${node.name} is not connected`);
    return { kind: "ok" };
  }

  async checkPush(prep: Prepared): Promise<CfVerdict<object> | { kind: "pending" }> {
    const stopped = await this.stopped(DEPLOYING);
    if (stopped) return stopped;
    const cfd = await this.cfd(prep.cfdId);
    if (cfd.status === "failed") return fail(cfd.error ?? "Image push failed");
    if (!cfd.imageDigest) return { kind: "pending" };
    if (cfd.status === "pushing") {
      await this.setCfd(prep.cfdId, { status: "uploading" });
      await this.event("image_pushed", `Pushed the image to ${prep.imageRef}`, {
        image: prep.imageRef,
        digest: cfd.imageDigest,
        push_id: prep.push?.pushId,
      });
    }
    return { kind: "ok" };
  }

  // ---------------------------------------------------------------------------
  // 3. Script
  // ---------------------------------------------------------------------------

  /**
   * Uploads the runtime script for the generation of the Cloudflare
   * deployment `cfdId` (this one, or the previous one when reverting).
   */
  async script(prep: Prepared, cfdId: string): Promise<CfVerdict<object>> {
    if (cfdId === prep.cfdId) {
      const stopped = await this.stopped(DEPLOYING);
      if (stopped) return stopped;
    }
    const cfd = await this.cfd(cfdId);
    const db = this.db();
    const account = await this.account();
    const runtime = await this.runtime();
    if (cfdId === prep.cfdId) await this.setCfd(cfdId, { status: "uploading" });
    const hostnames = await runtimeHostnames(db, this.plan.serviceId, this.plan.environmentId);
    const config: RuntimeConfig = {
      service_id: this.plan.serviceId,
      environment_id: this.plan.environmentId,
      deployment_id: cfd.deploymentId,
      generation: cfd.runtimeGeneration,
      port: prep.port,
      max_instances: cfd.maxInstances,
      sleep_after: prep.sleepAfter,
      hostnames,
      health_path: prep.healthPath,
    };
    const namespaceId = await cfCall(() =>
      uploadRuntime(clientFor(account), this.env, {
        scriptName: prep.scriptName,
        config,
        namespaceId: runtime.namespaceId,
      }),
    );
    if (isFailure(namespaceId)) return namespaceId;
    await this.setRuntime({
      namespaceId,
      status: "active",
      generation: Math.max(runtime.generation, cfd.runtimeGeneration),
    });
    await this.setCfd(cfdId, { namespaceId });
    return { kind: "ok" };
  }

  // ---------------------------------------------------------------------------
  // 4. Application
  // ---------------------------------------------------------------------------

  async application(
    prep: Prepared,
  ): Promise<CfVerdict<{ applicationId: string; rolloutId: string | null }>> {
    const stopped = await this.stopped(DEPLOYING);
    if (stopped) return stopped;
    await this.setCfd(prep.cfdId, { status: "rolling_out" });
    const account = await this.account();
    const client = clientFor(account);
    const runtime = await this.runtime();
    const result = await cfCall(() => this.rollImage(client, runtime, prep, prep.imageRef));
    if (isFailure(result)) return result;
    await this.setCfd(prep.cfdId, { applicationId: result.applicationId });
    await this.event(
      "cf_rollout_started",
      result.rolloutId
        ? `Rolling out ${prep.imageRef} on Cloudflare (${prep.instanceType}, up to ${prep.maxInstances} instances)`
        : `Created the container application ${prep.scriptName} (${prep.instanceType}, up to ${prep.maxInstances} instances)`,
      {
        script: prep.scriptName,
        application_id: result.applicationId,
        rollout_id: result.rolloutId,
        generation: prep.generation,
        image: prep.imageRef,
      },
    );
    return { kind: "ok", ...result };
  }

  /** Creates the application, or rolls an existing one to `image`. */
  private async rollImage(
    client: CloudflareClient,
    runtime: CfRuntimeRow,
    prep: Prepared,
    image: string,
  ): Promise<{ applicationId: string; rolloutId: string | null }> {
    const configuration = { image, instance_type: prep.instanceType };
    let applicationId = runtime.applicationId;
    if (!applicationId) {
      // A crash between create and the row update leaves an application with our name.
      const found = (await client.listApplications()).find((a) => a.name === prep.scriptName);
      if (found) {
        applicationId = found.id;
      } else {
        const created = await client.createApplication({
          name: prep.scriptName,
          scheduling_policy: "default",
          instances: 0,
          max_instances: prep.maxInstances,
          configuration,
          durable_objects: { namespace_id: runtime.namespaceId! },
          ...(prep.regions ? { constraints: { regions: prep.regions } } : {}),
        });
        await this.setRuntime({ applicationId: created.id });
        return { applicationId: created.id, rolloutId: null };
      }
      await this.setRuntime({ applicationId });
    }
    const app = await client.getApplication(applicationId);
    if (app.max_instances !== prep.maxInstances || prep.regions) {
      await client.patchApplication(applicationId, {
        max_instances: prep.maxInstances,
        ...(prep.regions ? { constraints: { regions: prep.regions } } : {}),
      });
    }
    if (app.active_rollout_id && app.configuration?.image === image) {
      return { applicationId, rolloutId: app.active_rollout_id };
    }
    const rollout = await client.createRollout(applicationId, {
      description: `Roundhouse ${this.plan.deploymentId}`,
      strategy: "rolling",
      kind: "full_auto",
      step_percentage: 100,
      target_configuration: configuration,
    });
    return { applicationId, rolloutId: rollout.id };
  }

  async waitRollout(
    prep: Prepared,
    applicationId: string,
    rolloutId: string,
  ): Promise<CfVerdict<object>> {
    const { step } = this.host;
    const deadline = await step.do(
      "cf-rollout-deadline",
      async () => Date.now() + ROLLOUT_TIMEOUT_MS,
    );
    for (let i = 0; i < MAX_POLLS; i++) {
      const verdict = await step.do(`cf-rollout-check-${i}`, NETWORK_STEP, () =>
        this.checkRollout(applicationId, rolloutId),
      );
      if (verdict.kind !== "pending") {
        if (verdict.kind === "ok") {
          await step.do("cf-rollout-finished", DB_STEP, () =>
            this.event("cf_rollout_finished", "The Cloudflare rollout finished", {
              application_id: applicationId,
              rollout_id: rolloutId,
            }).then(() => true),
          );
        }
        return verdict;
      }
      if (Date.now() >= deadline) break;
      await step.sleep(`cf-rollout-wait-${i}`, ROLLOUT_POLL_MS);
    }
    return fail(
      `The Cloudflare rollout did not finish within ${ROLLOUT_TIMEOUT_MS / 60_000} minutes`,
      {
        application_id: applicationId,
        rollout_id: rolloutId,
        image: prep.imageRef,
      },
    );
  }

  private async checkRollout(
    applicationId: string,
    rolloutId: string,
  ): Promise<CfVerdict<object> | { kind: "pending" }> {
    const stopped = await this.stopped(DEPLOYING);
    if (stopped) return stopped;
    const client = clientFor(await this.account());
    const app = await cfCall(() => client.getApplication(applicationId));
    if (isFailure(app)) return app;
    if (app.active_rollout_id === rolloutId) return { kind: "pending" };
    const rollout = await cfCall(() => client.getRollout(applicationId, rolloutId));
    if (isFailure(rollout)) return { kind: "ok" };
    if (rollout.status === "completed") return { kind: "ok" };
    if (rollout.status === "progressing" || rollout.status === "pending")
      return { kind: "pending" };
    const detail = rollout.status_message ?? rollout.error;
    return fail(`The Cloudflare rollout ended ${rollout.status}${detail ? `: ${detail}` : ""}`, {
      application_id: applicationId,
      rollout_id: rolloutId,
    });
  }

  // ---------------------------------------------------------------------------
  // 5. Warm
  // ---------------------------------------------------------------------------

  async warm(prep: Prepared): Promise<CfVerdict<object>> {
    const { step } = this.host;
    const deadline = await step.do("cf-warm-deadline", async () => Date.now() + WARM_TIMEOUT_MS);
    let last = 0;
    for (let i = 0; i < MAX_POLLS; i++) {
      const verdict = await step.do(`cf-warm-${i}`, NETWORK_STEP, () => this.warmOnce(prep));
      if (verdict.kind !== "pending") return verdict;
      last = verdict.status;
      if (Date.now() >= deadline) break;
      await step.sleep(`cf-warm-wait-${i}`, WARM_POLL_MS);
    }
    return fail(
      `The service did not answer ${prep.healthPath} on Cloudflare within ${WARM_TIMEOUT_MS / 60_000} minutes (last answer: ${last || "no response"})`,
    );
  }

  private async warmOnce(
    prep: Prepared,
  ): Promise<CfVerdict<object> | { kind: "pending"; status: number }> {
    const stopped = await this.stopped(DEPLOYING);
    if (stopped) return stopped;
    await this.setCfd(prep.cfdId, { status: "warming" });
    const account = await this.account();
    const token = await mintRuntimeToken(this.env, {
      serviceId: this.plan.serviceId,
      environmentId: this.plan.environmentId,
      generation: prep.generation,
    });
    const status = await sendWarmUp(
      workersDevUrl(prep.scriptName, account.workers_subdomain, prep.healthPath),
      [RUNTIME_WARM_HEADER, await warmHeaderValue(token, prep.generation, Date.now())],
    );
    return status >= 200 && status < 300 ? { kind: "ok" } : { kind: "pending", status };
  }

  // ---------------------------------------------------------------------------
  // 6. Routes
  // ---------------------------------------------------------------------------

  async routes(prep: Prepared): Promise<CfVerdict<object>> {
    const stopped = await this.stopped(DEPLOYING);
    if (stopped) return stopped;
    await this.setCfd(prep.cfdId, { status: "routing" });
    const account = await this.account();
    if (!account.apps_zone) {
      return fail(
        "The apps domain is not in a zone of the Cloudflare account, so no Worker route can send it traffic",
      );
    }
    const runtime = await this.runtime();
    const hostnames = await runtimeHostnames(
      this.db(),
      this.plan.serviceId,
      this.plan.environmentId,
    );
    const routeIds = await cfCall(() =>
      switchRoutes(
        clientFor(account),
        account.apps_zone!.id,
        prep.scriptName,
        hostnames,
        runtime.routeIds,
      ),
    );
    if (isFailure(routeIds)) return routeIds;
    await this.setRuntime({ routeIds });
    await this.setCfd(prep.cfdId, { routeIds });
    await this.event(
      "routes_switched",
      hostnames.length
        ? `Traffic for ${hostnames.join(", ")} now goes to Cloudflare`
        : "No hostname to route; the service has no generated or SaaS domain",
      { hostnames, provider: "cloudflare" },
    );
    return { kind: "ok" };
  }

  // ---------------------------------------------------------------------------
  // 7. Finalize and garbage
  // ---------------------------------------------------------------------------

  async finalize(prep: Prepared): Promise<true> {
    const db = this.db();
    const now = new Date();
    await db.batch([
      db
        .update(cfDeployments)
        .set({ status: "removed", updatedAt: now })
        .where(
          and(
            eq(cfDeployments.serviceId, this.plan.serviceId),
            eq(cfDeployments.environmentId, this.plan.environmentId),
            eq(cfDeployments.status, "active"),
            ne(cfDeployments.id, prep.cfdId),
          ),
        ),
      db
        .update(cfDeployments)
        .set({ status: "active", error: null, updatedAt: now })
        .where(eq(cfDeployments.id, prep.cfdId)),
      db
        .update(cfRuntimes)
        .set({
          status: "active",
          activeDeploymentId: this.plan.deploymentId,
          disabledAt: null,
          deleteAfter: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(cfRuntimes.serviceId, this.plan.serviceId),
            eq(cfRuntimes.environmentId, this.plan.environmentId),
          ),
        ),
    ]);
    return true;
  }

  async collect(prep: Prepared): Promise<number> {
    try {
      const account = await this.account();
      return await collectImageTags(this.db(), clientFor(account), {
        serviceId: this.plan.serviceId,
        environmentId: this.plan.environmentId,
        scriptName: prep.scriptName,
      });
    } catch (err) {
      // Old tags only cost registry storage; never fail a live deployment over them.
      console.warn("cloudflare tag cleanup failed", err instanceof Error ? err.message : "error");
      return 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Failure
  // ---------------------------------------------------------------------------

  /**
   * Records a failure on the Cloudflare deployment and, when the script was
   * already replaced, puts the previous Cloudflare deployment back (new
   * generation, its image) so it keeps serving. Returns `outcome` for
   * `failDeployment`.
   */
  async abandon<T extends CfFailure | { kind: "stop"; status: DeploymentStatus }>(
    prep: Prepared,
    outcome: T,
    scriptTouched: boolean,
  ): Promise<T> {
    const reason = outcome.kind === "fail" ? outcome.reason : `Deployment ${outcome.status}`;
    await this.host.step.do("cf-fail", DB_STEP, async () => {
      await this.setCfd(prep.cfdId, { status: "failed", error: reason });
      if (!prep.wasActive) await this.setRuntime({ status: "disabled" });
      return true;
    });
    if (scriptTouched && prep.wasActive) {
      await this.host.step.do("cf-revert", NETWORK_STEP, () => this.revert(prep));
    }
    return outcome;
  }

  private async revert(prep: Prepared): Promise<string> {
    const db = this.db();
    const [previous] = await db
      .select()
      .from(cfDeployments)
      .where(
        and(
          eq(cfDeployments.serviceId, this.plan.serviceId),
          eq(cfDeployments.environmentId, this.plan.environmentId),
          eq(cfDeployments.status, "active"),
          ne(cfDeployments.id, prep.cfdId),
        ),
      )
      .orderBy(desc(cfDeployments.createdAt))
      .limit(1);
    if (!previous) return "nothing to revert to";
    try {
      const runtime = await this.runtime();
      const generation = runtime.generation + 1;
      await this.setCfd(previous.id, { runtimeGeneration: generation });
      const restored = await this.script(prep, previous.id);
      if (restored.kind !== "ok")
        throw new Error(restored.kind === "fail" ? restored.reason : "stopped");
      const account = await this.account();
      const client = clientFor(account);
      const current = await this.runtime();
      if (current.applicationId) {
        const app = await client.getApplication(current.applicationId);
        if (app.configuration?.image !== previous.imageRef) {
          await client.createRollout(current.applicationId, {
            description: `Roundhouse revert to ${previous.deploymentId}`,
            strategy: "rolling",
            kind: "full_auto",
            step_percentage: 100,
            target_configuration: {
              image: previous.imageRef,
              instance_type: previous.instanceType,
            },
          });
        }
      }
      await this.event(
        "cf_rollout_started",
        `Restored ${previous.imageRef} on Cloudflare after the failure`,
        {
          restored_deployment_id: previous.deploymentId,
          generation,
        },
      );
      return "reverted";
    } catch (err) {
      const message = err instanceof Error ? err.message : "error";
      await this.event(
        "error",
        `Could not restore the previous Cloudflare deployment: ${message}`,
        { restored_deployment_id: previous.deploymentId },
      );
      return "revert failed";
    }
  }

  // ---------------------------------------------------------------------------
  // Switch back
  // ---------------------------------------------------------------------------

  async switchCheck(): Promise<{ active: boolean; drainS: number }> {
    const db = this.db();
    const runtime = await runtimeOf(db, this.plan.serviceId, this.plan.environmentId);
    if (runtime?.status !== "active") return { active: false, drainS: 0 };
    const [config] = await db
      .select({ deploy: serviceConfigs.deploy })
      .from(serviceConfigs)
      .where(
        and(
          eq(serviceConfigs.serviceId, this.plan.serviceId),
          eq(serviceConfigs.environmentId, this.plan.environmentId),
          eq(serviceConfigs.version, this.plan.configVersion),
        ),
      )
      .limit(1);
    return { active: true, drainS: config?.deploy.drain_s ?? 0 };
  }

  async unroute(): Promise<boolean> {
    const runtime = await this.runtime();
    try {
      const account = await this.account();
      if (account.apps_zone)
        await removeRoutes(clientFor(account), account.apps_zone.id, runtime.routeIds);
    } catch (err) {
      if (
        err instanceof CloudflareProviderError &&
        err.status > 0 &&
        err.status < 500 &&
        err.status !== 429
      ) {
        await this.event("error", `Traffic is still on Cloudflare: ${err.message}`);
        return false;
      }
      throw err;
    }
    const hostnames = Object.keys(runtime.routeIds);
    await this.setRuntime({ routeIds: {} });
    await this.event(
      "routes_switched",
      hostnames.length
        ? `Traffic for ${hostnames.join(", ")} is back on nodes`
        : "No Worker route to remove; traffic is on nodes",
      { hostnames, provider: "nodes" },
    );
    return true;
  }

  async disableAfterSwitch(): Promise<boolean> {
    const runtime = await this.runtime();
    try {
      await disableRuntime(this.env, this.db(), runtime, {
        deleteAfter: new Date(Date.now() + CLOUDFLARE_DELETE_GRACE_MS),
        skipRoutes: true,
      });
    } catch (err) {
      if (
        err instanceof CloudflareProviderError &&
        err.status > 0 &&
        err.status < 500 &&
        err.status !== 429
      ) {
        await this.event("error", `Could not stop the Cloudflare instances: ${err.message}`);
        return false;
      }
      throw err;
    }
    return true;
  }
}

/** The `builder_outdated` failure. */
function builderOutdated(nodeName: string, version: number): CfFailure {
  return fail(
    `builder_outdated: ${nodeName} runs agent protocol ${version || "unknown"}; pushing images to Cloudflare needs ${IMAGE_PUSH_PROTOCOL_VERSION} or later. Upgrade its agent and deploy again`,
    { code: "builder_outdated" },
  );
}

/**
 * Docker Hub references with the registry and `library/` spelled out, the
 * form Cloudflare's image field takes.
 *
 * TODO: whether Cloudflare also accepts the short `nginx:1.27` form needs
 * a live account; the long form is accepted by every registry client.
 */
function normalizeDockerHub(image: string): string {
  const first = image.split("/")[0]!;
  const hasHost =
    image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  if (hasHost) return image;
  return `docker.io/${image.includes("/") ? image : `library/${image}`}`;
}
