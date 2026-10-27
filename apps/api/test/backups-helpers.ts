/**
 * Backup and restore test helpers: a project with a service, a volume on a
 * joined protocol 5 node, backup storage pointed at the fake S3, and a fake
 * agent that opens every sealed box with the test node key and plays its
 * part in backups (uploading parts to presigned URLs) and restores
 * (downloading the object and checking its digest).
 */
import { env, SELF } from "cloudflare:test";
import {
  BACKUPS_PROTOCOL_VERSION,
  type BackupJob,
  backupPartsAad,
  type ControlMessage,
  type DbQuery,
  type DesiredState,
  dbCredentialAad,
  type JoinResponse,
  openBox,
  type RestoreJob,
  restoreSecretsAad,
  SealedBackupPartsSchema,
  type SealedBox,
  type SealedDbCredential,
  SealedDbCredentialSchema,
  SealedRestoreSecretsSchema,
  type VolumeCopyIn,
  type VolumeCopyOut,
  verifyEnvelope,
} from "@roundhouse/protocol";
import { newId } from "@roundhouse/shared";
import { setS3Transport, sha256Hex } from "../src/lib/s3";
import { FAKE_S3, FakeS3 } from "./fake-s3";
import {
  type Client,
  hello,
  type Installed,
  install,
  joinNode,
  NODE_ENCRYPTION_PRIVATE_KEY,
  ORIGIN,
} from "./helpers";
import { createProject, createService, type ProjectDetailBody } from "./pipeline-helpers";

const decoder = new TextDecoder();

/** How the fake agent answers jobs. Mutable while connected. */
export interface DataAgentBehaviour {
  /** `ok` uploads and reports success; `fail` reports an error; `silent` never answers. */
  backup?: "ok" | "fail" | "silent";
  /** Part sizes to upload; the default is one full part and a short last one. */
  partSizes?: (partSize: number) => number[];
  /** `ok` downloads, checks and reports success; `fail` reports an error. */
  restore?: "ok" | "fail" | "silent";
  /** `healthy` reports each new workload healthy and each listed volume ready. */
  workloads?: "healthy" | "silent";
  /**
   * How `db_query` is answered: `ok` with an empty result, `fail` with
   * `queryError`, or never; a function decides per query.
   */
  query?: QueryAnswer | ((q: DbQuery, credential: SealedDbCredential) => QueryAnswer);
  /** The engine error a failed query reports. */
  queryError?: string;
}

/** How the fake agent answers one `db_query`. */
export type QueryAnswer = "ok" | "fail" | "silent";

/** A protocol 5 agent for backup tests. */
export interface FakeDataAgent {
  ws: WebSocket;
  behaviour: DataAgentBehaviour;
  /** Every verified control payload, in arrival order. */
  received: ControlMessage[];
  /** Envelope or box failures; stays empty when everything verifies and opens. */
  rejected: string[];
  /** Opened `parts_sealed` URLs per backup, by part number. */
  partUrls: Map<string, Map<number, string>>;
  /** Opened `secrets_sealed` per restore (or migration, for a copy-in). */
  restoreSecrets: Map<string, { download_url: string; age_identity: string }>;
  /** Every `db_query` with its opened credential, in arrival order. */
  queries: { query: DbQuery; credential: SealedDbCredential }[];
  /** Raw sealed boxes as received, for AAD checks. */
  boxes: { frame: string; id: string; box: SealedBox }[];
  send(frame: unknown): void;
  /** Resolves with the first control payload matching `predicate`. */
  waitFor<T extends ControlMessage>(
    predicate: (m: ControlMessage) => m is T,
    timeoutMs?: number,
  ): Promise<T>;
}

async function open(
  box: SealedBox,
  purpose: "backup-parts" | "restore" | "db-credential",
  aad: string,
) {
  return JSON.parse(decoder.decode(await openBox(NODE_ENCRYPTION_PRIVATE_KEY, box, purpose, aad)));
}

/**
 * Connects a fake protocol 5 agent.
 *
 * @param joined - The node's join response.
 * @param fake - The fake S3 the agent uploads to and downloads from.
 * @param behaviour - How it answers.
 */
export async function connectDataAgent(
  joined: JoinResponse,
  fake: FakeS3,
  behaviour: DataAgentBehaviour = { backup: "ok", restore: "ok" },
  helloOverrides: Record<string, unknown> = {},
): Promise<FakeDataAgent> {
  const res = await SELF.fetch(`${ORIGIN}/v1/nodes/${joined.node_id}/connect`, {
    headers: { upgrade: "websocket", authorization: `Bearer ${joined.credential}` },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error(`connect failed: ${res.status}`);
  ws.accept();
  const listeners = new Set<() => void>();
  const send = (frame: unknown) => ws.send(JSON.stringify(frame));
  const agent: FakeDataAgent = {
    ws,
    behaviour,
    received: [],
    rejected: [],
    partUrls: new Map(),
    restoreSecrets: new Map(),
    queries: [],
    boxes: [],
    send,
    waitFor<T extends ControlMessage>(
      predicate: (m: ControlMessage) => m is T,
      timeoutMs = 10_000,
    ) {
      return new Promise<T>((resolve, reject) => {
        const check = () => {
          const found = agent.received.find(predicate);
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

  const onBackupJob = async (job: BackupJob | VolumeCopyOut) => {
    if (agent.behaviour.backup === "silent") return;
    if (agent.behaviour.backup === "fail") {
      send({
        type: "backup_result",
        backup_id: job.backup_id,
        ok: false,
        // Go's url.Error quotes the whole presigned URL; the control plane must scrub it.
        error: `Put "${agent.partUrls.get(job.backup_id)?.get(1) ?? "https://s3.fake.test/x?X-Amz-Signature=abc"}": connection reset by peer`,
        duration_ms: 3,
      });
      return;
    }
    const sizes = (agent.behaviour.partSizes ?? ((p) => [p, 1234]))(job.part_size_bytes);
    const urls = agent.partUrls.get(job.backup_id)!;
    const chunks: Uint8Array[] = [];
    const parts = [];
    for (const [i, size] of sizes.entries()) {
      const bytes = new Uint8Array(size).fill((i * 37 + 11) & 0xff);
      const put = await fake.put(urls.get(i + 1)!, bytes);
      if (!put.ok) {
        agent.rejected.push(`upload:${i + 1}:${put.status}`);
        return;
      }
      chunks.push(bytes);
      parts.push({ part_number: i + 1, etag: put.headers.get("etag")!, size });
    }
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let at = 0;
    for (const c of chunks) {
      all.set(c, at);
      at += c.byteLength;
    }
    send({
      type: "backup_progress",
      backup_id: job.backup_id,
      parts,
      bytes_raw: all.byteLength * 3,
    });
    send({
      type: "backup_result",
      backup_id: job.backup_id,
      ok: true,
      part_count: parts.length,
      bytes_raw: all.byteLength * 3,
      bytes_stored: all.byteLength,
      sha256: await sha256Hex(all),
      duration_ms: 42,
    });
  };

  const onRestoreJob = async (job: RestoreJob | VolumeCopyIn) => {
    const restoreId = job.type === "restore_job" ? job.restore_id : job.migration_id;
    if (agent.behaviour.restore === "silent") return;
    if (agent.behaviour.restore === "fail") {
      send({
        type: "restore_result",
        restore_id: restoreId,
        ok: false,
        error: "pg_restore: error: could not connect",
        duration_ms: 2,
      });
      return;
    }
    const secrets = agent.restoreSecrets.get(restoreId)!;
    const got = await fake.fetch(new Request(secrets.download_url));
    const body = new Uint8Array(await got.arrayBuffer());
    const ok =
      got.ok && (await sha256Hex(body)) === job.sha256 && body.byteLength === job.size_bytes;
    send({
      type: "restore_result",
      restore_id: restoreId,
      ok,
      ...(ok ? { bytes: body.byteLength } : { error: `download check failed: ${got.status}` }),
      duration_ms: 5,
    });
  };

  const onQuery = (q: DbQuery, credential: SealedDbCredential) => {
    const answer = agent.behaviour.query;
    const how = typeof answer === "function" ? answer(q, credential) : (answer ?? "silent");
    if (how === "silent") return;
    send(
      how === "ok"
        ? {
            type: "db_query_result",
            request_id: q.request_id,
            ok: true,
            columns: [],
            rows: [],
            row_count: 0,
            truncated: false,
            duration_ms: 2,
          }
        : {
            type: "db_query_result",
            request_id: q.request_id,
            ok: false,
            error: agent.behaviour.queryError ?? "query failed",
            duration_ms: 2,
          },
    );
  };

  const reported = new Set<string>();
  const onDesired = (m: DesiredState) => {
    if (agent.behaviour.workloads !== "healthy") return;
    for (const w of m.workloads) {
      if (reported.has(w.id)) continue;
      reported.add(w.id);
      send({
        type: "workload_status",
        workload_id: w.id,
        deployment_id: w.deployment_id,
        state: "healthy",
        container_id: "0123456789ab",
        restarts: 0,
        ts: Date.now(),
      });
    }
    if (m.volumes?.length) {
      send({
        type: "volume_status",
        volumes: m.volumes.map((v) => ({
          volume_id: v.id,
          state: "ready",
          size_bytes: v.size_mb * 2 ** 20,
          used_bytes: 4096,
          quota: "loop",
        })),
      });
    }
  };

  ws.addEventListener("message", (e) => {
    void (async () => {
      const verified = await verifyEnvelope(
        JSON.parse(e.data as string),
        joined.control_public_key,
        joined.node_id,
      );
      if (!verified.ok) {
        agent.rejected.push(verified.reason);
        return;
      }
      const m = verified.message;
      try {
        if (m.type === "backup_job" || m.type === "backup_parts" || m.type === "volume_copy_out") {
          agent.boxes.push({ frame: m.type, id: m.backup_id, box: m.parts_sealed });
          const { parts } = SealedBackupPartsSchema.parse(
            await open(m.parts_sealed, "backup-parts", backupPartsAad(joined.node_id, m.backup_id)),
          );
          const urls = agent.partUrls.get(m.backup_id) ?? new Map<number, string>();
          for (const p of parts) urls.set(p.part_number, p.url);
          agent.partUrls.set(m.backup_id, urls);
        }
        if (m.type === "restore_job" || m.type === "volume_copy_in") {
          const id = m.type === "restore_job" ? m.restore_id : m.migration_id;
          agent.boxes.push({ frame: m.type, id, box: m.secrets_sealed });
          agent.restoreSecrets.set(
            id,
            SealedRestoreSecretsSchema.parse(
              await open(m.secrets_sealed, "restore", restoreSecretsAad(joined.node_id, id)),
            ),
          );
        }
        if (m.type === "db_query") {
          agent.boxes.push({ frame: m.type, id: m.request_id, box: m.credential_sealed });
          agent.queries.push({
            query: m,
            credential: SealedDbCredentialSchema.parse(
              await open(
                m.credential_sealed,
                "db-credential",
                dbCredentialAad(joined.node_id, m.request_id),
              ),
            ),
          });
        }
      } catch {
        agent.rejected.push(`box:${m.type}`);
        return;
      }
      agent.received.push(m);
      for (const l of [...listeners]) l();
      if (m.type === "desired_state") onDesired(m);
      if (m.type === "backup_job" || m.type === "volume_copy_out") await onBackupJob(m);
      if (m.type === "restore_job" || m.type === "volume_copy_in") await onRestoreJob(m);
      if (m.type === "db_query") onQuery(m, agent.queries.at(-1)!.credential);
    })();
  });

  send(
    hello(joined.node_id, {
      protocol_version: BACKUPS_PROTOCOL_VERSION,
      statuses: [],
      ...helloOverrides,
    }),
  );
  await agent.waitFor((m): m is ControlMessage => m.type === "desired_state");
  return agent;
}

/** An installed control plane with a volume service on a connected protocol 5 node. */
export interface BackupStage {
  installed: Installed;
  owner: Client;
  workspaceId: string;
  project: ProjectDetailBody;
  envId: string;
  serviceId: string;
  serviceSlug: string;
  volumeId: string;
  joined: JoinResponse;
  fake: FakeS3;
  agent: FakeDataAgent | null;
}

/** The fake S3 configured as the instance's backup storage. */
export const STORAGE_BODY = {
  endpoint: FAKE_S3.endpoint,
  bucket: FAKE_S3.bucket,
  region: FAKE_S3.region,
  access_key_id: FAKE_S3.accessKeyId,
  secret_access_key: FAKE_S3.secretAccessKey,
};

/**
 * Builds a {@link BackupStage}.
 *
 * @param options - `storage: false` leaves backup storage unset; `agent:
 *   false` leaves the node disconnected; `behaviour` for the agent.
 */
export async function backupStage(
  options: { storage?: boolean; agent?: boolean; behaviour?: DataAgentBehaviour } = {},
): Promise<BackupStage> {
  const fake = new FakeS3();
  setS3Transport(fake.fetch);
  const installed = await install();
  const { owner, workspaceId } = installed;
  const joined = await joinNode(owner, workspaceId);
  const project = await createProject(owner, workspaceId);
  const envId = project.environments.find((e) => e.kind === "production")!.id;
  const created = await createService(owner, project.id);
  const volumeId = newId("volume");
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO volumes (id, project_id, environment_id, service_id, mount_path, size_mb, node_id, status, used_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, '/data', 1024, ?, 'ready', 0, ?, ?)`,
  )
    .bind(volumeId, project.id, envId, created.service.id, joined.node_id, now, now)
    .run();
  if (options.storage !== false) {
    const res = await owner.json("/v1/instance/backup-storage", {
      method: "PUT",
      json: STORAGE_BODY,
    });
    if (res.status !== 200) throw new Error(`storage setup failed: ${JSON.stringify(res.body)}`);
  }
  const agent =
    options.agent === false
      ? null
      : await connectDataAgent(joined, fake, options.behaviour ?? { backup: "ok", restore: "ok" });
  return {
    installed,
    owner,
    workspaceId,
    project,
    envId,
    serviceId: created.service.id,
    serviceSlug: created.service.slug,
    volumeId,
    joined,
    fake,
    agent,
  };
}

/** A backup as the API returns it, as far as tests read it. */
export interface BackupBody {
  id: string;
  status: string;
  trigger: string;
  method: string;
  error: string | null;
  part_count: number | null;
  bytes_stored: number | null;
  bytes_raw: number | null;
  sha256: string | null;
  pinned: boolean;
  node_id: string | null;
}

/**
 * Polls a backup until it reaches one of `statuses`.
 *
 * @param c - A client allowed to read it.
 * @param backupId - The backup.
 * @param statuses - Statuses that end the wait.
 */
export async function waitForBackup(
  c: Client,
  backupId: string,
  statuses: string[] = ["succeeded", "failed"],
  timeoutMs = 20_000,
): Promise<BackupBody> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await c.json<BackupBody>(`/v1/backups/${backupId}`);
    if (statuses.includes(res.body.status)) return res.body;
    if (Date.now() > deadline) {
      throw new Error(`backup ${backupId} stuck in ${res.body.status}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Audit rows of an action, newest last. */
export async function auditRows(action: string) {
  const { results } = await env.DB.prepare(
    "SELECT actor_type, actor_id, target_id, metadata FROM audit_logs WHERE action = ? ORDER BY seq",
  )
    .bind(action)
    .all<{
      actor_type: string;
      actor_id: string | null;
      target_id: string;
      metadata: string | null;
    }>();
  return results.map((r) => ({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : null }));
}

/** Every audit row's JSON, for "no secret leaked" checks. */
export async function allAuditText(): Promise<string> {
  const { results } = await env.DB.prepare("SELECT action, metadata FROM audit_logs").all();
  return JSON.stringify(results);
}
