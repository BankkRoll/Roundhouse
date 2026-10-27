/**
 * The GitHub App: PEM conversion and RS256 JWTs, the manifest and install
 * callbacks, repository listing, and the webhook (signature, replay
 * protection, installations, push → deploy with commit statuses), and the
 * checks that keep installation tokens to their workspace, their one
 * repository and github.com (source writes, minting, redirects). GitHub's
 * API is replaced by a fetch stub; webhook bodies are recorded payloads.
 */
import { env, introspectWorkflow } from "cloudflare:test";
import { createDb } from "@roundhouse/db";
import { CREDENTIAL_FRAME_TTL_MS, fromBase64, toBase64 } from "@roundhouse/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBranch } from "../src/lib/git";
import {
  appJwt,
  GITHUB_APP_PERMISSIONS,
  GithubApiError,
  githubRequest,
  InstallationAccessError,
  importRsaPrivateKey,
  mintRepoToken,
  pemToPkcs8,
  storeGithubApp,
} from "../src/lib/github";
import installationCreated from "./fixtures/github/installation-created.json";
import installationDeleted from "./fixtures/github/installation-deleted.json";
import ping from "./fixtures/github/ping.json";
import push from "./fixtures/github/push.json";
import { addMember, type Client, call, eventually, install, joinNode } from "./helpers";
import {
  COMMIT_SHA,
  connectWorkloadAgent,
  createProject,
  createService,
  deploy,
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
    slug: "roundhouse-cp-a1b2c3",
    name: "Roundhouse cp a1b2c3",
    html_url: "https://github.com/apps/roundhouse-cp-a1b2c3",
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
/** `owner/repo` names the stubbed installation can read. */
let installationRepos: string[] = ["acme/api"];

function stubGithub(extra: [RegExp, (req: Request, body: unknown) => Response][] = []) {
  routes = [
    ...extra,
    [
      /^POST https:\/\/api\.github\.com\/app\/installations\/\d+\/access_tokens$/,
      () =>
        Response.json(
          { token: "ghs_installationtoken123", expires_at: "2026-10-22T14:00:00Z" },
          { status: 201 },
        ),
    ],
    [
      /^GET https:\/\/api\.github\.com\/installation\/repositories\?per_page=100&page=1$/,
      () =>
        Response.json({
          total_count: installationRepos.length,
          repositories: installationRepos.map((full_name, i) => ({
            id: 1000 + i,
            full_name,
            private: true,
            default_branch: "main",
            clone_url: `https://github.com/${full_name}.git`,
          })),
        }),
    ],
    [
      /^POST https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/statuses\/[a-f0-9]+$/,
      () => Response.json({}, { status: 201 }),
    ],
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
  installationRepos = ["acme/api"];
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
    expect((statuses[1]!.body as { context: string }).context).toBe("roundhouse/api/production");
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
      request_oauth_on_install: true,
      public: false,
      default_permissions: GITHUB_APP_PERMISSIONS,
      default_events: ["push", "pull_request"],
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
              slug: "roundhouse-cp-a1b2c3",
              name: "Roundhouse cp a1b2c3",
              html_url: "https://github.com/apps/roundhouse-cp-a1b2c3",
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
      /^https:\/\/github\.com\/apps\/roundhouse-cp-a1b2c3\/installations\/new\?state=/,
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
    expect(status.body.app.slug).toBe("roundhouse-cp-a1b2c3");
  });
});

describe("installation claims", () => {
  const CLIENT_ID = "Iv23liAbCdEfGh123456";
  const USER_TOKEN = "ghu_usertoken0123456789";

  const GH_USER = { id: 4242, login: "mara-gh" };
  const ORG = { id: 9001, login: "acme" };

  /**
   * GitHub as seen by a user who can access `accessible` installations and
   * holds `orgRole` in the org they are on (or owns them, for `account`
   * "user").
   */
  function stubInstallFlow(
    accessible: number[] = [INSTALLATION_ID],
    opts: { orgRole?: "admin" | "member" | null; account?: "org" | "user" | "other_user" } = {},
  ) {
    const orgRole = opts.orgRole === undefined ? "admin" : opts.orgRole;
    const account =
      opts.account === "user"
        ? { id: GH_USER.id, login: GH_USER.login, type: "User" }
        : opts.account === "other_user"
          ? { id: 777, login: "someone-else", type: "User" }
          : { id: ORG.id, login: ORG.login, type: "Organization" };
    stubGithub([
      [/^GET https:\/\/api\.github\.com\/user$/, () => Response.json(GH_USER)],
      [
        /^GET https:\/\/api\.github\.com\/user\/memberships\/orgs\/acme$/,
        () =>
          orgRole
            ? Response.json({ state: "active", role: orgRole, organization: ORG })
            : Response.json({ message: "Not Found" }, { status: 404 }),
      ],
      [
        /^POST https:\/\/github\.com\/login\/oauth\/access_token$/,
        (_req, body) =>
          (body as { code?: string }).code === "good-code"
            ? Response.json({ access_token: USER_TOKEN, token_type: "bearer" })
            : // GitHub answers a bad code with 200 and an error field.
              Response.json({ error: "bad_verification_code" }),
      ],
      [
        /^GET https:\/\/api\.github\.com\/user\/installations\?per_page=100&page=1$/,
        () =>
          Response.json({
            total_count: accessible.length,
            installations: accessible.map((id) => ({ id, account: { login: "acme" } })),
          }),
      ],
      [
        new RegExp(`^DELETE https://api\\.github\\.com/applications/${CLIENT_ID}/token$`),
        () => new Response(null, { status: 204 }),
      ],
      [
        /^GET https:\/\/api\.github\.com\/app\/installations\/\d+$/,
        (req) => Response.json({ id: Number(new URL(req.url).pathname.split("/").pop()), account }),
      ],
    ]);
  }

  async function installState(owner: Client, workspaceId: string): Promise<string> {
    const res = await owner.json<{ install_url: string }>("/v1/github/claims", {
      method: "POST",
      json: { workspace_id: workspaceId },
    });
    if (res.status !== 200) throw new Error(`claim: ${res.status}`);
    expect(res.body.install_url).toMatch(
      /^https:\/\/github\.com\/apps\/roundhouse-cp-a1b2c3\/installations\/new\?state=/,
    );
    return new URL(res.body.install_url).searchParams.get("state")!;
  }

  function callback(c: Client, params: Record<string, string | number>) {
    const query = new URLSearchParams(
      Object.entries({ setup_action: "install", ...params }).map(([k, v]) => [k, String(v)]),
    );
    return c.request(`/v1/github/callback?${query}`, { redirect: "manual" });
  }

  async function rejections() {
    const rows = await env.DB.prepare(
      "SELECT workspace_id, actor_id, metadata FROM audit_logs WHERE action = 'github.installation_rejected' ORDER BY id",
    ).all<{ workspace_id: string; actor_id: string; metadata: string }>();
    return rows.results.map((r) => ({ ...r, metadata: JSON.parse(r.metadata) }));
  }

  async function installationCount() {
    const n = await env.DB.prepare("SELECT count(*) AS n FROM github_installations").first<{
      n: number;
    }>();
    return n!.n;
  }

  it("asks GitHub for user authorization during installation", async () => {
    const { owner, workspaceId } = await install();
    const res = await owner.json<{ manifest: Record<string, unknown> }>("/v1/github/manifest", {
      method: "POST",
      json: { workspace_id: workspaceId },
    });
    expect(res.body.manifest.request_oauth_on_install).toBe(true);
  });

  it("binds an installation the signed-in GitHub user can access, then revokes their token", async () => {
    stubInstallFlow();
    const { owner, workspaceId, userId } = await install();
    await seedApp();
    const state = await installState(owner, workspaceId);

    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    const stolen = await callback(member, {
      installation_id: INSTALLATION_ID,
      state,
      code: "good-code",
    });
    expect(stolen.status).toBe(403);

    const res = await callback(owner, {
      installation_id: INSTALLATION_ID,
      state,
      code: "good-code",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://cp.test/settings/github?status=installed");
    const after = await owner.json<{
      installations: { installation_id: number; workspace_id: string; verified: boolean }[];
    }>(`/v1/github/status?workspace_id=${workspaceId}`);
    expect(after.body.installations).toEqual([
      expect.objectContaining({
        installation_id: INSTALLATION_ID,
        workspace_id: workspaceId,
        verified: true,
      }),
    ]);
    const stored = await env.DB.prepare(
      "SELECT account_id, claimed_by, claimed_at FROM github_installations",
    ).first<{ account_id: number; claimed_by: string; claimed_at: number }>();
    expect(stored).toMatchObject({ account_id: ORG.id, claimed_by: userId });
    expect(stored!.claimed_at).toBeGreaterThan(0);
    const membership = recorded.find((r) => r.url.endsWith("/user/memberships/orgs/acme"));
    expect(membership?.authorization).toBe(`Bearer ${USER_TOKEN}`);

    const exchange = recorded.find((r) => r.url === "https://github.com/login/oauth/access_token");
    expect(exchange?.body).toEqual({
      client_id: CLIENT_ID,
      client_secret: "client-secret",
      code: "good-code",
    });
    const listed = recorded.find((r) => r.url.includes("/user/installations"));
    expect(listed?.authorization).toBe(`Bearer ${USER_TOKEN}`);
    const revoked = recorded.find((r) => r.method === "DELETE");
    expect(revoked?.body).toEqual({ access_token: USER_TOKEN });
    expect(revoked?.authorization).toBe(`Basic ${btoa(`${CLIENT_ID}:client-secret`)}`);
    const appCall = recorded.find((r) => r.url.endsWith(`/app/installations/${INSTALLATION_ID}`));
    expect(appCall?.authorization).toMatch(/^Bearer ey/);
    // The user token is gone before the redirect; nothing stores it.
    const settings = await env.DB.prepare("SELECT value FROM instance_settings").all<{
      value: string;
    }>();
    expect(JSON.stringify(settings.results)).not.toContain(USER_TOKEN);

    const added = await env.DB.prepare(
      "SELECT actor_id FROM audit_logs WHERE action = 'github.installation_added'",
    ).first<{ actor_id: string }>();
    expect(added?.actor_id).toBe(userId);
    expect(await rejections()).toEqual([]);
  });

  it("rejects and audits a forged installation_id the user can't access", async () => {
    stubInstallFlow([111, 222]);
    const { owner, workspaceId, userId } = await install();
    await seedApp();
    const state = await installState(owner, workspaceId);
    const res = await callback(owner, {
      installation_id: INSTALLATION_ID,
      state,
      code: "good-code",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://cp.test/settings/github?error=installation_not_accessible",
    );
    expect(await installationCount()).toBe(0);
    // Never asked GitHub about the installation with the App's own credentials.
    expect(recorded.some((r) => r.url.includes("/app/installations/"))).toBe(false);
    // The user token is revoked even when the check fails.
    expect(recorded.some((r) => r.method === "DELETE")).toBe(true);
    expect(await rejections()).toEqual([
      {
        workspace_id: workspaceId,
        actor_id: userId,
        metadata: { installation_id: INSTALLATION_ID, reason: "installation_not_accessible" },
      },
    ]);
  });

  it("refuses a replayed install state, even for the user who started it", async () => {
    stubInstallFlow();
    const { owner, workspaceId } = await install();
    await seedApp();
    const state = await installState(owner, workspaceId);
    const first = await callback(owner, {
      installation_id: INSTALLATION_ID,
      state,
      code: "good-code",
    });
    expect(first.headers.get("location")).toContain("status=installed");
    const callsBefore = recorded.length;

    const replay = await callback(owner, {
      installation_id: INSTALLATION_ID,
      state,
      code: "good-code",
    });
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toBe("https://cp.test/settings/github?error=link_used");
    expect(recorded.length).toBe(callsBefore);
    expect((await rejections()).map((r) => r.metadata.reason)).toEqual(["link_used"]);

    // A fresh link works again.
    const again = await callback(owner, {
      installation_id: INSTALLATION_ID,
      state: await installState(owner, workspaceId),
      code: "good-code",
    });
    expect(again.headers.get("location")).toContain("status=installed");
  });

  it("refuses a callback without an authorization code", async () => {
    stubInstallFlow();
    const { owner, workspaceId } = await install();
    await seedApp();
    const state = await installState(owner, workspaceId);
    const res = await callback(owner, { installation_id: INSTALLATION_ID, state });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://cp.test/settings/github?error=authorization_required",
    );
    expect(recorded).toEqual([]);
    expect(await installationCount()).toBe(0);
    expect((await rejections()).map((r) => r.metadata.reason)).toEqual(["authorization_required"]);
  });

  it("refuses a code GitHub doesn't accept", async () => {
    stubInstallFlow();
    const { owner, workspaceId } = await install();
    await seedApp();
    const state = await installState(owner, workspaceId);
    const res = await callback(owner, {
      installation_id: INSTALLATION_ID,
      state,
      code: "stolen-or-expired",
    });
    expect(res.headers.get("location")).toBe(
      "https://cp.test/settings/github?error=authorization_failed",
    );
    expect(await installationCount()).toBe(0);
    expect((await rejections()).map((r) => r.metadata.reason)).toEqual(["authorization_failed"]);
  });

  it("refuses a forged or expired state before anything else", async () => {
    stubInstallFlow();
    const { owner } = await install();
    await seedApp();
    const forged = await callback(owner, {
      installation_id: INSTALLATION_ID,
      state: "forged.state",
      code: "good-code",
    });
    expect(forged.status).toBe(400);
    expect(recorded).toEqual([]);
    expect(await rejections()).toEqual([]);
  });

  it("refuses an org member who isn't an admin", async () => {
    stubInstallFlow([INSTALLATION_ID], { orgRole: "member" });
    const { owner, workspaceId } = await install();
    await seedApp();
    const res = await callback(owner, {
      installation_id: INSTALLATION_ID,
      state: await installState(owner, workspaceId),
      code: "good-code",
    });
    expect(res.headers.get("location")).toBe(
      "https://cp.test/settings/github?error=not_account_admin",
    );
    expect(await installationCount()).toBe(0);
    expect((await rejections()).map((r) => r.metadata.reason)).toEqual(["not_account_admin"]);
    expect(recorded.some((r) => r.method === "DELETE")).toBe(true);
  });

  it("refuses a user outside the organization", async () => {
    stubInstallFlow([INSTALLATION_ID], { orgRole: null });
    const { owner, workspaceId } = await install();
    await seedApp();
    const res = await callback(owner, {
      installation_id: INSTALLATION_ID,
      state: await installState(owner, workspaceId),
      code: "good-code",
    });
    expect(res.headers.get("location")).toContain("error=not_account_admin");
    expect(await installationCount()).toBe(0);
  });

  it("claims a personal account's installation only for that account's user", async () => {
    stubInstallFlow([INSTALLATION_ID], { account: "user" });
    const { owner, workspaceId } = await install();
    await seedApp();
    const own = await callback(owner, {
      installation_id: INSTALLATION_ID,
      state: await installState(owner, workspaceId),
      code: "good-code",
    });
    expect(own.headers.get("location")).toContain("status=installed");
    // No org membership lookup for a personal account.
    expect(recorded.some((r) => r.url.includes("/memberships/"))).toBe(false);

    stubInstallFlow([INSTALLATION_ID + 1], { account: "other_user" });
    const other = await callback(owner, {
      installation_id: INSTALLATION_ID + 1,
      state: await installState(owner, workspaceId),
      code: "good-code",
    });
    expect(other.headers.get("location")).toContain("error=not_account_admin");
    expect(await installationCount()).toBe(1);
  });

  it("refuses an expired claim, and only starts claims for github:manage with an App", async () => {
    stubInstallFlow();
    const { owner, workspaceId } = await install();
    const before = await owner.json<{ error: { code: string } }>("/v1/github/claims", {
      method: "POST",
      json: { workspace_id: workspaceId },
    });
    expect(before.status).toBe(409);
    await seedApp();
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    expect(
      (
        await member.request("/v1/github/claims", {
          method: "POST",
          json: { workspace_id: workspaceId },
        })
      ).status,
    ).toBe(403);
    const state = await installState(owner, workspaceId);
    const claims = await env.DB.prepare(
      "SELECT workspace_id, consumed_at FROM github_claim_states",
    ).all<{ workspace_id: string; consumed_at: number | null }>();
    expect(claims.results).toEqual([{ workspace_id: workspaceId, consumed_at: null }]);
    await env.DB.prepare("UPDATE github_claim_states SET expires_at = ?")
      .bind(Date.now() - 1000)
      .run();
    const res = await callback(owner, {
      installation_id: INSTALLATION_ID,
      state,
      code: "good-code",
    });
    expect(res.headers.get("location")).toBe("https://cp.test/settings/github?error=link_expired");
    expect(recorded).toEqual([]);
  });

  it("verifies a legacy claim when its workspace claims it again, and never takes another's", async () => {
    stubInstallFlow();
    const { owner, workspaceId } = await install();
    await seedApp();
    await env.DB.prepare(
      "INSERT INTO github_installations (id, installation_id, account_login, account_type, workspace_id, claimed_at, created_at, updated_at) VALUES ('ghi_legacy', ?, 'acme', 'Organization', ?, 1, 0, 0)",
    )
      .bind(INSTALLATION_ID, workspaceId)
      .run();
    const legacy = await owner.json<{ installations: { verified: boolean }[] }>(
      `/v1/github/status?workspace_id=${workspaceId}`,
    );
    expect(legacy.body.installations).toEqual([expect.objectContaining({ verified: false })]);
    const again = await callback(owner, {
      installation_id: INSTALLATION_ID,
      state: await installState(owner, workspaceId),
      code: "good-code",
    });
    expect(again.headers.get("location")).toContain("status=installed");
    const verified = await owner.json<{ installations: { id: string; verified: boolean }[] }>(
      `/v1/github/status?workspace_id=${workspaceId}`,
    );
    expect(verified.body.installations).toEqual([
      expect.objectContaining({ id: "ghi_legacy", verified: true }),
    ]);

    const other = await owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Other" },
    });
    const taken = await callback(owner, {
      installation_id: INSTALLATION_ID,
      state: await installState(owner, other.body.id),
      code: "good-code",
    });
    expect(taken.headers.get("location")).toBe(
      "https://cp.test/settings/github?error=installation_claimed",
    );
    const row = await env.DB.prepare("SELECT workspace_id FROM github_installations").first<{
      workspace_id: string;
    }>();
    expect(row?.workspace_id).toBe(workspaceId);
  });

  it("refuses API tokens", async () => {
    stubInstallFlow();
    const { owner, workspaceId } = await install();
    await seedApp();
    const state = await installState(owner, workspaceId);
    const { body } = await owner.json<{ secret: string }>(`/v1/workspaces/${workspaceId}/tokens`, {
      method: "POST",
      json: { name: "ci", scopes: ["projects:manage"], expires_in_days: 1 },
    });
    const res = await call(
      `/v1/github/callback?installation_id=${INSTALLATION_ID}&state=${encodeURIComponent(state)}&code=good-code`,
      { headers: { authorization: `Bearer ${body.secret}` }, redirect: "manual" },
    );
    expect(res.status).toBe(403);
  });
});

describe("releasing installations", () => {
  it("releases a claim for github:manage in the claiming workspace, and audits it", async () => {
    const { owner, workspaceId, userId } = await install();
    const ghi = await claimInstallation(workspaceId);
    const other = await owner.json<{ id: string }>("/v1/workspaces", {
      method: "POST",
      json: { name: "Other" },
    });
    const wrong = await owner.request(
      `/v1/github/installations/${ghi}?workspace_id=${other.body.id}`,
      { method: "DELETE" },
    );
    expect(wrong.status).toBe(404);
    const member = await addMember(owner, workspaceId, "m@example.com", "member");
    const denied = await member.request(
      `/v1/github/installations/${ghi}?workspace_id=${workspaceId}`,
      { method: "DELETE" },
    );
    expect(denied.status).toBe(403);

    const res = await owner.request(`/v1/github/installations/${ghi}?workspace_id=${workspaceId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    const row = await env.DB.prepare(
      "SELECT workspace_id, claimed_by, claimed_at FROM github_installations WHERE id = ?",
    )
      .bind(ghi)
      .first();
    expect(row).toEqual({ workspace_id: null, claimed_by: null, claimed_at: null });
    const audit = await env.DB.prepare(
      "SELECT workspace_id, actor_id, target_id FROM audit_logs WHERE action = 'github.installation_released'",
    ).first();
    expect(audit).toEqual({ workspace_id: workspaceId, actor_id: userId, target_id: ghi });
    const again = await owner.request(
      `/v1/github/installations/${ghi}?workspace_id=${workspaceId}`,
      { method: "DELETE" },
    );
    expect(again.status).toBe(404);
  });
});

describe("repositories", () => {
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

// -----------------------------------------------------------------------------
// Installation tokens: source checks, minting, redirects
// -----------------------------------------------------------------------------

function privateSource(ghi: string, repoUrl = "https://github.com/acme/api") {
  return {
    type: "git",
    repo_url: repoUrl,
    branch: "main",
    root_dir: ".",
    github_installation_id: ghi,
  };
}

function postService(c: Client, projectId: string, source: Record<string, unknown>) {
  return c.json<{ error: { code: string } }>(`/v1/projects/${projectId}/services`, {
    method: "POST",
    json: { name: "api", source },
  });
}

async function otherWorkspace(owner: Client): Promise<string> {
  const res = await owner.json<{ id: string }>("/v1/workspaces", {
    method: "POST",
    json: { name: "Other" },
  });
  return res.body.id;
}

const tokenRequests = () => recorded.filter((r) => r.url.endsWith("/access_tokens"));

describe("service sources through an installation", () => {
  it("accepts a github.com repository the workspace's installation can read", async () => {
    stubGithub();
    const { owner, workspaceId } = await install();
    await seedApp();
    const ghi = await claimInstallation(workspaceId);
    const project = await createProject(owner, workspaceId);
    const res = await postService(
      owner,
      project.id,
      privateSource(ghi, "https://github.com/ACME/api.git"),
    );
    expect(res.status).toBe(201);
    const listing = recorded.find((r) => r.url.includes("/installation/repositories"));
    expect(listing?.authorization).toBe("Bearer ghs_installationtoken123");
  });

  it("rejects an installation another workspace claimed, or none did, on create and update", async () => {
    stubGithub();
    const { owner, workspaceId } = await install();
    await seedApp();
    const ghi = await claimInstallation(await otherWorkspace(owner));
    const project = await createProject(owner, workspaceId);

    const created = await postService(owner, project.id, privateSource(ghi));
    expect(created.status).toBe(400);
    expect(created.body.error.code).toBe("installation_not_in_workspace");

    const svc = await createService(owner, project.id, {
      name: "public",
      source: {
        type: "git",
        repo_url: "https://github.com/acme/api",
        branch: "main",
        root_dir: ".",
      },
    });
    const patch = () =>
      owner.json<{ error: { code: string } }>(`/v1/services/${svc.service.id}`, {
        method: "PATCH",
        json: { environment_id: project.environments[0]!.id, source: privateSource(ghi) },
      });
    const patched = await patch();
    expect(patched.status).toBe(400);
    expect(patched.body.error.code).toBe("installation_not_in_workspace");

    await env.DB.prepare("UPDATE github_installations SET workspace_id = NULL").run();
    expect((await patch()).body.error.code).toBe("installation_not_in_workspace");
    expect(tokenRequests()).toEqual([]);
  });

  it("rejects a repository off github.com without minting anything", async () => {
    stubGithub();
    const { owner, workspaceId } = await install();
    await seedApp();
    const ghi = await claimInstallation(workspaceId);
    const project = await createProject(owner, workspaceId);
    for (const url of [
      "https://gitlab.com/acme/api",
      "https://github.com.evil.example/acme/api",
      "https://evil.example/github.com/acme/api",
      "https://github.com/acme/api/tree/main",
    ]) {
      const res = await postService(owner, project.id, privateSource(ghi, url));
      expect(res.status, url).toBe(400);
      expect(res.body.error.code, url).toBe("repository_not_in_installation");
    }
    expect(tokenRequests()).toEqual([]);
  });

  it("rejects a repository the installation can't read, or a suspended installation", async () => {
    installationRepos = ["acme/web", "other/api"];
    stubGithub();
    const { owner, workspaceId } = await install();
    await seedApp();
    const ghi = await claimInstallation(workspaceId);
    const project = await createProject(owner, workspaceId);
    const res = await postService(owner, project.id, privateSource(ghi));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("repository_not_in_installation");

    stubGithub([
      [
        /^POST https:\/\/api\.github\.com\/app\/installations\/\d+\/access_tokens$/,
        () => Response.json({ message: "This installation has been suspended" }, { status: 403 }),
      ],
    ]);
    const suspended = await postService(owner, project.id, privateSource(ghi));
    expect(suspended.status).toBe(400);
    expect(suspended.body.error.code).toBe("repository_not_in_installation");
  });
});

describe("minting installation tokens", () => {
  it("scopes a token to the one repository and re-checks the workspace every time", async () => {
    stubGithub();
    const { workspaceId } = await install();
    await seedApp();
    const ghi = await claimInstallation(workspaceId);
    const db = createDb(env.DB);
    const mint = (over: Partial<Parameters<typeof mintRepoToken>[2]> = {}) =>
      mintRepoToken(db, env, {
        workspaceId,
        installationRef: ghi,
        repoUrl: "https://github.com/acme/api.git",
        permissions: { contents: "read" },
        ...over,
      });

    expect(await mint()).toBe("ghs_installationtoken123");
    expect(tokenRequests().map((r) => r.body)).toEqual([
      { repositories: ["api"], permissions: { contents: "read" } },
    ]);
    expect(await mint({ repoUrl: "https://gitlab.com/acme/api" })).toBeNull();
    expect(await mint({ installationRef: null })).toBeNull();

    await expect(mint({ workspaceId: "ws_someoneelse" })).rejects.toBeInstanceOf(
      InstallationAccessError,
    );
    await env.DB.prepare("UPDATE github_installations SET workspace_id = NULL").run();
    await expect(mint()).rejects.toBeInstanceOf(InstallationAccessError);
    await env.DB.prepare("DELETE FROM github_installations").run();
    await expect(mint()).rejects.toBeInstanceOf(InstallationAccessError);
    expect(tokenRequests()).toHaveLength(1);
  });

  it("fails deployments once the installation left the service's workspace", async () => {
    stubGithub();
    const { owner, workspaceId } = await install();
    await seedApp();
    const ghi = await claimInstallation(workspaceId);
    const agent = await connectWorkloadAgent(await joinNode(owner, workspaceId));
    const project = await createProject(owner, workspaceId);
    const svc = await createService(owner, project.id, { name: "api", source: privateSource(ghi) });
    const envId = project.environments.find((e) => e.kind === "production")!.id;
    await env.DB.prepare("UPDATE github_installations SET workspace_id = ?")
      .bind(await otherWorkspace(owner))
      .run();
    recorded = [];

    // With a commit the token is for the build job; without one, for resolving the branch.
    const built = await deploy(owner, svc.service.id, envId, { commit_sha: COMMIT_SHA });
    const failedBuild = await waitForStatus(owner, built.id, ["active", "failed"]);
    expect(failedBuild.failure_reason).toMatch(/no longer connected to its workspace/);
    const resolved = await deploy(owner, svc.service.id, envId);
    const failedResolve = await waitForStatus(owner, resolved.id, ["active", "failed"]);
    expect(failedResolve.failure_reason).toMatch(/no longer connected to its workspace/);

    expect(agent.received.some((m) => m.type === "build_job")).toBe(false);
    expect(tokenRequests()).toEqual([]);
  });
});

describe("credentials and redirects", () => {
  const pkt = (line: string) => `${(line.length + 4).toString(16).padStart(4, "0")}${line}`;

  function stubFetch(answer: () => Response) {
    const seen: { url: string; authorization: string | null; redirect: unknown }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      seen.push({
        url: req.url,
        authorization: req.headers.get("authorization"),
        redirect: init?.redirect,
      });
      return answer();
    }) as typeof fetch;
    return seen;
  }

  it("resolveBranch sends a token only to https://github.com", async () => {
    const seen = stubFetch(() => new Response(`${pkt(`${COMMIT_SHA} refs/heads/main\n`)}0000`));
    expect(await resolveBranch("https://github.com/acme/api", "main", "ghs_tok")).toBe(COMMIT_SHA);
    expect(seen).toEqual([
      {
        url: "https://github.com/acme/api/info/refs?service=git-upload-pack",
        authorization: `Basic ${btoa("x-access-token:ghs_tok")}`,
        redirect: "manual",
      },
    ]);
    for (const url of [
      "https://gitlab.com/acme/api",
      "https://github.com.evil.example/acme/api",
      "https://evil.example@github.com/acme/api",
      "http://github.com/acme/api",
    ]) {
      await expect(resolveBranch(url, "main", "ghs_tok"), url).rejects.toThrow(/refusing/);
    }
    expect(seen).toHaveLength(1);

    expect(await resolveBranch("https://gitlab.com/acme/api", "main")).toBe(COMMIT_SHA);
    expect(seen[1]).toMatchObject({ authorization: null, redirect: "manual" });
  });

  it("resolveBranch treats a redirect as an error instead of following it", async () => {
    const seen = stubFetch(
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/x" } }),
    );
    await expect(resolveBranch("https://github.com/acme/api", "main", "ghs_tok")).rejects.toThrow(
      /redirect/,
    );
    await expect(resolveBranch("https://gitlab.com/acme/api", "main")).rejects.toThrow(/redirect/);
    expect(seen.map((s) => new URL(s.url).host)).toEqual(["github.com", "gitlab.com"]);
  });

  it("GitHub API calls stay on api.github.com and don't follow redirects", async () => {
    const seen = stubFetch(
      () => new Response(null, { status: 307, headers: { location: "https://evil.example/x" } }),
    );
    const err = await githubRequest("/installation/repositories", { auth: "ghs_tok" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GithubApiError);
    expect((err as GithubApiError).status).toBe(307);
    expect(seen).toEqual([
      {
        url: "https://api.github.com/installation/repositories",
        authorization: "Bearer ghs_tok",
        redirect: "manual",
      },
    ]);
    await expect(githubRequest("@evil.example/steal", { auth: "ghs_tok" })).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });
});
