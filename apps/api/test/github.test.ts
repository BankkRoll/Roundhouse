/**
 * The GitHub App: PEM conversion and RS256 JWTs, the manifest and install
 * callbacks, repository listing, and the webhook (signature, replay
 * protection, installations, push → deploy with commit statuses). GitHub's
 * API is replaced by a fetch stub; webhook bodies are recorded payloads.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { createDb } from "@openrail/db";
import { CREDENTIAL_FRAME_TTL_MS, fromBase64, toBase64 } from "@openrail/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appJwt,
  GITHUB_APP_PERMISSIONS,
  importRsaPrivateKey,
  pemToPkcs8,
  storeGithubApp,
} from "../src/lib/github";
import installationCreated from "./fixtures/github/installation-created.json";
import installationDeleted from "./fixtures/github/installation-deleted.json";
import ping from "./fixtures/github/ping.json";
import push from "./fixtures/github/push.json";
import { addMember, type Client, call, eventually, install, joinNode } from "./helpers";
import {
  connectWorkloadAgent,
  createProject,
  createService,
  waitForStatus,
} from "./pipeline-helpers";

const WEBHOOK_SECRET = "whsec-test-0123456789";
const APP_ID = 1012345;
const INSTALLATION_ID = installationCreated.installation.id;

// -----------------------------------------------------------------------------
// Keys
// -----------------------------------------------------------------------------

function pem(label: string, der: Uint8Array): string {
  const b64 = toBase64(der).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/** Reads one DER TLV header: returns where the content starts and its length. */
function tlv(der: Uint8Array, at: number): { start: number; length: number } {
  const first = der[at + 1]!;
  if (first < 0x80) return { start: at + 2, length: first };
  const n = first & 0x7f;
  let length = 0;
  for (let i = 0; i < n; i++) length = (length << 8) | der[at + 2 + i]!;
  return { start: at + 2 + n, length };
}

/** Unwraps PKCS#8 `PrivateKeyInfo` to the PKCS#1 `RSAPrivateKey` GitHub hands out. */
function pkcs8ToPkcs1(pkcs8: Uint8Array): Uint8Array {
  const outer = tlv(pkcs8, 0);
  const version = tlv(pkcs8, outer.start);
  const algorithm = tlv(pkcs8, version.start + version.length);
  const key = tlv(pkcs8, algorithm.start + algorithm.length);
  return pkcs8.slice(key.start, key.start + key.length);
}

let keys: { pkcs1Pem: string; pkcs8: Uint8Array; publicKey: CryptoKey } | undefined;

async function testKeys() {
  if (keys) return keys;
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  keys = {
    pkcs1Pem: pem("RSA PRIVATE KEY", pkcs8ToPkcs1(pkcs8)),
    pkcs8,
    publicKey: pair.publicKey,
  };
  return keys;
}

async function seedApp() {
  const k = await testKeys();
  await storeGithubApp(createDb(env.DB), env, {
    id: APP_ID,
    slug: "openrail-cp-a1b2c3",
    name: "OpenRail cp a1b2c3",
    html_url: "https://github.com/apps/openrail-cp-a1b2c3",
    owner: { login: "acme" },
    client_id: "Iv23liAbCdEfGh123456",
    client_secret: "client-secret",
    webhook_secret: WEBHOOK_SECRET,
    pem: k.pkcs1Pem,
  });
}

// -----------------------------------------------------------------------------
// GitHub API stub
// -----------------------------------------------------------------------------

interface Recorded {
  method: string;
  url: string;
  body: unknown;
  authorization: string | null;
}

const realFetch = globalThis.fetch;
let recorded: Recorded[] = [];
let routes: [RegExp, (req: Request, body: unknown) => Response][] = [];

function stubGithub(extra: [RegExp, (req: Request, body: unknown) => Response][] = []) {
  routes = [
    [
      /^POST https:\/\/api\.github\.com\/app\/installations\/\d+\/access_tokens$/,
      () =>
        Response.json(
          { token: "ghs_installationtoken123", expires_at: "2026-10-22T14:00:00Z" },
          { status: 201 },
        ),
    ],
    [
      /^POST https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/statuses\/[a-f0-9]+$/,
      () => Response.json({}, { status: 201 }),
    ],
    ...extra,
  ];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const key = `${req.method} ${req.url}`;
    const route = routes.find(([re]) => re.test(key));
    if (!route) return realFetch(input, init);
    const text = await req.clone().text();
    const body = text ? JSON.parse(text) : null;
    recorded.push({
      method: req.method,
      url: req.url,
      body,
      authorization: req.headers.get("authorization"),
    });
    return route[1](req, body);
  }) as typeof fetch;
}

let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | undefined;
beforeEach(async () => {
  recorded = [];
  introspector = await introspectWorkflow(env.DEPLOY_WORKFLOW);
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  routes = [];
  await introspector?.dispose();
});

// -----------------------------------------------------------------------------
// Webhook helpers
// -----------------------------------------------------------------------------

async function sign(body: string, secret = WEBHOOK_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function webhook(
  event: string,
  payload: unknown,
  opts: { delivery?: string; signature?: string | null } = {},
) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": opts.delivery ?? crypto.randomUUID(),
    "user-agent": "GitHub-Hookshot/abc123",
  };
  const signature = opts.signature === undefined ? await sign(body) : opts.signature;
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  // GitHub sends no Origin; the same-origin guard must let it through.
  return call("/v1/webhooks/github", { method: "POST", headers: { ...headers, origin: "" }, body });
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("App keys and JWTs", () => {
  it("wraps a PKCS#1 key into the exact PKCS#8 WebCrypto exports", async () => {
    const k = await testKeys();
    expect(k.pkcs1Pem).toContain("BEGIN RSA PRIVATE KEY");
    expect(toBase64(pemToPkcs8(k.pkcs1Pem))).toBe(toBase64(k.pkcs8));
    expect(toBase64(pemToPkcs8(pem("PRIVATE KEY", k.pkcs8)))).toBe(toBase64(k.pkcs8));
    expect(() =>
      pemToPkcs8("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"),
    ).toThrow();
  });

  it("signs an RS256 App JWT that verifies with the public key", async () => {
    const k = await testKeys();
    const now = Date.UTC(2026, 9, 22, 12, 0, 0);
    const jwt = await appJwt(APP_ID, await importRsaPrivateKey(k.pkcs1Pem), now);
    const [h, p, s] = jwt.split(".");
    const decode = (part: string) =>
      JSON.parse(
        new TextDecoder().decode(
          fromBase64(
            part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4),
          ),
        ),
      );
    expect(decode(h!)).toEqual({ alg: "RS256", typ: "JWT" });
    const iat = Math.floor(now / 1000) - 60;
    expect(decode(p!)).toEqual({ iat, exp: iat + 600, iss: String(APP_ID) });
    const sig = fromBase64(
      s!.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s!.length % 4)) % 4),
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      k.publicKey,
      sig,
      new TextEncoder().encode(`${h}.${p}`),
    );
    expect(ok).toBe(true);
  });
});

describe("webhook verification", () => {
  it("accepts a correctly signed delivery without an Origin header", async () => {
    await install();
    await seedApp();
    expect((await webhook("ping", ping)).status).toBe(202);
  });

  it("rejects a bad, missing or malformed signature", async () => {
    await install();
    await seedApp();
    const wrong = await webhook("ping", ping, { signature: await sign("{}", WEBHOOK_SECRET) });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe(
      "invalid_signature",
    );
    const otherSecret = await webhook("ping", ping, {
      signature: await sign(JSON.stringify(ping), "not-the-secret"),
    });
    expect(otherSecret.status).toBe(401);
    expect((await webhook("ping", ping, { signature: null })).status).toBe(400);
    expect((await webhook("ping", ping, { signature: "sha1=abc" })).status).toBe(400);
  });

  it("rejects everything while no App is configured", async () => {
    await install();
    expect((await webhook("ping", ping)).status).toBe(401);
  });

  it("processes a replayed delivery once", async () => {
    await install();
    await seedApp();
    const delivery = "72d3162e-cc78-11e3-81ab-4c9367dc0958";
    expect((await webhook("installation", installationCreated, { delivery })).status).toBe(202);
    await env.DB.prepare("DELETE FROM github_installations").run();
    expect((await webhook("installation", installationCreated, { delivery })).status).toBe(202);
    const n = await env.DB.prepare("SELECT count(*) AS n FROM github_installations").first<{
      n: number;
    }>();
    expect(n?.n).toBe(0);
    const audits = await env.DB.prepare(
      "SELECT count(*) AS n FROM audit_logs WHERE action = 'github.installation_added'",
    ).first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });

  it("puts the webhook in its own rate-limit bucket", async () => {
    const { rateLimitBucket } = await import("../src/lib/guards");
    expect(rateLimitBucket("POST", "/v1/webhooks/github")).toBe("webhook");
    expect(rateLimitBucket("POST", "/v1/webhooks/github/")).toBe("webhook");
  });
});

describe("installation events", () => {
  it("records new installations unclaimed and forgets deleted ones", async () => {
    await install();
    await seedApp();
    await webhook("installation", installationCreated);
    const row = await env.DB.prepare(
      "SELECT installation_id, account_login, account_type, workspace_id FROM github_installations",
    ).first();
    expect(row).toEqual({
      installation_id: INSTALLATION_ID,
      account_login: "acme",
      account_type: "Organization",
      workspace_id: null,
    });
    await webhook("installation", installationDeleted);
    expect(await env.DB.prepare("SELECT * FROM github_installations").first()).toBeNull();
  });
});

async function claimInstallation(workspaceId: string): Promise<string> {
  const id = "ghi_01TESTINSTALLATION";
  await env.DB.prepare(
    "INSERT INTO github_installations (id, installation_id, account_login, account_type, workspace_id, created_at, updated_at) VALUES (?, ?, 'acme', 'Organization', ?, 0, 0)",
  )
    .bind(id, INSTALLATION_ID, workspaceId)
    .run();
  return id;
}

describe("push → deploy", () => {
  it("deploys production services tracking the branch, with commit metadata and statuses", async () => {
    stubGithub();
    const { owner, workspaceId } = await install();
    await seedApp();
    const ghi = await claimInstallation(workspaceId);
    const agent = await connectWorkloadAgent(await joinNode(owner, workspaceId));
    const project = await createProject(owner, workspaceId);
    const source = {
      type: "git",
      repo_url: "https://github.com/acme/api",
      branch: "main",
      root_dir: ".",
      github_installation_id: ghi,
    };
    const tracking = await createService(owner, project.id, { name: "api", source });
    await createService(owner, project.id, {
      name: "other-branch",
      source: { ...source, branch: "develop" },
    });

    expect((await webhook("push", push)).status).toBe(202);
    const rows = await env.DB.prepare("SELECT id, service_id, trigger FROM deployments").all<{
      id: string;
      service_id: string;
      trigger: string;
    }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ service_id: tracking.service.id, trigger: "push" });
    const id = rows.results[0]!.id;

    const active = await waitForStatus(owner, id, ["active", "failed"]);
    expect(active.failure_reason).toBeNull();
    expect(active.build).toMatchObject({
      commit_sha: push.after,
      commit_message: push.head_commit.message,
    });
    const job = agent.received.find((m) => m.type === "build_job");
    expect(job).toMatchObject({
      source: { token: "ghs_installationtoken123", commit_sha: push.after },
    });
    expect(job!.exp - job!.iat).toBeLessThanOrEqual(CREDENTIAL_FRAME_TTL_MS);

    const statuses = await eventually(async () => {
      const s = recorded.filter((r) => r.url.includes("/statuses/"));
      return s.length === 2 ? s : undefined;
    });
    expect(statuses.map((s) => (s.body as { state: string }).state)).toEqual([
      "pending",
      "success",
    ]);
    expect(statuses[0]!.url).toBe(`https://api.github.com/repos/acme/api/statuses/${push.after}`);
    expect(statuses[0]!.authorization).toBe("Bearer ghs_installationtoken123");
    expect((statuses[1]!.body as { context: string }).context).toBe("openrail/api/production");
    const tokenRequests = recorded.filter((r) => r.url.endsWith("/access_tokens"));
    expect(tokenRequests[0]!.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(tokenRequests.map((r) => r.body)).toContainEqual({
      repositories: ["api"],
      permissions: { contents: "read" },
    });

    const audit = await env.DB.prepare(
      "SELECT actor_type, metadata FROM audit_logs WHERE action = 'deployment.created'",
    ).first<{ actor_type: string; metadata: string }>();
    expect(audit?.actor_type).toBe("system");
    expect(JSON.parse(audit!.metadata)).toMatchObject({ trigger: "push", commit_sha: push.after });
  });

  it("ignores pushes for other workspaces, deleted branches and tags", async () => {
    stubGithub();
    const { owner, workspaceId } = await install();
    await seedApp();
    await claimInstallation(workspaceId);
    const ws2 = await owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Other" },
    });
    const project = await createProject(owner, ws2.body.id);
    // Public-source service in a workspace that didn't claim the installation.
    await createService(owner, project.id, {
      name: "api",
      source: {
        type: "git",
        repo_url: "https://github.com/acme/api",
        branch: "main",
        root_dir: ".",
      },
    });
    await webhook("push", push);
    await webhook("push", { ...push, deleted: true, after: "0".repeat(40) });
    await webhook("push", { ...push, ref: "refs/tags/v1.0.0" });
    const n = await env.DB.prepare("SELECT count(*) AS n FROM deployments").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("deploys public-source services in the workspace that claimed the installation", async () => {
    stubGithub();
    const { owner, workspaceId } = await install();
    await seedApp();
    await claimInstallation(workspaceId);
    const project = await createProject(owner, workspaceId);
    await createService(owner, project.id, {
      name: "api",
      source: {
        type: "git",
        repo_url: "https://github.com/ACME/api.git",
        branch: "main",
        root_dir: ".",
      },
    });
    await webhook("push", push);
    const row = await env.DB.prepare("SELECT trigger FROM deployments").first<{
      trigger: string;
    }>();
    expect(row?.trigger).toBe("push");
  });
});

describe("App setup", () => {
  async function startManifest(owner: Client, workspaceId: string, organization?: string) {
    return owner.json<{ manifest: Record<string, unknown>; state: string; post_url: string }>(
      "/v1/github/manifest",
      {
        method: "POST",
        json: { workspace_id: workspaceId, ...(organization ? { organization } : {}) },
      },
    );
  }

  it("returns a minimal-permission manifest to owners only", async () => {
    const { owner, workspaceId } = await install();
    const res = await startManifest(owner, workspaceId);
    expect(res.status).toBe(200);
    expect(res.body.manifest).toMatchObject({
      url: "https://cp.test",
      hook_attributes: { url: "https://cp.test/v1/webhooks/github", active: true },
      redirect_url: "https://cp.test/v1/github/callback",
      setup_url: "https://cp.test/v1/github/callback",
      public: false,
      default_permissions: GITHUB_APP_PERMISSIONS,
      default_events: ["push"],
    });
    expect(res.body.post_url).toBe(
      `https://github.com/settings/apps/new?state=${encodeURIComponent(res.body.state)}`,
    );
    const org = await startManifest(owner, workspaceId, "acme");
    expect(org.body.post_url).toMatch(
      /^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=/,
    );
    const stored = await env.DB.prepare(
      "SELECT value FROM instance_settings WHERE key = 'github_manifest_state'",
    ).first<{ value: string }>();
    expect(stored!.value).not.toContain(org.body.state);

    const admin = await addMember(owner, workspaceId, "a@example.com", "admin");
    expect((await startManifest(admin, workspaceId)).status).toBe(403);
    await seedApp();
    expect((await startManifest(owner, workspaceId)).status).toBe(409);
  });

  it("exchanges the code once, stores the App sealed and sends the browser to install it", async () => {
    const k = await testKeys();
    stubGithub([
      [
        /^POST https:\/\/api\.github\.com\/app-manifests\/code123\/conversions$/,
        () =>
          Response.json(
            {
              id: APP_ID,
              slug: "openrail-cp-a1b2c3",
              name: "OpenRail cp a1b2c3",
              html_url: "https://github.com/apps/openrail-cp-a1b2c3",
              owner: { login: "mara" },
              client_id: "Iv23li",
              client_secret: "cs-secret",
              webhook_secret: WEBHOOK_SECRET,
              pem: k.pkcs1Pem,
            },
            { status: 201 },
          ),
      ],
    ]);
    const { owner, workspaceId } = await install();
    const { body } = await startManifest(owner, workspaceId);
    const wrong = await owner.request(`/v1/github/callback?code=code123&state=nope`);
    expect(wrong.status).toBe(400);

    const res = await owner.request(
      `/v1/github/callback?code=code123&state=${encodeURIComponent(body.state)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(
      /^https:\/\/github\.com\/apps\/openrail-cp-a1b2c3\/installations\/new\?state=/,
    );
    const stored = await env.DB.prepare(
      "SELECT value FROM instance_settings WHERE key = 'github_app'",
    ).first<{ value: string }>();
    expect(stored!.value).not.toContain("PRIVATE KEY");
    expect(stored!.value).not.toContain(WEBHOOK_SECRET);
    expect(stored!.value).not.toContain("cs-secret");

    const replay = await owner.request(
      `/v1/github/callback?code=code123&state=${encodeURIComponent(body.state)}`,
      { redirect: "manual" },
    );
    expect(replay.status).toBe(400);
    const status = await owner.json<{
      configured: boolean;
      app: { slug: string; install_url: string };
    }>(`/v1/github/status?workspace_id=${workspaceId}`);
    expect(status.body.configured).toBe(true);
    expect(status.body.app.slug).toBe("openrail-cp-a1b2c3");
  });

  it("binds an installation to the workspace whose install link was used", async () => {
    stubGithub([
      [
        new RegExp(`^GET https://api\\.github\\.com/app/installations/${INSTALLATION_ID}$`),
        () =>
          Response.json({ id: INSTALLATION_ID, account: { login: "acme", type: "Organization" } }),
      ],
    ]);
    const { owner, workspaceId } = await install();
    await seedApp();
    const status = await owner.json<{ app: { install_url: string }; installations: unknown[] }>(
      `/v1/github/status?workspace_id=${workspaceId}`,
    );
    expect(status.body.installations).toEqual([]);
    const state = new URL(status.body.app.install_url).searchParams.get("state")!;

    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    const stolen = await member.request(
      `/v1/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(stolen.status).toBe(403);

    const res = await owner.request(
      `/v1/github/callback?installation_id=${INSTALLATION_ID}&setup_action=install&state=${encodeURIComponent(state)}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://cp.test/settings/github?status=installed");
    const after = await owner.json<{
      installations: { installation_id: number; workspace_id: string }[];
    }>(`/v1/github/status?workspace_id=${workspaceId}`);
    expect(after.body.installations).toEqual([
      expect.objectContaining({ installation_id: INSTALLATION_ID, workspace_id: workspaceId }),
    ]);
    expect(recorded[0]!.authorization).toMatch(/^Bearer ey/);

    const forged = await owner.request(
      `/v1/github/callback?installation_id=${INSTALLATION_ID}&state=forged.state`,
      { redirect: "manual" },
    );
    expect(forged.status).toBe(400);
  });

  it("lists repositories through the workspace's installations", async () => {
    stubGithub([
      [
        /^GET https:\/\/api\.github\.com\/installation\/repositories\?per_page=100&page=1$/,
        () =>
          Response.json({
            total_count: 1,
            repositories: [
              {
                id: 812345678,
                full_name: "acme/api",
                private: true,
                default_branch: "main",
                clone_url: "https://github.com/acme/api.git",
              },
            ],
          }),
      ],
    ]);
    const { owner, workspaceId } = await install();
    await seedApp();
    const ghi = await claimInstallation(workspaceId);
    const res = await owner.json<{ repositories: unknown[] }>(
      `/v1/github/repositories?workspace_id=${workspaceId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.repositories).toEqual([
      {
        id: 812345678,
        full_name: "acme/api",
        private: true,
        default_branch: "main",
        clone_url: "https://github.com/acme/api.git",
        installation_id: ghi,
      },
    ]);
    const viewer = await addMember(owner, workspaceId, "v@example.com", "viewer");
    expect((await viewer.json(`/v1/github/repositories?workspace_id=${workspaceId}`)).status).toBe(
      403,
    );
    expect(
      (
        await owner.json(
          `/v1/github/repositories?workspace_id=${workspaceId}&installation_id=ghi_nope`,
        )
      ).status,
    ).toBe(404);
    const viewerStatus = await viewer.json(`/v1/github/status?workspace_id=${workspaceId}`);
    expect(viewerStatus.status).toBe(200);
  });
});
