/**
 * A database added through the API and running on fake protocol 5 agents
 * that play every part of the data follow-ups: deployments (workloads
 * healthy, volumes ready), backups and copy-outs, restores and copy-ins,
 * and `db_query` (provisioning, `set_password`). Shared by the restore into
 * a new service, volume migration, TCP proxy and credential rotation tests.
 */
import { env } from "cloudflare:test";
import type { JoinResponse } from "@roundhouse/protocol";
import { setS3Transport } from "../src/lib/s3";
import {
  connectDataAgent,
  type DataAgentBehaviour,
  type FakeDataAgent,
  STORAGE_BODY,
} from "./backups-helpers";
import { FakeS3 } from "./fake-s3";
import { type Client, eventually, type Installed, install, joinNode } from "./helpers";
import { createProject, type ProjectDetailBody, waitForStatus } from "./pipeline-helpers";

/** Capabilities of an up-to-date agent. */
export const FULL_CAPABILITIES = {
  docker: true,
  gvisor: false,
  builder: true,
  tcp_proxy: true,
  db_set_password: true,
};

/** One joined, connected node. */
export interface StageNode {
  joined: JoinResponse;
  agent: FakeDataAgent;
}

/** What {@link databaseStage} built. */
export interface DatabaseStage {
  installed: Installed;
  owner: Client;
  workspaceId: string;
  project: ProjectDetailBody;
  envId: string;
  fake: FakeS3;
  nodes: StageNode[];
  serviceId: string;
  serviceSlug: string;
  volumeId: string;
  deploymentId: string;
  /** The node the database was placed on. */
  home: StageNode;
}

/** Options of {@link databaseStage}. */
export interface DatabaseStageOptions {
  engine?: "postgres" | "mysql" | "redis" | "mongodb";
  /** Nodes to join; the database lands on one of them. */
  nodes?: number;
  /** `hello` overrides per node index. */
  hello?: (index: number) => Record<string, unknown>;
  behaviour?: DataAgentBehaviour;
  /** Configure the fake S3 as backup storage. */
  storage?: boolean;
}

/** The default answers: everything succeeds. */
export const HEALTHY: DataAgentBehaviour = {
  backup: "ok",
  restore: "ok",
  workloads: "healthy",
  query: "ok",
};

/**
 * Installs, joins and connects nodes, and adds a database through
 * `POST /v1/projects/{id}/databases`, waiting until it runs healthy with
 * its volume ready.
 *
 * @param options - Engine, node count and agent behaviour.
 * @returns The stage.
 */
export async function databaseStage(options: DatabaseStageOptions = {}): Promise<DatabaseStage> {
  const fake = new FakeS3();
  setS3Transport(fake.fetch);
  const installed = await install();
  const { owner, workspaceId } = installed;
  const nodes: StageNode[] = [];
  for (let i = 0; i < (options.nodes ?? 1); i++) {
    const name = `node-${i + 1}`;
    const joined = await joinNode(owner, workspaceId, {
      name,
      hostname: name,
      public_ip: `203.0.113.${10 + i}`,
    });
    const agent = await connectDataAgent(
      joined,
      fake,
      { ...(options.behaviour ?? HEALTHY) },
      {
        volume_quota: "loop",
        capabilities: FULL_CAPABILITIES,
        ...(options.hello?.(i) ?? {}),
      },
    );
    nodes.push({ joined, agent });
  }
  const project = await createProject(owner, workspaceId);
  const envId = project.environments.find((e) => e.kind === "production")!.id;
  if (options.storage !== false) {
    const res = await owner.json("/v1/instance/backup-storage", {
      method: "PUT",
      json: STORAGE_BODY,
    });
    if (res.status !== 200) throw new Error(`storage setup failed: ${JSON.stringify(res.body)}`);
  }
  const created = await owner.json<{
    service: { id: string; slug: string };
    volumes: { id: string; environment_id: string }[];
    deployment_ids: string[];
  }>(`/v1/projects/${project.id}/databases`, {
    method: "POST",
    json: { engine: options.engine ?? "postgres", environment_id: envId, deploy: true },
  });
  if (created.status !== 201) {
    throw new Error(`adding the database failed: ${JSON.stringify(created.body)}`);
  }
  const deploymentId = created.body.deployment_ids[0]!;
  await waitForStatus(owner, deploymentId, ["active"]);
  const volumeId = created.body.volumes.find((v) => v.environment_id === envId)!.id;
  const nodeId = await eventually(async () => {
    const row = await env.DB.prepare("SELECT node_id, status FROM volumes WHERE id = ?")
      .bind(volumeId)
      .first<{ node_id: string | null; status: string }>();
    return row?.status === "ready" && row.node_id ? row.node_id : undefined;
  }, 10_000);
  return {
    installed,
    owner,
    workspaceId,
    project,
    envId,
    fake,
    nodes,
    serviceId: created.body.service.id,
    serviceSlug: created.body.service.slug,
    volumeId,
    deploymentId,
    home: nodes.find((n) => n.joined.node_id === nodeId)!,
  };
}

/**
 * Polls until `read` returns a value with a status in `statuses`.
 *
 * @param read - Reads the resource.
 * @param statuses - Statuses that end the wait.
 * @param timeoutMs - Deadline.
 * @returns The last read.
 */
export async function waitForState<T extends { status: string }>(
  read: () => Promise<T>,
  statuses: string[],
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const body = await read();
    if (statuses.includes(body.status)) return body;
    if (Date.now() > deadline) throw new Error(`stuck in ${body.status}: ${JSON.stringify(body)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
