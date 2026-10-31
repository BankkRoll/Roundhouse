/**
 * MongoDB 8.0+ and the rseq kernel incompatibility (SERVER-121912): the
 * deploy pipeline never places it on a node whose reported kernel is in
 * 6.19 to 7.0.13, falls back to another node, and otherwise fails with a
 * reason the operator can act on.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { setS3Transport } from "../src/lib/s3";
import { connectDataAgent } from "./backups-helpers";
import { databaseStage, FULL_CAPABILITIES, HEALTHY } from "./data-stage";
import { FakeS3 } from "./fake-s3";
import { install, joinNode } from "./helpers";
import { createProject, waitForStatus } from "./pipeline-helpers";

const AFFECTED = "7.0.0-14-generic";
const FIXED = "7.0.14-1-generic";

async function addMongo(kernels: string[]) {
  const fake = new FakeS3();
  setS3Transport(fake.fetch);
  const { owner, workspaceId } = await install();
  const nodeIds: string[] = [];
  for (const [i, kernel] of kernels.entries()) {
    const name = `node-${i + 1}`;
    const joined = await joinNode(owner, workspaceId, {
      name,
      hostname: name,
      public_ip: `203.0.113.${10 + i}`,
    });
    await connectDataAgent(
      joined,
      fake,
      { ...HEALTHY },
      { volume_quota: "loop", capabilities: FULL_CAPABILITIES, kernel },
    );
    nodeIds.push(joined.node_id);
  }
  const project = await createProject(owner, workspaceId);
  const envId = project.environments.find((e) => e.kind === "production")!.id;
  const created = await owner.json<{
    volumes: { id: string; environment_id: string }[];
    deployment_ids: string[];
  }>(`/v1/projects/${project.id}/databases`, {
    method: "POST",
    json: { engine: "mongodb", version: "8.0", environment_id: envId, deploy: true },
  });
  expect(created.status).toBe(201);
  return {
    owner,
    nodeIds,
    deploymentId: created.body.deployment_ids[0]!,
    volumeId: created.body.volumes.find((v) => v.environment_id === envId)!.id,
  };
}

async function volumeNode(volumeId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT node_id FROM volumes WHERE id = ?")
    .bind(volumeId)
    .first<{ node_id: string | null }>();
  return row?.node_id ?? null;
}

describe("MongoDB 8.0+ on an affected kernel", () => {
  it("refuses the only node and says how to fix it", async () => {
    const s = await addMongo([AFFECTED]);
    const failed = await waitForStatus(s.owner, s.deploymentId, ["failed", "active"]);
    expect(failed.status).toBe("failed");
    expect(failed.failure_reason).toBe(
      "Could not place replica 0: MongoDB 8.0 and later cannot start on Linux kernel " +
        `${AFFECTED} (6.19 to 7.0.13). Upgrade the server's kernel to 7.0.14 or later, ` +
        "or place the service on another server.",
    );
    const event = failed.events!.find((e) => e.type === "schedule_failed");
    expect(event?.data).toMatchObject({
      reason: "kernel_incompatible",
      rejected: [{ nodeId: s.nodeIds[0], reason: "kernel_incompatible" }],
    });
    // Nothing was placed, so the volume isn't pinned to the refused node.
    expect(await volumeNode(s.volumeId)).toBeNull();
  }, 60_000);

  it.each([
    ["first", [AFFECTED, FIXED], 1],
    ["second", [FIXED, AFFECTED], 0],
  ])(
    "falls back to the unaffected node when the %s is affected",
    async (_, kernels, want) => {
      const s = await addMongo(kernels);
      const done = await waitForStatus(s.owner, s.deploymentId, ["failed", "active"]);
      expect(done).toMatchObject({ status: "active", failure_reason: null });
      expect(await volumeNode(s.volumeId)).toBe(s.nodeIds[want]);
    },
    60_000,
  );

  it("leaves other engines on the same kernel alone", async () => {
    const s = await databaseStage({ engine: "postgres", hello: () => ({ kernel: AFFECTED }) });
    expect(s.home).toBeDefined();
  }, 60_000);
});
