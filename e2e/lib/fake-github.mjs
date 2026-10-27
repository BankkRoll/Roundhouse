/**
 * A fake GitHub REST API for the real-stack previews suite (ADR 0007,
 * "Testing strategy"): the control plane runs with `GITHUB_API_URL` pointed
 * at it, so nothing needs a GitHub account.
 *
 * It answers what previews call (installation tokens, the installation's
 * repositories, commit statuses, issue comments, labels, collaborator
 * permissions) and the manifest conversion that stores the App, records
 * every request, and signs webhook deliveries with the App's secret.
 *
 * @module
 */
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";

/** The App's webhook secret. Test-only, not a credential. */
export const WEBHOOK_SECRET = "e2e-webhook-secret-not-real";
/** GitHub's ID of the installation the suite uses. */
export const INSTALLATION_ID = 55501234;
/** The App's slug; its bot is `<slug>[bot]`. */
export const APP_SLUG = "roundhouse-e2e";
const APP_ID = 1012345;

/**
 * Starts the fake on 127.0.0.1.
 *
 * @param {{ port: number, repositories: string[] }} opts
 * @returns {Promise<{
 *   url: string,
 *   requests: { method: string, path: string, body: unknown }[],
 *   permissions: Map<string, string>,
 *   comments: Map<string, { id: number, body: string }[]>,
 *   labels: Map<string, Set<string>>,
 *   statuses: { sha: string, state: string, context: string, description: string }[],
 *   close: () => Promise<void>,
 * }>}
 */
export async function startFakeGithub({ port, repositories }) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const state = {
    url: `http://127.0.0.1:${port}`,
    requests: [],
    permissions: new Map(),
    comments: new Map(),
    labels: new Map(),
    statuses: [],
  };
  let nextComment = 9000;

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    const url = new URL(req.url ?? "/", state.url);
    const p = url.pathname;
    state.requests.push({ method: req.method ?? "GET", path: `${p}${url.search}`, body });
    let m;
    m = /^\/app-manifests\/([^/]+)\/conversions$/.exec(p);
    if (req.method === "POST" && m) {
      return json(res, 201, {
        id: APP_ID,
        slug: APP_SLUG,
        name: "Roundhouse e2e",
        html_url: `https://github.com/apps/${APP_SLUG}`,
        owner: { login: "acme" },
        client_id: "Iv23liE2eClientId0001",
        client_secret: "e2e-client-secret-not-real",
        webhook_secret: WEBHOOK_SECRET,
        pem,
      });
    }
    if (req.method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(p)) {
      return json(res, 201, {
        token: `e2e-installation-token-${randomUUID()}`,
        expires_at: "2099-01-01T00:00:00Z",
      });
    }
    if (req.method === "GET" && p === "/installation/repositories") {
      return json(res, 200, {
        total_count: repositories.length,
        repositories: repositories.map((full_name, i) => ({
          id: 1000 + i,
          full_name,
          private: false,
          default_branch: "main",
          clone_url: `https://github.com/${full_name}.git`,
        })),
      });
    }
    m = /^\/repos\/[^/]+\/[^/]+\/statuses\/([a-f0-9]+)$/.exec(p);
    if (req.method === "POST" && m) {
      state.statuses.push({ sha: m[1], ...body });
      return json(res, 201, { id: state.statuses.length });
    }
    m = /^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission$/.exec(p);
    if (m) {
      const permission = state.permissions.get(decodeURIComponent(m[1]));
      if (!permission) return json(res, 404, { message: "Not Found" });
      return json(res, 200, { permission, user: { login: decodeURIComponent(m[1]) } });
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(p);
    if (m) {
      const key = `${m[1]}#${m[2]}`;
      const list = state.comments.get(key) ?? [];
      if (req.method === "GET") return json(res, 200, list);
      const comment = {
        id: nextComment++,
        body: body.body,
        user: { login: `${APP_SLUG}[bot]`, type: "Bot" },
        performed_via_github_app: { id: APP_ID },
      };
      state.comments.set(key, [...list, comment]);
      return json(res, 201, comment);
    }
    m = /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(p);
    if (req.method === "PATCH" && m) {
      for (const list of state.comments.values()) {
        const c = list.find((x) => x.id === Number(m[1]));
        if (c) {
          c.body = body.body;
          return json(res, 200, c);
        }
      }
      return json(res, 404, { message: "Not Found" });
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(p);
    if (m) {
      const key = `${m[1]}#${m[2]}`;
      const set = state.labels.get(key) ?? new Set();
      state.labels.set(key, set);
      if (req.method === "POST") for (const l of body.labels) set.add(l);
      if (req.method === "DELETE") {
        const name = decodeURIComponent(m[3] ?? "");
        if (!set.delete(name)) return json(res, 404, { message: "Label does not exist" });
      }
      return json(
        res,
        200,
        [...set].map((name) => ({ name })),
      );
    }
    return json(res, 404, { message: `fake GitHub has no route for ${req.method} ${p}` });
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    ...state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Delivers a signed webhook to the control plane.
 *
 * @param {string} base - Control plane origin.
 * @param {string} event - `X-GitHub-Event`.
 * @param {unknown} payload - The body.
 * @returns {Promise<number>} The response status.
 */
export async function deliver(base, event, payload) {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`;
  const res = await fetch(`${base}/v1/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": signature,
      "user-agent": "GitHub-Hookshot/e2e",
    },
    body,
  });
  await res.text();
  return res.status;
}
