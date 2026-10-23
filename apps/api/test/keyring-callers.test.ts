/**
 * Callers hand the crypto helpers the keyring bindings, not `MASTER_KEY`
 * alone (ADR 0014 "Crypto"). With `MASTER_KEY` switched, the old key in
 * `MASTER_KEYS_PREVIOUS` and no rotation run yet, values sealed under the old
 * key still open through each path: the variables and canvas routes, the
 * deploy workflow, desired state, log redaction and consent tickets.
 *
 * Each path gets its own project: a project's DEK is cached per isolate once
 * opened, and a cached key would pass whatever keyring the caller passed.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { createDb } from "@roundhouse/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDesiredState } from "../src/lib/desired-state";
import { masterKeyId } from "../src/lib/keyring";
import { deploymentRedaction } from "../src/lib/logs";
import { signConsentTicket, verifyConsentTicket } from "../src/mcp/oauth/authorize";
import { type Client, install, signInAs } from "./helpers";
import {
  createProject,
  createService,
  deploy,
  settleDeployments,
  stage,
  waitForStatus,
} from "./pipeline-helpers";

const OLD = env.MASTER_KEY!;
const NEW = btoa("r".repeat(32));

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
beforeEach(async () => {
  introspector = await introspectWorkflow(env.DEPLOY_WORKFLOW);
});
afterEach(async () => {
  await settleDeployments();
  await introspector?.dispose();
  introspector = undefined;
  env.MASTER_KEY = OLD;
  env.MASTER_KEYS_PREVIOUS = undefined;
});

/** Switches to {@link NEW} and signs in again: the auth secret derives from `MASTER_KEY`. */
async function rotate(): Promise<Client> {
  env.MASTER_KEY = NEW;
  env.MASTER_KEYS_PREVIOUS = OLD;
  return signInAs("mara@example.com", "correct horse battery");
}

async function kekKid(projectId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT kek_kid FROM project_keys WHERE project_id = ?")
    .bind(projectId)
    .first<{ kek_kid: string | null }>();
  return row!.kek_kid;
}

describe("with MASTER_KEY switched and the old key previous", () => {
  it("opens project keys sealed under the old key in the variables and canvas routes", async () => {
    const { owner, workspaceId } = await install();
    const forVariables = await createProject(owner, workspaceId, { name: "Variables" });
    const forCanvas = await createProject(owner, workspaceId, { name: "Canvas" });
    const svc = await createService(owner, forVariables.id);
    const owner2 = await rotate();

    const envId = forVariables.environments[0]!.id;
    const path = `/v1/services/${svc.service.id}/variables?environment_id=${envId}`;
    const put = await owner2.json(path, {
      method: "PUT",
      json: { set: [{ key: "GREETING", value: "hello" }] },
    });
    expect(put.status).toBe(200);
    const listed = await owner2.json<{ variables: { key: string; value: string | null }[] }>(path);
    expect(listed.body.variables.find((v) => v.key === "GREETING")?.value).toBe("hello");

    const canvas = await owner2.request(
      `/v1/projects/${forCanvas.id}/canvas?environment_id=${forCanvas.environments[0]!.id}`,
    );
    expect(canvas.status).toBe(200);

    // Nothing was re-wrapped: the old key opened both DEKs.
    const oldKid = await masterKeyId(OLD);
    expect(await kekKid(forVariables.id)).toBe(oldKid);
    expect(await kekKid(forCanvas.id)).toBe(oldKid);
  });

  it("deploys, sends desired state and builds the redaction set", async () => {
    const s = await stage();
    const owner = await rotate();

    const d = await deploy(owner, s.serviceId, s.envId);
    await waitForStatus(owner, d.id, ["active"]);
    const workload = s.agent.desired()!.workloads.find((w) => w.deployment_id === d.id)!;
    expect(s.agent.env(workload.id)).toMatchObject({ PORT: expect.any(String) });
    expect(s.agent.rejected).toEqual([]);

    const db = createDb(env.DB);
    const body = await buildDesiredState(db, env, s.joined.node_id);
    expect(body?.workloads.map((w) => w.deployment_id)).toEqual([d.id]);
    await expect(deploymentRedaction(db, env, d.id, false)).resolves.toMatchObject({
      frozen: true,
    });
    expect(await kekKid(s.project.id)).toBe(await masterKeyId(OLD));
  });

  it("verifies a consent ticket signed under the old key", async () => {
    const holder = { userId: "usr_1", sessionId: "ses_1" };
    const params = { client_id: "https://agent.example/client.json", scope: "projects:read" };
    const { ticket } = await signConsentTicket({ MASTER_KEY: OLD }, holder, params);
    env.MASTER_KEY = NEW;
    env.MASTER_KEYS_PREVIOUS = OLD;

    expect(await verifyConsentTicket(env, ticket, holder, params)).toBe(true);
    expect(await verifyConsentTicket({ MASTER_KEY: NEW }, ticket, holder, params)).toBe(false);
  });
});
