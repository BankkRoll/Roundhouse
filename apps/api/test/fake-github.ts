/**
 * A fake GitHub REST API for the preview tests (ADR 0007, "Testing
 * strategy"), installed as a `fetch` stub in the test isolate, where the
 * Worker, its Durable Objects and its Workflows also run.
 *
 * It serves installation tokens, the installation's repositories, commit
 * statuses, issue comments (list, create, update), labels (add, remove) and
 * collaborator permissions, with response shapes taken from GitHub's
 * documented examples, and records every request so tests can assert what
 * reached GitHub (and that nothing secret did).
 *
 * It also seeds the instance's App and a claimed installation, and signs
 * webhook bodies with the App's webhook secret.
 */
import { env } from "cloudflare:test";
import { createDb } from "@roundhouse/db";
import { toBase64 } from "@roundhouse/protocol";
import { storeGithubApp } from "../src/lib/github";
import { call } from "./helpers";

/** The App's webhook secret in tests. Not a real credential. */
export const FAKE_WEBHOOK_SECRET = "test-webhook-secret-not-real";
/** The App's numeric ID. */
export const FAKE_APP_ID = 1012345;
/** The App's slug; its bot is `<slug>[bot]`. */
export const FAKE_APP_SLUG = "roundhouse-cp-a1b2c3";
/** GitHub's ID of the installation the tests claim. */
export const FAKE_INSTALLATION_ID = 55501234;
/** Our ID of that installation. */
export const FAKE_INSTALLATION_REF = "ghi_01TESTPREVIEWINSTALL";
/** The installation token the fake hands out. Not a real credential. */
export const FAKE_INSTALLATION_TOKEN = "test-installation-token-0001";

/** One request that reached the fake. */
export interface RecordedRequest {
  method: string;
  /** Path and query under the API origin. */
  path: string;
  body: unknown;
  authorization: string | null;
}

interface Comment {
  id: number;
  body: string;
  user: { login: string; type: string };
  performed_via_github_app: { id: number } | null;
}

/** The fake's state; tests read and change it directly. */
export interface FakeGithub {
  requests: RecordedRequest[];
  /** Repositories the installation can read, `owner/repo`. */
  repositories: string[];
  /** Collaborator permission by login; missing means not a collaborator (404). */
  permissions: Map<string, string>;
  /** Issue comments by `owner/repo#n`. */
  comments: Map<string, Comment[]>;
  /** Labels by `owner/repo#n`. */
  labels: Map<string, Set<string>>;
  /** Commit statuses posted, in order. */
  statuses: {
    repo: string;
    sha: string;
    state: string;
    context: string;
    description: string;
    target_url: string;
  }[];
  /** Requests to `path` (a regex over `METHOD path`) fail with this status. */
  failures: [RegExp, number][];
  /** Removes the stub. */
  restore(): void;
}

const realFetch = globalThis.fetch;
let nextCommentId = 9000;

let rsaPem: string | undefined;

/** A PKCS#8 PEM RSA key for the App; generated once per test file. */
async function appPem(): Promise<string> {
  if (rsaPem) return rsaPem;
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
  const der = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const body = toBase64(der).replace(/(.{64})/g, "$1\n");
  const label = "PRIVATE KEY";
  rsaPem = `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
  return rsaPem;
}

/**
 * Stores the App (sealed, as the manifest flow would) and claims the
 * installation for a workspace.
 *
 * @param workspaceId - The claiming workspace.
 * @returns Our installation ID.
 */
export async function seedGithub(workspaceId: string): Promise<string> {
  await storeGithubApp(createDb(env.DB), env, {
    id: FAKE_APP_ID,
    slug: FAKE_APP_SLUG,
    name: "Roundhouse cp a1b2c3",
    html_url: `https://github.com/apps/${FAKE_APP_SLUG}`,
    owner: { login: "acme" },
    client_id: "Iv23liTestClientId0001",
    client_secret: "test-client-secret-not-real",
    webhook_secret: FAKE_WEBHOOK_SECRET,
    pem: await appPem(),
  });
  await env.DB.prepare(
    "INSERT INTO github_installations (id, installation_id, account_login, account_type, workspace_id, claimed_at, created_at, updated_at) VALUES (?, ?, 'acme', 'Organization', ?, 0, 0, 0)",
  )
    .bind(FAKE_INSTALLATION_REF, FAKE_INSTALLATION_ID, workspaceId)
    .run();
  return FAKE_INSTALLATION_REF;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/**
 * Installs the fake as `globalThis.fetch` for `https://api.github.com`;
 * every other URL goes to the real fetch.
 *
 * @returns The fake's state.
 */
export function fakeGithub(): FakeGithub {
  const fake: FakeGithub = {
    requests: [],
    repositories: ["acme/shop"],
    permissions: new Map(),
    comments: new Map(),
    labels: new Map(),
    statuses: [],
    failures: [],
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin !== "https://api.github.com") return realFetch(input, init);
    const text = await req.clone().text();
    const body = text ? JSON.parse(text) : null;
    const path = `${url.pathname}${url.search}`;
    fake.requests.push({
      method: req.method,
      path,
      body,
      authorization: req.headers.get("authorization"),
    });
    const key = `${req.method} ${path}`;
    const failure = fake.failures.find(([re]) => re.test(key));
    if (failure) return json({ message: "Simulated failure" }, failure[1]);
    return route(fake, req.method, url, body);
  }) as typeof fetch;
  return fake;
}

function route(fake: FakeGithub, method: string, url: URL, body: unknown): Response {
  const p = url.pathname;
  const at = (re: RegExp) => re.exec(p) ?? undefined;
  let m: RegExpExecArray | undefined;
  if (method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(p)) {
    return json({ token: FAKE_INSTALLATION_TOKEN, expires_at: "2026-10-27T14:00:00Z" }, 201);
  }
  if (method === "GET" && p === "/installation/repositories") {
    return json({
      total_count: fake.repositories.length,
      repositories: fake.repositories.map((full_name, i) => ({
        id: 1000 + i,
        full_name,
        private: true,
        default_branch: "main",
        clone_url: `https://github.com/${full_name}.git`,
      })),
    });
  }
  m = at(/^\/repos\/([^/]+\/[^/]+)\/statuses\/([a-f0-9]+)$/);
  if (m && method === "POST") {
    const b = body as { state: string; context: string; description: string; target_url: string };
    fake.statuses.push({ repo: m[1]!, sha: m[2]!, ...b });
    return json({ id: fake.statuses.length, state: b.state, context: b.context }, 201);
  }
  m = at(/^\/repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)\/permission$/);
  if (m) {
    const permission = fake.permissions.get(decodeURIComponent(m[2]!));
    if (!permission) return json({ message: "Not Found" }, 404);
    return json({
      permission,
      role_name: permission === "write" ? "write" : permission,
      user: { login: decodeURIComponent(m[2]!) },
    });
  }
  m = at(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/);
  if (m) {
    const k = `${m[1]}#${m[2]}`;
    const list = fake.comments.get(k) ?? [];
    if (method === "GET") {
      const page = Number(url.searchParams.get("page") ?? "1");
      return json(list.slice((page - 1) * 100, page * 100));
    }
    if (method === "POST") {
      const c: Comment = {
        id: nextCommentId++,
        body: (body as { body: string }).body,
        user: { login: `${FAKE_APP_SLUG}[bot]`, type: "Bot" },
        performed_via_github_app: { id: FAKE_APP_ID },
      };
      fake.comments.set(k, [...list, c]);
      return json(c, 201);
    }
  }
  m = at(/^\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/);
  if (m && method === "PATCH") {
    for (const list of fake.comments.values()) {
      const c = list.find((x) => x.id === Number(m![2]));
      if (c) {
        c.body = (body as { body: string }).body;
        return json(c);
      }
    }
    return json({ message: "Not Found" }, 404);
  }
  m = at(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/labels$/);
  if (m && method === "POST") {
    const k = `${m[1]}#${m[2]}`;
    const set = fake.labels.get(k) ?? new Set<string>();
    for (const l of (body as { labels: string[] }).labels) set.add(l);
    fake.labels.set(k, set);
    return json([...set].map((name) => ({ name })));
  }
  m = at(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/labels\/(.+)$/);
  if (m && method === "DELETE") {
    const set = fake.labels.get(`${m[1]}#${m[2]}`);
    const name = decodeURIComponent(m[3]!);
    if (!set?.has(name)) return json({ message: "Label does not exist" }, 404);
    set.delete(name);
    return json([...set].map((n) => ({ name: n })));
  }
  return json({ message: `fake GitHub has no route for ${method} ${p}` }, 404);
}

/**
 * `X-Hub-Signature-256` of a body under the fake App's webhook secret.
 *
 * @param body - The raw body.
 * @param secret - Defaults to the App's.
 */
export async function signWebhook(body: string, secret = FAKE_WEBHOOK_SECRET): Promise<string> {
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

/**
 * Delivers a webhook to the Worker, signed unless `signature` says otherwise.
 *
 * @param event - `X-GitHub-Event`.
 * @param payload - The body.
 * @param opts - Delivery ID and signature override (`null` omits it).
 */
export async function deliver(
  event: string,
  payload: unknown,
  opts: { delivery?: string; signature?: string | null } = {},
): Promise<Response> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-event": event,
    "x-github-delivery": opts.delivery ?? crypto.randomUUID(),
    "user-agent": "GitHub-Hookshot/abc123",
    origin: "",
  };
  const signature = opts.signature === undefined ? await signWebhook(body) : opts.signature;
  if (signature !== null) headers["x-hub-signature-256"] = signature;
  return call("/v1/webhooks/github", { method: "POST", headers, body });
}
