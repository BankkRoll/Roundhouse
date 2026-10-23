/**
 * The deploy pipeline as a Cloudflare Workflow: one instance per deployment
 * (instance ID = deployment ID), so every step retries on its own and the
 * pipeline survives isolate restarts.
 *
 * Steps:
 * 1. `snapshot`: load the deployment and its exact config version; resolve
 *    the image (image source, rollback) or the commit to build (git).
 * 2. `resolve-variables`: resolve the service's variables, references and
 *    built-ins with `resolveServiceEnvironment` (the same resolver the
 *    variables API uses, so the two cannot disagree) and store the env
 *    sealed on the deployment. Done before the build so a broken reference
 *    fails in seconds, not after a build.
 * 3. Git only: `create-build` (pick a builder node, insert the build),
 *    `send-build-job` (signed, 60 s TTL, installation token when the repo is
 *    on an installation, secret build args marked so the builder never bakes
 *    them into the image), then wait for the `build` event the node's
 *    Durable Object sends on `build_result`, up to `BUILD_TIMEOUT_S`.
 * 4. `schedule`: place replicas with `schedule()` and write placements.
 * 5. `rollout`: bump every target node's generation and push desired state.
 * 6. Wait for the `health` event until every replica is `healthy`, up to
 *    `ROLLOUT_TIMEOUT_MS` (or `ROLLOUT_TIMEOUT_S`; see {@link rolloutTimeoutMs}).
 * 7. `finalize`: mark it `active`, supersede the previous deployment
 *    (`removed`, or `rolled_back` when this is a rollback) and push desired
 *    state again so agents drain the old replicas.
 *
 * Any failure marks the deployment `failed` with a reason, stops its build
 * on the builder (`build_cancel`) and pulls its replicas; the previous
 * deployment keeps serving because it is only touched in `finalize`. A
 * cancelled deployment is noticed at the start of every step and before
 * every wait. Events are only wake-ups: each wait is preceded by a step that
 * reads the truth from D1, so a lost or duplicate event changes nothing.
 *
 * @module
 */
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  builds,
  createDb,
  type Db,
  deployments,
  environments,
  nodes,
  placements,
  projects,
  serviceConfigs,
  services,
} from "@roundhouse/db";
import {
  buildCacheKey,
  EnvSchema,
  localImageRepository,
  MAX_WORKLOADS_PER_NODE,
  REGISTRY_LISTEN,
  SEALED_ENV_PROTOCOL_VERSION,
} from "@roundhouse/protocol";
import {
  BUILD_TIMEOUT_S,
  type BuildConfig,
  type DeploymentStatus,
  newId,
  ROLLOUT_TIMEOUT_MS,
  type SchedulerNode,
  schedule,
} from "@roundhouse/shared";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Env } from "../env";
import { recordAudit } from "../lib/audit";
import { type Sealed, sealWith, unsealWith } from "../lib/crypto";
import {
  addDeploymentEvent,
  cancelBuildsOnNodes,
  disposeRpc,
  IllegalTransitionError,
  type LifecycleContext,
  retireDeployments,
  transitionDeployment,
} from "../lib/deployments";
import {
  LIVE_DEPLOYMENT_STATUSES,
  refreshNodes,
  restartSpec,
  runsSealedWorkloads,
} from "../lib/desired-state";
import { resolveBranch } from "../lib/git";
import {
  type CommitState,
  createCommitStatus,
  githubFullName,
  InstallationAccessError,
  mintRepoToken,
} from "../lib/github";
import { effectiveStatus } from "../lib/nodes";
import { resolveServiceEnvironment } from "../lib/resolve-env";
import { deploymentEnvAad, projectKey } from "../lib/variables";

/** Parameters a deploy workflow instance is created with. */
export interface DeployParams {
  deployment_id: string;
  /** Control plane origin, for the link in GitHub commit statuses. */
  origin: string;
  /** Git sources: the commit to build. Without it the branch head is resolved. */
  commit?: { sha: string; message?: string | null; author?: string | null };
}

/** What a finished instance returns. */
export interface DeployOutput {
  status: DeploymentStatus;
  reason?: string;
}

/** Memory kept back on every node for the OS, Docker, the agent and Caddy. */
export const SYSTEM_RESERVED_MB = 256;

/** Shortest rollout timeout `ROLLOUT_TIMEOUT_S` may set; below it a cold image pull fails. */
const MIN_ROLLOUT_TIMEOUT_S = 10;

/**
 * How long a rollout waits for every replica to be healthy: `ROLLOUT_TIMEOUT_S`
 * when it is a whole number of seconds from {@link MIN_ROLLOUT_TIMEOUT_S} up to
 * `ROLLOUT_TIMEOUT_MS`, else `ROLLOUT_TIMEOUT_MS`. The override can only
 * shorten the wait, so a stray setting never leaves a deployment hanging longer.
 *
 * @param env - Bindings carrying the optional override.
 * @returns The timeout in milliseconds.
 * @example
 * rolloutTimeoutMs({ ROLLOUT_TIMEOUT_S: "45" }); // 45_000
 * rolloutTimeoutMs({}); // ROLLOUT_TIMEOUT_MS
 */
export function rolloutTimeoutMs(env: Pick<Env, "ROLLOUT_TIMEOUT_S">): number {
  const raw = env.ROLLOUT_TIMEOUT_S?.trim();
  if (!raw || !/^\d+$/.test(raw)) return ROLLOUT_TIMEOUT_MS;
  const ms = Number(raw) * 1000;
  return ms >= MIN_ROLLOUT_TIMEOUT_S * 1000 && ms <= ROLLOUT_TIMEOUT_MS ? ms : ROLLOUT_TIMEOUT_MS;
}

/** Human-readable duration for failure reasons: `45 seconds`, `10 minutes`. */
function describeDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s % 60 === 0 ? `${s / 60} minute${s === 60 ? "" : "s"}` : `${s} seconds`;
}

/** Extra time past `BUILD_TIMEOUT_S` for the builder to report its own timeout. */
const BUILD_GRACE_MS = 60_000;

/** Most wake-ups a wait loop handles before giving up on the deployment. */
const MAX_WAKEUPS = 100;

/**
 * Key prefix that carries build args through variable resolution, so they
 * may reference variables like any other value.
 */
const BUILD_ARG_PREFIX = "__ROUNDHOUSE_BUILD_ARG__";

/**
 * A service's build config as stored. `secret_build_args` is part of the
 * config API (`BuildConfigSchema`) but not yet of the shared type.
 */
type StoredBuildConfig = BuildConfig & { secret_build_args?: string[] };

/**
 * The names of `build_args` a config marks secret, limited to args it has.
 *
 * @param build - The service's build config.
 * @returns Sorted, distinct names.
 */
export function secretBuildArgNames(build: StoredBuildConfig | undefined): string[] {
  if (!build?.secret_build_args) return [];
  const names = new Set(build.secret_build_args.filter((n) => Object.hasOwn(build.build_args, n)));
  return [...names].sort();
}

const DB_STEP = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

const NETWORK_STEP = {
  retries: { limit: 4, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
} as const;

/** A step's verdict: carry on, stop quietly (cancelled/superseded), or fail. */
type Verdict<T> = ({ kind: "ok" } & T) | { kind: "stop"; status: DeploymentStatus } | Failure;

interface Failure {
  kind: "fail";
  reason: string;
  /**
   * Extra timeline data for the failure event, JSON-encoded: step results
   * must be serialisable, which an arbitrary record isn't to the type system.
   */
  data?: string;
}

const fail = (reason: string, data?: Record<string, unknown>): Failure => ({
  kind: "fail",
  reason,
  ...(data ? { data: JSON.stringify(data) } : {}),
});

/** Everything later steps need, captured once. Serialisable and secret-free. */
interface Plan {
  deploymentId: string;
  projectId: string;
  workspaceId: string;
  serviceId: string;
  serviceSlug: string;
  serviceName: string;
  environmentId: string;
  environmentSlug: string;
  configVersion: number;
  isRollback: boolean;
  /** Final image when known up front (image sources, rollbacks). */
  image: string | null;
  /** Node whose registry holds the image; set for locally built images. */
  registryNodeId: string | null;
  git: {
    repoUrl: string;
    branch: string;
    rootDir: string;
    /** Our `ghi_…` ID. */
    installationRef: string | null;
    commitSha: string;
    commitMessage: string | null;
    commitAuthor: string | null;
  } | null;
}

/** Runs one deployment through the pipeline. */
export class DeployWorkflow extends WorkflowEntrypoint<Env, DeployParams> {
  override async run(event: Readonly<WorkflowEvent<DeployParams>>, step: WorkflowStep) {
    const params = event.payload;
    const snap = await step.do("snapshot", NETWORK_STEP, () => this.snapshot(params));
    if (snap.kind === "stop") return { status: snap.status } satisfies DeployOutput;
    if (snap.kind === "fail") {
      return this.failDeployment(step, params, null, snap);
    }
    const plan = snap.plan;
    try {
      const outcome = await this.pipeline(step, params, plan);
      if (outcome.kind === "fail") return this.failDeployment(step, params, plan, outcome);
      return { status: outcome.status } satisfies DeployOutput;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return this.failDeployment(step, params, plan, fail(reason));
    }
  }

  private lifecycle(): LifecycleContext & { db: Db } {
    return { db: createDb(this.env.DB), env: this.env };
  }

  private async pipeline(
    step: WorkflowStep,
    params: DeployParams,
    plan: Plan,
  ): Promise<{ kind: "stop"; status: DeploymentStatus } | Failure> {
    if (plan.git) {
      await step.do("commit-status-pending", NETWORK_STEP, () =>
        this.commitStatus(params, plan, "pending", "Deploying"),
      );
    }

    const resolved = await step.do("resolve-variables", DB_STEP, () => this.resolveEnv(plan));
    if (resolved.kind !== "ok") return resolved;

    let image = plan.image;
    let registryNodeId = plan.registryNodeId;
    if (!image) {
      const created = await step.do("create-build", DB_STEP, () => this.createBuild(plan));
      if (created.kind !== "ok") return created;
      const sent = await step.do("send-build-job", NETWORK_STEP, () =>
        this.sendBuildJob(plan, created.buildId, created.nodeId, resolved.buildArgs),
      );
      if (sent.kind !== "ok") return sent;

      const deadline = await step.do(
        "build-deadline",
        async () => Date.now() + BUILD_TIMEOUT_S * 1000 + BUILD_GRACE_MS,
      );
      const built = await this.waitFor(step, "build", deadline, (i) =>
        step.do(`check-build-${i}`, DB_STEP, () => this.checkBuild(plan, created.buildId)),
      );
      if (built.kind !== "ok") {
        return built.kind === "timeout"
          ? fail(`Build did not finish within ${BUILD_TIMEOUT_S / 60} minutes`)
          : built;
      }
      image = built.image;
      registryNodeId = created.nodeId;
    }

    const scheduled = await step.do("schedule", DB_STEP, () =>
      this.schedule(plan, image!, registryNodeId),
    );
    if (scheduled.kind !== "ok") return scheduled;

    const rolled = await step.do("rollout", DB_STEP, () => this.rollout(plan, scheduled.nodeIds));
    if (rolled.kind !== "ok") return rolled;

    const timeoutMs = rolloutTimeoutMs(this.env);
    const deadline = await step.do("rollout-deadline", async () => Date.now() + timeoutMs);
    const healthy = await this.waitFor(step, "health", deadline, (i) =>
      step.do(`check-health-${i}`, DB_STEP, () => this.checkHealth(plan)),
    );
    if (healthy.kind !== "ok") {
      return healthy.kind === "timeout"
        ? fail(
            `Replicas did not become healthy within ${describeDuration(timeoutMs)}`,
            JSON.parse(
              await step.do("health-at-timeout", DB_STEP, () => this.replicaStates(plan)),
            ) as Record<string, unknown>,
          )
        : healthy;
    }

    const done = await step.do("finalize", DB_STEP, () => this.finalize(plan));
    if (done.kind !== "ok") return done;
    if (plan.git) {
      await step.do("commit-status-success", NETWORK_STEP, () =>
        this.commitStatus(params, plan, "success", "Deployed"),
      );
    }
    return { kind: "stop", status: "active" };
  }

  /**
   * Alternates a D1 check with a wait for a wake-up event until the check
   * settles or the deadline passes. Step names are indexed so a replay walks
   * the same sequence.
   */
  private async waitFor<T>(
    step: WorkflowStep,
    eventType: "build" | "health",
    deadline: number,
    check: (i: number) => Promise<Verdict<T> | { kind: "pending" }>,
  ): Promise<Verdict<T> | { kind: "timeout" }> {
    for (let i = 0; i < MAX_WAKEUPS; i++) {
      const verdict = await check(i);
      if (verdict.kind !== "pending") return verdict;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { kind: "timeout" };
      try {
        await step.waitForEvent(eventType, { type: eventType, timeout: remaining });
      } catch {
        // Timed out. One last look, in case the wake-up raced the deadline.
        const last = await check(i + 1);
        return last.kind === "pending" ? { kind: "timeout" } : last;
      }
    }
    return fail(`Gave up after ${MAX_WAKEUPS} ${eventType} updates without settling`);
  }

  // ---------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------

  private async snapshot(
    params: DeployParams,
  ): Promise<{ kind: "ok"; plan: Plan } | { kind: "stop"; status: DeploymentStatus } | Failure> {
    const { db } = this.lifecycle();
    const [row] = await db
      .select({
        deployment: deployments,
        service: services,
        project: projects,
        environment: environments,
        config: serviceConfigs,
      })
      .from(deployments)
      .innerJoin(services, eq(services.id, deployments.serviceId))
      .innerJoin(projects, eq(projects.id, services.projectId))
      .innerJoin(environments, eq(environments.id, deployments.environmentId))
      .leftJoin(
        serviceConfigs,
        and(
          eq(serviceConfigs.serviceId, deployments.serviceId),
          eq(serviceConfigs.environmentId, deployments.environmentId),
          eq(serviceConfigs.version, deployments.configVersion),
        ),
      )
      .where(eq(deployments.id, params.deployment_id))
      .limit(1);
    if (!row) return { kind: "stop", status: "failed" };
    const { deployment: d, service, project, environment, config } = row;
    if (d.status !== "queued") return { kind: "stop", status: d.status };
    if (service.deletedAt || project.deletedAt) return fail("The service was deleted");
    if (!config) return fail(`Config version ${d.configVersion} no longer exists`);

    const plan: Plan = {
      deploymentId: d.id,
      projectId: project.id,
      workspaceId: project.workspaceId,
      serviceId: service.id,
      serviceSlug: service.slug,
      serviceName: service.name,
      environmentId: environment.id,
      environmentSlug: environment.slug,
      configVersion: d.configVersion,
      isRollback: d.rollbackOf !== null,
      image: d.image,
      registryNodeId: null,
      git: null,
    };

    if (d.rollbackOf) {
      if (!d.image) return fail("The deployment rolled back to has no image");
      if (d.image.startsWith(`${REGISTRY_LISTEN}/`)) {
        plan.registryNodeId = await this.builderOf(db, d.rollbackOf);
      }
      return { kind: "ok", plan };
    }
    if (config.source.type === "image")
      return { kind: "ok", plan: { ...plan, image: config.source.image } };

    const source = config.source;
    let sha = params.commit?.sha ?? null;
    if (!sha) {
      try {
        const token = await this.repoToken(
          db,
          plan.workspaceId,
          source.github_installation_id ?? null,
          source.repo_url,
          { contents: "read" },
        );
        sha = await resolveBranch(source.repo_url, source.branch, token ?? undefined);
      } catch (err) {
        return fail(`Could not read ${source.repo_url}: ${(err as Error).message}`);
      }
      if (!sha) return fail(`Branch ${source.branch} not found in ${source.repo_url}`);
    }
    plan.image = null;
    plan.git = {
      repoUrl: source.repo_url,
      branch: source.branch,
      rootDir: source.root_dir,
      installationRef: source.github_installation_id ?? null,
      commitSha: sha,
      commitMessage: params.commit?.message ?? null,
      commitAuthor: params.commit?.author ?? null,
    };
    return { kind: "ok", plan };
  }

  /** The builder node of the build behind a (possibly chained) rollback source. */
  private async builderOf(db: Db, deploymentId: string): Promise<string | null> {
    let id: string | null = deploymentId;
    for (let hops = 0; id && hops < 32; hops++) {
      const row: { buildId: string | null; rollbackOf: string | null } | undefined =
        await db.query.deployments.findFirst({
          where: eq(deployments.id, id),
          columns: { buildId: true, rollbackOf: true },
        });
      if (!row) return null;
      if (row.buildId) {
        const build = await db.query.builds.findFirst({ where: eq(builds.id, row.buildId) });
        return build?.nodeId ?? null;
      }
      id = row.rollbackOf;
    }
    return null;
  }

  private async resolveEnv(plan: Plan): Promise<Verdict<{ buildArgs: Sealed | null }>> {
    const { db } = this.lifecycle();
    const stopped = await this.stopped(db, plan, ["queued"]);
    if (stopped) return stopped;
    const key = await projectKey(db, this.masterKey(), plan.projectId);
    const environment = await db.query.environments.findFirst({
      where: eq(environments.id, plan.environmentId),
    });
    if (!environment) return fail("The environment no longer exists");
    const [config] = await db
      .select({ build: serviceConfigs.build })
      .from(serviceConfigs)
      .where(
        and(
          eq(serviceConfigs.serviceId, plan.serviceId),
          eq(serviceConfigs.environmentId, plan.environmentId),
          eq(serviceConfigs.version, plan.configVersion),
        ),
      )
      .limit(1);
    const buildArgs = plan.git ? (config?.build.build_args ?? {}) : {};
    const result = await resolveServiceEnvironment(
      db,
      key,
      { projectId: plan.projectId, serviceId: plan.serviceId, environment },
      {
        deployment: {
          id: plan.deploymentId,
          commitSha: plan.git?.commitSha ?? null,
          configVersion: plan.configVersion,
        },
        extra: Object.fromEntries(
          Object.entries(buildArgs).map(([k, v]) => [`${BUILD_ARG_PREFIX}${k}`, v]),
        ),
      },
    );
    if (!result.ok) {
      const first = result.errors[0]!;
      const name = first.variable.name.startsWith(BUILD_ARG_PREFIX)
        ? `build arg ${first.variable.name.slice(BUILD_ARG_PREFIX.length)}`
        : `${first.variable.namespace}.${first.variable.name}`;
      return fail(`Variable ${name}: ${first.message}`, {
        errors: result.errors.map((e) => ({
          code: e.code,
          message: e.message,
          variable: `${e.variable.namespace}.${e.variable.name}`,
          ...(e.start !== undefined ? { start: e.start, end: e.end } : {}),
        })),
      });
    }
    const env: Record<string, string> = {};
    const args: Record<string, string> = {};
    for (const [k, v] of Object.entries(result.env)) {
      if (k.startsWith(BUILD_ARG_PREFIX)) args[k.slice(BUILD_ARG_PREFIX.length)] = v;
      else env[k] = v;
    }
    const checked = EnvSchema.safeParse(env);
    if (!checked.success) {
      return fail(`The resolved environment is too large: ${checked.error.issues[0]?.message}`);
    }
    await db
      .update(deployments)
      .set({
        envSealed: await sealWith(key, JSON.stringify(env), deploymentEnvAad(plan.deploymentId)),
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, plan.deploymentId));
    return {
      kind: "ok",
      buildArgs: plan.git
        ? await sealWith(key, JSON.stringify(args), `build-args:${plan.deploymentId}`)
        : null,
    };
  }

  private async createBuild(plan: Plan): Promise<Verdict<{ buildId: string; nodeId: string }>> {
    const ctx = this.lifecycle();
    const { db } = ctx;
    const current = await db.query.deployments.findFirst({
      where: eq(deployments.id, plan.deploymentId),
    });
    if (current?.buildId) {
      const build = await db.query.builds.findFirst({ where: eq(builds.id, current.buildId) });
      if (build?.nodeId) return { kind: "ok", buildId: build.id, nodeId: build.nodeId };
    }
    const stopped = await this.stopped(db, plan, ["queued"]);
    if (stopped) return stopped;

    const candidates = (
      await db
        .select()
        .from(nodes)
        .where(and(eq(nodes.workspaceId, plan.workspaceId), isNull(nodes.deletedAt)))
    ).filter(
      (n) =>
        effectiveStatus(n) === "online" &&
        n.capabilities?.builder &&
        n.capabilities.docker &&
        runsSealedWorkloads(n),
    );
    if (!candidates.length) {
      return fail(
        `No online builder node: one needs the builder capability, agent protocol ${SEALED_ENV_PROTOCOL_VERSION} or later and a registered encryption key`,
      );
    }
    // Reusing the last builder keeps BuildKit's layer cache warm.
    const [previous] = await db
      .select({ nodeId: builds.nodeId })
      .from(builds)
      .where(and(eq(builds.serviceId, plan.serviceId), eq(builds.status, "succeeded")))
      .orderBy(desc(builds.id))
      .limit(1);
    const node =
      candidates.find((n) => n.id === previous?.nodeId) ??
      candidates.sort((a, b) => (a.id < b.id ? -1 : 1))[0]!;

    const buildId = newId("build");
    await db.batch([
      db.insert(builds).values({
        id: buildId,
        deploymentId: plan.deploymentId,
        serviceId: plan.serviceId,
        commitSha: plan.git!.commitSha,
        commitMessage: plan.git!.commitMessage,
        commitAuthor: plan.git!.commitAuthor,
        status: "queued",
        nodeId: node.id,
        imageRepository: localImageRepository(plan.projectId, plan.serviceId),
      }),
      db.update(deployments).set({ buildId }).where(eq(deployments.id, plan.deploymentId)),
    ]);
    try {
      await transitionDeployment(ctx, plan.projectId, plan.deploymentId, "building");
    } catch (err) {
      if (err instanceof IllegalTransitionError) return { kind: "stop", status: err.from };
      throw err;
    }
    await addDeploymentEvent(
      ctx,
      plan.projectId,
      plan.deploymentId,
      "build_started",
      `Building ${plan.git!.commitSha.slice(0, 7)} on ${node.name}`,
      {
        build_id: buildId,
        node_id: node.id,
        commit_sha: plan.git!.commitSha,
      },
    );
    return { kind: "ok", buildId, nodeId: node.id };
  }

  private async sendBuildJob(
    plan: Plan,
    buildId: string,
    nodeId: string,
    sealedArgs: Sealed | null,
  ): Promise<Verdict<object>> {
    const { db } = this.lifecycle();
    const stopped = await this.stopped(db, plan, ["building"]);
    if (stopped) return stopped;
    const build = await db.query.builds.findFirst({ where: eq(builds.id, buildId) });
    if (build && build.status !== "queued") return { kind: "ok" };

    const [config] = await db
      .select({ build: serviceConfigs.build })
      .from(serviceConfigs)
      .where(
        and(
          eq(serviceConfigs.serviceId, plan.serviceId),
          eq(serviceConfigs.environmentId, plan.environmentId),
          eq(serviceConfigs.version, plan.configVersion),
        ),
      )
      .limit(1);
    const key = await projectKey(db, this.masterKey(), plan.projectId);
    const buildArgs = sealedArgs
      ? (JSON.parse(await unsealWith(key, sealedArgs, `build-args:${plan.deploymentId}`)) as Record<
          string,
          string
        >)
      : {};
    const git = plan.git!;
    let token: string | null;
    try {
      token = await this.repoToken(db, plan.workspaceId, git.installationRef, git.repoUrl, {
        contents: "read",
      });
    } catch (err) {
      if (err instanceof InstallationAccessError) return fail(err.message);
      throw err;
    }
    const builder = config?.build.builder ?? "railpack";
    const secretArgs = secretBuildArgNames(config?.build as StoredBuildConfig | undefined).filter(
      (name) => Object.hasOwn(buildArgs, name),
    );

    const stub = this.env.NODE_CONNECTION.get(this.env.NODE_CONNECTION.idFromName(nodeId));
    const result = await stub.sendBuildJob({
      build_id: buildId,
      deployment_id: plan.deploymentId,
      project_id: plan.projectId,
      service_id: plan.serviceId,
      source: {
        type: "git",
        url: git.repoUrl,
        commit_sha: git.commitSha,
        ref: git.branch,
        ...(token ? { token } : {}),
      },
      builder,
      ...(builder === "dockerfile" && config?.build.dockerfile_path
        ? { dockerfile_path: config.build.dockerfile_path }
        : {}),
      context_dir: git.rootDir,
      build_args: buildArgs,
      ...(secretArgs.length ? { secret_build_args: secretArgs } : {}),
      image_repository: localImageRepository(plan.projectId, plan.serviceId),
      cache_key: buildCacheKey(plan.projectId, plan.serviceId),
      timeout_s: BUILD_TIMEOUT_S,
    });
    disposeRpc(result);
    if (!result.sent && result.reason === "secret_build_args_unsupported") {
      return fail(
        "The builder's agent is too old for secret build args; upgrade it, or unmark the args",
      );
    }
    if (!result.sent) {
      // Thrown so the step retries: the builder may be mid-reconnect.
      throw new Error(
        result.reason === "protocol_too_old"
          ? "The builder's agent is too old to run builds"
          : "The builder node is not connected",
      );
    }
    await db
      .update(builds)
      .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(builds.id, buildId), eq(builds.status, "queued")));
    return { kind: "ok" };
  }

  private async checkBuild(
    plan: Plan,
    buildId: string,
  ): Promise<Verdict<{ image: string }> | { kind: "pending" }> {
    const ctx = this.lifecycle();
    const { db } = ctx;
    const stopped = await this.stopped(db, plan, ["building"]);
    if (stopped) return stopped;
    const build = await db.query.builds.findFirst({ where: eq(builds.id, buildId) });
    if (!build || build.status === "queued" || build.status === "running")
      return { kind: "pending" };
    if (build.status !== "succeeded" || !build.imageDigest) {
      await addDeploymentEvent(
        ctx,
        plan.projectId,
        plan.deploymentId,
        "build_finished",
        "Build failed",
        {
          build_id: buildId,
          error: build.error,
        },
      );
      return fail(`Build failed: ${build.error ?? build.status}`);
    }
    const image = `${build.imageRepository}@${build.imageDigest}`;
    await db
      .update(deployments)
      .set({ image, updatedAt: new Date() })
      .where(eq(deployments.id, plan.deploymentId));
    await addDeploymentEvent(
      ctx,
      plan.projectId,
      plan.deploymentId,
      "build_finished",
      "Build succeeded",
      {
        build_id: buildId,
        image_digest: build.imageDigest,
      },
    );
    return { kind: "ok", image };
  }

  private async schedule(
    plan: Plan,
    image: string,
    registryNodeId: string | null,
  ): Promise<Verdict<{ nodeIds: string[] }>> {
    const ctx = this.lifecycle();
    const { db } = ctx;
    const existing = await db
      .select({ nodeId: placements.nodeId })
      .from(placements)
      .where(eq(placements.deploymentId, plan.deploymentId));
    if (existing.length)
      return { kind: "ok", nodeIds: [...new Set(existing.map((p) => p.nodeId))] };

    const stopped = await this.stopped(db, plan, ["queued", "building"]);
    if (stopped) return stopped;
    if (plan.image === null) {
      await db.update(deployments).set({ image }).where(eq(deployments.id, plan.deploymentId));
    }
    try {
      await transitionDeployment(ctx, plan.projectId, plan.deploymentId, "deploying");
    } catch (err) {
      if (err instanceof IllegalTransitionError) return { kind: "stop", status: err.from };
      throw err;
    }

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

    const workspaceNodes = (
      await db
        .select()
        .from(nodes)
        .where(and(eq(nodes.workspaceId, plan.workspaceId), isNull(nodes.deletedAt)))
    ).filter(runsSealedWorkloads);
    const allocations = await db
      .select({
        nodeId: placements.nodeId,
        serviceId: deployments.serviceId,
        resources: serviceConfigs.resources,
      })
      .from(placements)
      .innerJoin(deployments, eq(deployments.id, placements.deploymentId))
      .innerJoin(
        serviceConfigs,
        and(
          eq(serviceConfigs.serviceId, deployments.serviceId),
          eq(serviceConfigs.environmentId, deployments.environmentId),
          eq(serviceConfigs.version, deployments.configVersion),
        ),
      )
      .where(
        and(
          inArray(deployments.status, [...LIVE_DEPLOYMENT_STATUSES]),
          ne(deployments.id, plan.deploymentId),
        ),
      );
    const schedulerNodes: SchedulerNode[] = workspaceNodes.map((n) => {
      const mine = allocations.filter((a) => a.nodeId === n.id);
      const serviceReplicas: Record<string, number> = {};
      for (const a of mine) serviceReplicas[a.serviceId] = (serviceReplicas[a.serviceId] ?? 0) + 1;
      const full = mine.length >= MAX_WORKLOADS_PER_NODE;
      return {
        id: n.id,
        status: effectiveStatus(n),
        docker: n.capabilities?.docker ?? false,
        labels: n.labels,
        cpuMillis: (n.cpuTotal ?? 0) * 1000,
        // A node at the protocol's workload cap is treated as full.
        memoryMb: full
          ? 0
          : Math.max(0, Math.floor((n.memTotal ?? 0) / 2 ** 20) - SYSTEM_RESERVED_MB),
        allocatedCpuMillis: mine.reduce((sum, a) => sum + a.resources.cpu_millis, 0),
        allocatedMemoryMb: mine.reduce((sum, a) => sum + a.resources.memory_mb, 0),
        serviceReplicas,
        // Until the Phase 2 mesh, only the builder itself can pull from its registry.
        reachesRegistry: registryNodeId !== null && n.id === registryNodeId,
      };
    });
    const result = schedule(
      {
        serviceId: plan.serviceId,
        replicas: config.deploy.replicas,
        cpuMillis: config.resources.cpu_millis,
        memoryMb: config.resources.memory_mb,
        nodeSelector: config.placement.node_selector,
        requiresRegistry: image.startsWith(`${REGISTRY_LISTEN}/`),
      },
      schedulerNodes,
    );
    if (!result.ok) {
      const reason =
        result.reason === "no_nodes"
          ? `No nodes run agent protocol ${SEALED_ENV_PROTOCOL_VERSION} or later with a registered encryption key`
          : `Could not place replica ${result.replica}: ${result.reason.replace(/_/g, " ")}`;
      await addDeploymentEvent(ctx, plan.projectId, plan.deploymentId, "schedule_failed", reason, {
        reason: result.reason,
        replica: result.replica,
        rejected: result.rejected,
      });
      return fail(reason);
    }
    await db.batch([
      db.insert(placements).values(
        result.placements.map((p) => ({
          id: newId("placement"),
          deploymentId: plan.deploymentId,
          replica: p.replica,
          nodeId: p.nodeId,
          workloadId: newId("workload"),
        })),
      ),
    ]);
    const nodeIds = [...new Set(result.placements.map((p) => p.nodeId))];
    await addDeploymentEvent(
      ctx,
      plan.projectId,
      plan.deploymentId,
      "scheduled",
      `Scheduled ${result.placements.length} replica(s) on ${nodeIds.length} node(s)`,
      { placements: result.placements },
    );
    return { kind: "ok", nodeIds };
  }

  private async rollout(plan: Plan, nodeIds: string[]): Promise<Verdict<object>> {
    const { db } = this.lifecycle();
    const stopped = await this.stopped(db, plan, ["deploying"]);
    if (stopped) return stopped;
    await refreshNodes(this.env, db, nodeIds);
    return { kind: "ok" };
  }

  /** Replica states as JSON, for the timeout event. */
  private async replicaStates(plan: Plan): Promise<string> {
    const { db } = this.lifecycle();
    const rows = await db
      .select({ replica: placements.replica, state: placements.state, nodeId: placements.nodeId })
      .from(placements)
      .where(eq(placements.deploymentId, plan.deploymentId));
    return JSON.stringify({ replicas: rows });
  }

  private async checkHealth(plan: Plan): Promise<Verdict<object> | { kind: "pending" }> {
    const { db } = this.lifecycle();
    const stopped = await this.stopped(db, plan, ["deploying"]);
    if (stopped) return stopped;
    const rows = await db
      .select({ state: placements.state, replica: placements.replica })
      .from(placements)
      .where(eq(placements.deploymentId, plan.deploymentId));
    if (rows.length && rows.every((r) => r.state === "healthy")) return { kind: "ok" };
    const [config] = await db
      .select({ deploy: serviceConfigs.deploy })
      .from(serviceConfigs)
      .where(
        and(
          eq(serviceConfigs.serviceId, plan.serviceId),
          eq(serviceConfigs.environmentId, plan.environmentId),
          eq(serviceConfigs.version, plan.configVersion),
        ),
      )
      .limit(1);
    // With `never`, a stopped replica stays stopped; waiting out the timeout helps no one.
    const dead = rows.find((r) => r.state === "crashed" || r.state === "exited");
    if (dead && config && restartSpec(config.deploy).policy === "never") {
      return fail(`Replica ${dead.replica} ${dead.state} and its restart policy is never`);
    }
    return { kind: "pending" };
  }

  private async finalize(plan: Plan): Promise<Verdict<object>> {
    const ctx = this.lifecycle();
    const { db } = ctx;
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
    // Recorded before the status flips so the timeline is complete the moment
    // a client sees `active`; skipped when a retry finds it already active.
    if (!(await this.stopped(db, plan, ["deploying"]))) {
      await addDeploymentEvent(
        ctx,
        plan.projectId,
        plan.deploymentId,
        "rollout_finished",
        "Every replica is healthy",
        { superseded: previous.map((p) => p.id) },
      );
    }
    try {
      await transitionDeployment(ctx, plan.projectId, plan.deploymentId, "active");
    } catch (err) {
      if (err instanceof IllegalTransitionError) return { kind: "stop", status: err.from };
      throw err;
    }
    const superseded = plan.isRollback ? "rolled_back" : "removed";
    for (const p of previous) {
      try {
        await transitionDeployment(ctx, plan.projectId, p.id, superseded, {
          data: { superseded_by: plan.deploymentId },
        });
      } catch (err) {
        if (!(err instanceof IllegalTransitionError)) throw err;
      }
    }
    await retireDeployments(
      ctx,
      previous.map((p) => p.id),
    );
    await this.audit(db, plan, "deployment.succeeded", {});
    return { kind: "ok" };
  }

  // ---------------------------------------------------------------------------
  // Failure
  // ---------------------------------------------------------------------------

  private async failDeployment(
    step: WorkflowStep,
    params: DeployParams,
    plan: Plan | null,
    failure: Failure,
  ): Promise<DeployOutput> {
    const status = await step.do("fail", DB_STEP, async () => {
      const ctx = this.lifecycle();
      const { db } = ctx;
      const projectId =
        plan?.projectId ??
        (
          await db
            .select({ projectId: services.projectId })
            .from(deployments)
            .innerJoin(services, eq(services.id, deployments.serviceId))
            .where(eq(deployments.id, params.deployment_id))
            .limit(1)
        )[0]?.projectId;
      if (!projectId) return "failed" as DeploymentStatus;
      // The build is settled first so nobody sees a failed deployment with a
      // running build, and stopped on its builder so the node is free for the
      // next one. A cancel already settled it, so this is then a no-op.
      const stopped = await db
        .update(builds)
        .set({ status: "failed", finishedAt: new Date(), error: failure.reason })
        .where(
          and(
            eq(builds.deploymentId, params.deployment_id),
            inArray(builds.status, ["queued", "running"]),
          ),
        )
        .returning({ id: builds.id, nodeId: builds.nodeId });
      await cancelBuildsOnNodes(ctx.env, stopped);
      try {
        await transitionDeployment(ctx, projectId, params.deployment_id, "failed", {
          reason: failure.reason,
        });
      } catch (err) {
        // Cancelled (or otherwise finished) meanwhile; leave it as it is.
        if (err instanceof IllegalTransitionError) return err.from;
        throw err;
      }
      await addDeploymentEvent(
        ctx,
        projectId,
        params.deployment_id,
        "error",
        failure.reason,
        failure.data ? (JSON.parse(failure.data) as Record<string, unknown>) : undefined,
      );
      await retireDeployments(ctx, [params.deployment_id]);
      if (plan) await this.audit(db, plan, "deployment.failed", { reason: failure.reason });
      return "failed" as DeploymentStatus;
    });
    if (plan?.git && status === "failed") {
      await step.do("commit-status-failure", NETWORK_STEP, () =>
        this.commitStatus(params, plan, "failure", failure.reason),
      );
    }
    return { status, reason: failure.reason };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private masterKey(): string {
    const key = this.env.MASTER_KEY?.trim();
    if (!key) throw new Error("MASTER_KEY is not configured");
    return key;
  }

  /** `stop` when the deployment left the statuses this step runs in (e.g. cancelled). */
  private async stopped(
    db: Db,
    plan: Plan,
    expected: DeploymentStatus[],
  ): Promise<{ kind: "stop"; status: DeploymentStatus } | null> {
    const row = await db.query.deployments.findFirst({
      where: eq(deployments.id, plan.deploymentId),
      columns: { status: true },
    });
    if (!row) return { kind: "stop", status: "failed" };
    return expected.includes(row.status) ? null : { kind: "stop", status: row.status };
  }

  /**
   * A token for the one repository the service tracks through an
   * installation, or `null` for public repositories. See {@link mintRepoToken}.
   */
  private repoToken(
    db: Db,
    workspaceId: string,
    installationRef: string | null,
    repoUrl: string,
    permissions: Record<string, string>,
  ): Promise<string | null> {
    if (!installationRef) return Promise.resolve(null);
    return mintRepoToken(db, this.env, {
      workspaceId,
      installationRef,
      repoUrl,
      permissions,
    });
  }

  /** Best-effort GitHub commit status; never fails the deployment. */
  private async commitStatus(
    params: DeployParams,
    plan: Plan,
    state: CommitState,
    description: string,
  ): Promise<boolean> {
    const git = plan.git;
    const fullName = git ? githubFullName(git.repoUrl) : null;
    if (!git || !fullName || !git.installationRef) return false;
    try {
      const { db } = this.lifecycle();
      const token = await this.repoToken(db, plan.workspaceId, git.installationRef, git.repoUrl, {
        statuses: "write",
      });
      if (!token) return false;
      await createCommitStatus(token, fullName, git.commitSha, {
        state,
        target_url: `${params.origin}/deployments/${plan.deploymentId}`,
        description,
        context: `roundhouse/${plan.serviceSlug}/${plan.environmentSlug}`,
      });
      return true;
    } catch (err) {
      console.warn("commit status failed", err);
      return false;
    }
  }

  private async audit(
    db: Db,
    plan: Plan,
    action: "deployment.succeeded" | "deployment.failed",
    metadata: Record<string, unknown>,
  ) {
    await recordAudit(db, {
      workspaceId: plan.workspaceId,
      actorType: "system",
      actorId: null,
      action,
      targetType: "deployment",
      targetId: plan.deploymentId,
      metadata: {
        service_id: plan.serviceId,
        environment_id: plan.environmentId,
        ...metadata,
      },
    });
  }
}
