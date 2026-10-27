/**
 * A fake Cloudflare API over HTTP for end-to-end runs of Cloudflare for SaaS
 * (ADR 0009) and DNS-01: zones, DNS records, custom hostnames, the fallback
 * origin and the published IP ranges, under `/client/v4`.
 *
 * It keeps the documented behaviour the control plane must cope with, the
 * same as the Workers suite's in-process fake (`apps/api/test/fake-cloudflare.ts`):
 * - custom hostnames start `pending` and turn `active` (status, then SSL)
 *   after `activateAfter` reads; DCV records appear only on `GET`, never in
 *   the `POST` answer;
 * - the fallback origin starts `pending_deployment` and turns `active` after
 *   `fallbackActiveAfter` reads;
 * - deleting something unknown answers 404, which callers count as deleted;
 * - zone calls need the configured token (403 otherwise); `/ips` needs none.
 *
 * @example
 * const cf = await startFakeCloudflare({ zoneId, zoneName: "saas.test", token });
 * // point the control plane at cf.url, then:
 * await cf.close();
 *
 * @module
 */
import { createServer } from "node:http";

/**
 * @typedef {object} FakeCloudflareOptions
 * @property {string} zoneId - 32 hex characters.
 * @property {string} zoneName - E.g. `saas.example.net`.
 * @property {string} token - The API token calls must carry.
 * @property {number} [activateAfter] - Reads of a custom hostname before it is `active` (default 1).
 * @property {number} [fallbackActiveAfter] - Reads of the fallback origin before it is `active` (default 1).
 * @property {number} [port] - Port to listen on; 0 (default) picks a free one.
 */

/**
 * @typedef {object} FakeCloudflareServer
 * @property {string} url - Base URL, e.g. `http://127.0.0.1:41234/client/v4`.
 * @property {Map<string, object>} hostnames - Custom hostnames by ID.
 * @property {Map<string, object>} records - DNS records by ID.
 * @property {{ origin: string | null, reads: number }} fallback - The fallback origin.
 * @property {string[]} calls - Every request, as `METHOD path?query`.
 * @property {(pattern: RegExp, times?: number) => void} failNext - Fails matching requests with 500.
 * @property {() => Promise<void>} close - Stops the server.
 */

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const ok = (res, result, status = 200) => json(res, status, { success: true, errors: [], result });
const fail = (res, status, message) =>
  json(res, status, { success: false, errors: [{ code: status, message }] });

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => resolve(raw ? JSON.parse(raw) : null));
  });

/**
 * Starts the fake on 127.0.0.1.
 *
 * @param {FakeCloudflareOptions} options - Zone, token, timing and port.
 * @returns {Promise<FakeCloudflareServer>} The running fake.
 */
export async function startFakeCloudflare(options) {
  const activateAfter = options.activateAfter ?? 1;
  const fallbackActiveAfter = options.fallbackActiveAfter ?? 1;
  const hostnames = new Map();
  const records = new Map();
  const fallback = { origin: null, reads: 0 };
  const calls = [];
  const failures = [];
  let seq = 0;
  const nextId = () => (++seq).toString(16).padStart(32, "0");

  const view = (h, withDcv) => {
    const active = h.reads > activateAfter;
    const sslActive = h.reads > activateAfter + 1;
    return {
      id: h.id,
      hostname: h.hostname,
      status: active ? "active" : "pending",
      ...(h.custom_origin_server ? { custom_origin_server: h.custom_origin_server } : {}),
      ssl: {
        status: sslActive ? "active" : "pending_validation",
        method: "http",
        type: "dv",
        ...(withDcv && !sslActive
          ? {
              validation_records: [
                { txt_name: `_acme-challenge.${h.hostname}`, txt_value: `ssl-${h.id.slice(-8)}` },
              ],
            }
          : {}),
      },
      ...(withDcv
        ? {
            ownership_verification: {
              type: "txt",
              name: `_cf-custom-hostname.${h.hostname}`,
              value: `own-${h.id.slice(-8)}`,
            },
          }
        : {}),
      verification_errors: active ? [] : ["custom hostname does not CNAME to this zone."],
    };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const path = url.pathname.replace(/^\/client\/v4/, "");
    calls.push(`${req.method} ${path}${url.search}`);
    const failure = failures.find((f) => f.pattern.test(`${req.method} ${path}`));
    if (failure) {
      failure.times--;
      if (failure.times <= 0) failures.splice(failures.indexOf(failure), 1);
      return fail(res, 500, "internal error");
    }
    if (path === "/ips" && req.method === "GET") {
      return ok(res, {
        ipv4_cidrs: ["173.245.48.0/20", "103.21.244.0/22", "104.16.0.0/13"],
        ipv6_cidrs: ["2400:cb00::/32", "2606:4700::/32"],
      });
    }
    if (req.headers.authorization !== `Bearer ${options.token}`) {
      return fail(res, 403, "Authentication error");
    }
    const zone = `/zones/${options.zoneId}`;
    if (!path.startsWith(zone)) return fail(res, 404, "Could not route to zone");
    const rest = path.slice(zone.length);
    const body = req.method === "GET" || req.method === "DELETE" ? null : await readBody(req);

    if (rest === "" && req.method === "GET") {
      return ok(res, { id: options.zoneId, name: options.zoneName });
    }
    if (rest === "/custom_hostnames" && req.method === "GET") {
      return ok(
        res,
        [...hostnames.values()].filter((h) => !h.deleted).map((h) => view(h, false)),
      );
    }
    if (rest === "/custom_hostnames" && req.method === "POST") {
      if ([...hostnames.values()].some((h) => !h.deleted && h.hostname === body.hostname)) {
        return fail(res, 409, "Duplicate custom hostname found.");
      }
      const h = {
        id: nextId(),
        hostname: body.hostname,
        custom_origin_server: body.custom_origin_server ?? null,
        reads: 0,
        deleted: false,
      };
      hostnames.set(h.id, h);
      // Like Cloudflare, the create answer omits the DCV records.
      return ok(res, view(h, false), 201);
    }
    if (rest === "/custom_hostnames/fallback_origin") {
      if (req.method === "PUT") {
        fallback.origin = body.origin;
        fallback.reads = 0;
        return ok(res, { origin: fallback.origin, status: "pending_deployment" });
      }
      if (req.method === "GET") {
        if (!fallback.origin) return fail(res, 404, "No fallback origin");
        fallback.reads++;
        return ok(res, {
          origin: fallback.origin,
          status: fallback.reads >= fallbackActiveAfter ? "active" : "pending_deployment",
        });
      }
    }
    const hostnameMatch = rest.match(/^\/custom_hostnames\/([^/]+)$/);
    if (hostnameMatch) {
      const h = hostnames.get(decodeURIComponent(hostnameMatch[1]));
      if (!h || h.deleted) return fail(res, 404, "Custom hostname not found");
      if (req.method === "GET") {
        h.reads++;
        return ok(res, view(h, true));
      }
      if (req.method === "DELETE") {
        h.deleted = true;
        return ok(res, { id: h.id });
      }
    }
    if (rest === "/dns_records" && req.method === "GET") {
      const name = url.searchParams.get("name");
      return ok(
        res,
        [...records.values()].filter((r) => !name || r.name === name),
      );
    }
    if (rest === "/dns_records" && req.method === "POST") {
      const r = {
        id: nextId(),
        type: body.type,
        name: body.name,
        content: body.content,
        proxied: body.proxied ?? false,
      };
      records.set(r.id, r);
      return ok(res, r);
    }
    const recordMatch = rest.match(/^\/dns_records\/([^/]+)$/);
    if (recordMatch && req.method === "DELETE") {
      if (!records.delete(recordMatch[1])) return fail(res, 404, "Record not found");
      return ok(res, { id: recordMatch[1] });
    }
    return fail(res, 404, `No route for ${req.method} ${path}`);
  });

  await new Promise((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/client/v4`,
    hostnames,
    records,
    fallback,
    calls,
    failNext(pattern, times = 1) {
      failures.push({ pattern, times });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
