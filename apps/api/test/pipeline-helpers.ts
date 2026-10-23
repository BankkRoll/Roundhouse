/**
 * Phase 1 test helpers on top of `./helpers`: projects and services, a
 * protocol 4 fake agent that plays its part in rollouts (answers
 * `build_job`, reports workload health), and deployment polling.
 */
import { env, SELF } from "cloudflare:test";
import { createDb } from "@roundhouse/db";
import {
  buildSecretsAad,
  type ControlMessage,
  type DesiredState,
  type JoinResponse,
  openBox,
  SEALED_ENV_PROTOCOL_VERSION,
  SealedBuildSecretsSchema,
  SealedWorkloadEnvSchema,
  verifyEnvelope,
  workloadEnvAad,
} from "@roundhouse/protocol";
import { cancelDeployment, IllegalTransitionError } from "../src/lib/deployments";
import {
  type Client,
  eventually,
  type FakeAgent,
  hello,
  type Installed,
  install,
  joinNode,
  NODE_ENCRYPTION_PRIVATE_KEY,
  ORIGIN,
} from "./helpers";

/** Shape of a project detail response, as far as tests read it. */
export interface ProjectDetailBody {
  id: string;
  workspace_id: string;
  slug: string;
  environments: { id: string; slug: string; kind: string }[];
  services: { id: string }[];
}

/** Creates a project and returns its detail (with the production environment). */
export async function createProject(
  owner: Client,
  workspaceId: string,
  body: Record<string, unknown> = { name: "Storefront" },
): Promise<ProjectDetailBody> {
  const res = await owner.json<ProjectDetailBody>(`/v1/workspaces/${workspaceId}/projects`, {
    method: "POST",
    json: body,
  });
  if (res.status !== 201) {
    throw new Error(`create project failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

/** A created service with its config versions. */
export interface CreatedServiceBody {
  service: { id: string; slug: string; name: string };
  configs: { environment_id: string; version: number; networking: { port: number | null } }[];
}

/** An nginx image service listening on 8080. */
export const IMAGE_SERVICE = { name: "web", source: { type: "image", image: "nginx:1.27" } };

/** Creates a service (an nginx image by default). */
export async function createService(
  c: Client,
  projectId: string,
  body: Record<string, unknown> = IMAGE_SERVICE,
): Promise<CreatedServiceBody> {
  const res = await c.json<CreatedServiceBody>(`/v1/projects/${projectId}/services`, {
    method: "POST",
    json: body,
  });
  if (res.status !== 201) {
    throw new Error(`create service failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

/** How a {@link FakeWorkloadAgent} answers. Mutable while connected. */
export interface AgentBehaviour {
  /** Answer to `build_job`: succeed (default), fail, or stay silent. */
  build?: "ok" | "fail" | "silent";
  /** Status reported for each new workload in `desired_state`. */
  health?: "healthy" | "silent" | "crashed";
  /** Build log lines sent before the result. */
  buildLogs?: string[];
}

/** A protocol 2 agent that verifies every control frame and plays its part in rollouts. */
export interface FakeWorkloadAgent extends FakeAgent {
  /** Every verified control payload, in arrival order. */
  received: ControlMessage[];
  /** Envelope rejections seen; stays empty when every frame verifies. */
  rejected: string[];
  /** Raw envelopes as received. */
  frames: string[];
  behaviour: AgentBehaviour;
  /** Latest desired state received. */
  desired(): DesiredState | undefined;
  /** Opened environment of a workload, from the latest frame that carried it. */
  env(workloadId: string): Record<string, string> | undefined;
  /** Opened `mount_as_file` values of a workload, from the latest frame that carried it. */
  files(workloadId: string): Record<string, string> | undefined;
  /** Opened `build_secrets_sealed` of a build job; `undefined` when it carried none. */
  buildSecrets(buildId: string): Record<string, string> | undefined;
  /** Resolves with the first control payload matching `predicate`, waiting if needed. */
  waitFor<T extends ControlMessage>(
    predicate: (m: ControlMessage) => m is T,
    timeoutMs?: number,
  ): Promise<T>;
}

/** A valid container ID for fake statuses. */
export const CONTAINER_ID = "0123456789ab";

/** The digest every fake build produces. */
export const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;

/** Predicate for `desired_state` payloads. */
export const isDesired = (m: ControlMessage): m is DesiredState => m.type === "desired_state";

/**
 * Connects a protocol 4 agent that verifies envelopes, opens each workload's
 * sealed environment with {@link NODE_ENCRYPTION_PRIVATE_KEY} (a box that
 * fails to open counts as a rejection), answers `build_job` with a
 * `build_result`, and reports a status for each new workload.
 *
 * @param joined - Join response for the node.
 * @param behaviour - How to answer.
 * @param helloOverrides - Extra `hello` fields (e.g. `protocol_version: 3`).
 */
export async function connectWorkloadAgent(
  joined: JoinResponse,
  behaviour: AgentBehaviour = {},
  helloOverrides: Record<string, unknown> = {},
): Promise<FakeWorkloadAgent> {
  const res = await SELF.fetch(`${ORIGIN}/v1/nodes/${joined.node_id}/connect`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${joined.credential}` },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error(`connect failed: ${res.status} ${await res.text()}`);
  ws.accept();

  const received: ControlMessage[] = [];
  const rejected: string[] = [];
  const frames: string[] = [];
  const queue: string[] = [];
  const rawWaiters: ((v: string) => void)[] = [];
  const listeners = new Set<() => void>();
  const known = new Set<string>();
  const envs = new Map<string, Record<string, string>>();
  const files = new Map<string, Record<string, string>>();
  const buildSecrets = new Map<string, Record<string, string>>();
  const send = (frame: unknown) =>
    ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));

  const agent: FakeWorkloadAgent = {
    ws,
    received,
    rejected,
    frames,
    behaviour,
    closed: new Promise((resolve) => {
      ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason }));
    }),
    next: () => {
      const queued = queue.shift();
      return queued !== undefined
        ? Promise.resolve(queued)
        : new Promise<string>((resolve) => rawWaiters.push(resolve));
    },
    send,
    desired: () => [...received].reverse().find(isDesired),
    env: (workloadId) => envs.get(workloadId),
    files: (workloadId) => files.get(workloadId),
    buildSecrets: (buildId) => buildSecrets.get(buildId),
    waitFor<T extends ControlMessage>(predicate: (m: ControlMessage) => m is T, timeoutMs = 8000) {
      return new Promise<T>((resolve, reject) => {
        const check = () => {
          const found = received.find(predicate);
          if (!found) return false;
          clearTimeout(timer);
          listeners.delete(check);
          resolve(found);
          return true;
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error("control frame not received in time"));
        }, timeoutMs);
        if (!check()) listeners.add(check);
      });
    },
  };

  const onControl = (m: ControlMessage) => {
    if (m.type === "build_job") {
      for (const text of agent.behaviour.buildLogs ?? []) {
        send({
          type: "logs",
          source: { type: "build", build_id: m.build_id },
          lines: [{ ts: Date.now(), stream: "stdout", text }],
        });
      }
      if (agent.behaviour.build === "silent") return;
      send(
        agent.behaviour.build === "fail"
          ? {
              type: "build_result",
              build_id: m.build_id,
              ok: false,
              error: "exit status 1",
              duration_ms: 5,
            }
          : {
              type: "build_result",
              build_id: m.build_id,
              ok: true,
              image: { repository: m.image_repository, digest: IMAGE_DIGEST },
              duration_ms: 5,
            },
      );
    }
    if (m.type === "desired_state") {
      const health = agent.behaviour.health ?? "healthy";
      for (const w of m.workloads) {
        if (known.has(w.id)) continue;
        known.add(w.id);
        if (health === "silent") continue;
        send({
          type: "workload_status",
          workload_id: w.id,
          deployment_id: w.deployment_id,
          state: health,
          container_id: CONTAINER_ID,
          restarts: 0,
          ts: Date.now(),
          ...(health === "crashed" ? { exit_code: 1 } : {}),
        });
      }
    }
  };

  const onFrame = async (data: string) => {
    frames.push(data);
    const waiter = rawWaiters.shift();
    if (waiter) waiter(data);
    else queue.push(data);
    const verified = await verifyEnvelope(
      JSON.parse(data),
      joined.control_public_key,
      joined.node_id,
    );
    if (!verified.ok) {
      rejected.push(verified.reason);
      return;
    }
    const m = verified.message;
    if (m.type === "desired_state") {
      for (const w of m.workloads) {
        try {
          const pt = await openBox(
            NODE_ENCRYPTION_PRIVATE_KEY,
            w.env_sealed!,
            "workload-env",
            workloadEnvAad(joined.node_id, w.id, m.generation),
          );
          const opened = SealedWorkloadEnvSchema.parse(JSON.parse(new TextDecoder().decode(pt)));
          envs.set(w.id, opened.env);
          files.set(w.id, opened.files);
        } catch {
          rejected.push(`env_sealed:${w.id}`);
        }
      }
    }
    if (m.type === "build_job" && m.build_secrets_sealed) {
      try {
        const pt = await openBox(
          NODE_ENCRYPTION_PRIVATE_KEY,
          m.build_secrets_sealed,
          "build-secrets",
          buildSecretsAad(joined.node_id, m.build_id),
        );
        buildSecrets.set(
          m.build_id,
          SealedBuildSecretsSchema.parse(JSON.parse(new TextDecoder().decode(pt))).secrets,
        );
      } catch {
        rejected.push(`build_secrets_sealed:${m.build_id}`);
      }
    }
    received.push(m);
    onControl(m);
    for (const l of [...listeners]) l();
  };
  ws.addEventListener("message", (e) => {
    void onFrame(e.data as string);
  });

  send(
    hello(joined.node_id, {
      protocol_version: SEALED_ENV_PROTOCOL_VERSION,
      statuses: [],
      ...helloOverrides,
    }),
  );
  await agent.waitFor(isDesired);
  return agent;
}

/** An installed control plane with a project, a service and a connected v2 builder node. */
export interface Stage {
  installed: Installed;
  owner: Client;
  workspaceId: string;
  project: ProjectDetailBody;
  envId: string;
  serviceId: string;
  joined: JoinResponse;
  agent: FakeWorkloadAgent;
}

/**
 * Installs, joins and connects a v2 builder node, and creates a project with
 * one service ready to deploy.
 *
 * @param service - Service body; {@link IMAGE_SERVICE} by default.
 * @param behaviour - How the fake agent answers.
 */
export async function stage(
  service: Record<string, unknown> = IMAGE_SERVICE,
  behaviour: AgentBehaviour = {},
): Promise<Stage> {
  const installed = await install();
  const { owner, workspaceId } = installed;
  const joined = await joinNode(owner, workspaceId);
  const agent = await connectWorkloadAgent(joined, behaviour);
  const project = await createProject(owner, workspaceId);
  const created = await createService(owner, project.id, service);
  return {
    installed,
    owner,
    workspaceId,
    project,
    envId: project.environments[0]!.id,
    serviceId: created.service.id,
    joined,
    agent,
  };
}

/** A deployment as tests read it. */
export interface DeploymentBody {
  id: string;
  service_id: string;
  status: string;
  trigger: string;
  image: string | null;
  failure_reason: string | null;
  build_id: string | null;
  build: {
    id: string;
    status: string;
    image_digest: string | null;
    node_id: string | null;
    commit_sha: string;
    commit_message: string | null;
  } | null;
  rollback_of: string | null;
  config_version: number;
  events?: { type: string; message: string; data: Record<string, unknown> | null }[];
  placements?: { node_id: string; workload_id: string; state: string; replica: number }[];
}

/** Starts a deployment and returns it. */
export async function deploy(
  c: Client,
  serviceId: string,
  envId: string,
  body: Record<string, unknown> = {},
): Promise<DeploymentBody> {
  const res = await c.json<DeploymentBody>(
    `/v1/services/${serviceId}/deployments?environment_id=${envId}`,
    { method: "POST", json: body },
  );
  if (res.status !== 201) {
    throw new Error(`deploy failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

/** Statuses the deploy workflow ends in, shortly after writing them. */
const WORKFLOW_FINAL_STATUSES = new Set(["active", "failed", "cancelled"]);

/** Workflow instance states after which it touches nothing. */
const INSTANCE_DONE = new Set(["complete", "errored", "terminated"]);

/** Waits until the deploy workflow instance `id` will touch nothing more. */
function instanceDone(id: string, timeoutMs: number): Promise<true> {
  return eventually(async () => {
    try {
      const instance = await env.DEPLOY_WORKFLOW.get(id);
      return INSTANCE_DONE.has((await instance.status()).status) ? true : undefined;
    } catch {
      return true; // no instance: nothing can outlive the test
    }
  }, timeoutMs);
}

/**
 * Cancels every deployment still in flight and waits for each workflow
 * instance to finish. Call it before disposing the workflow introspector: a
 * disposed introspector aborts running instances, and an instance aborted
 * mid-wait fails its deployment in a context that no longer exists (workerd
 * then logs an uncaught "execution context … is no longer running").
 */
export async function settleDeployments(timeoutMs = 10_000): Promise<void> {
  const ctx = { db: createDb(env.DB), env };
  const live = await env.DB.prepare(
    `SELECT d.id, s.project_id FROM deployments d JOIN services s ON s.id = d.service_id
     WHERE d.status IN ('queued', 'building', 'deploying')`,
  ).all<{ id: string; project_id: string }>();
  for (const d of live.results) {
    try {
      await cancelDeployment(ctx, d.project_id, d.id, "The test finished");
    } catch (err) {
      if (!(err instanceof IllegalTransitionError)) throw err;
    }
  }
  const all = await env.DB.prepare(
    "SELECT id FROM deployments WHERE workflow_instance_id IS NOT NULL",
  ).all<{ id: string }>();
  await Promise.all(all.results.map((d) => instanceDone(d.id, timeoutMs)));
}

/**
 * Polls a deployment until its status is one of `statuses`. When that status
 * is one the workflow ends in, it also waits for the workflow instance to
 * finish: the status is written a step before the end, and a test that
 * returns in between tears the instance down mid-step (workerd then logs
 * "The execution context which hosts this callback is no longer running").
 */
export async function waitForStatus(
  c: Client,
  deploymentId: string,
  statuses: string[],
  timeoutMs = 20_000,
): Promise<DeploymentBody> {
  const body = await eventually(async () => {
    const res = await c.json<DeploymentBody>(`/v1/deployments/${deploymentId}`);
    return statuses.includes(res.body.status) ? res.body : undefined;
  }, timeoutMs);
  if (WORKFLOW_FINAL_STATUSES.has(body.status)) await instanceDone(deploymentId, timeoutMs);
  return body;
}

/** A full commit SHA for git deployments. */
export const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567";

/** A public git service body. */
export const GIT_SERVICE = {
  name: "api",
  source: {
    type: "git",
    repo_url: "https://github.com/acme/api",
    branch: "main",
    root_dir: ".",
  },
};
