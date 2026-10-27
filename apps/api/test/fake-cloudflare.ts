/**
 * An in-process Cloudflare API for the Workers suite, installed with
 * `setCloudflareTransport`. It covers what Cloudflare for SaaS and DNS-01
 * call, with the documented behaviour the code must cope with:
 *
 * - custom hostnames start `pending` and turn `active` (status, then SSL)
 *   after a set number of reads; their DCV records appear only on `GET`,
 *   never in the `POST` answer;
 * - the fallback origin starts `pending_deployment` and turns `active`
 *   after a set number of reads;
 * - deleting something unknown answers 404, which callers count as deleted;
 * - every zone call needs the configured token (403 otherwise); `/ips` needs none.
 *
 * `e2e/lib/fake-cloudflare.mjs` is the same fake as an HTTP server.
 */

/** A custom hostname as the fake keeps it. */
export interface FakeHostname {
  id: string;
  hostname: string;
  custom_origin_server: string | null;
  reads: number;
  deleted: boolean;
}

/** A DNS record as the fake keeps it. */
export interface FakeRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

/** Options of {@link fakeCloudflare}. */
export interface FakeCloudflareOptions {
  zoneId: string;
  zoneName: string;
  token: string;
  /** Reads of a custom hostname before its status is `active`. */
  activateAfter?: number;
  /** Reads of the fallback origin before it is `active`. */
  fallbackActiveAfter?: number;
}

/** The fake and its state. */
export interface FakeCloudflare {
  fetch: typeof fetch;
  hostnames: Map<string, FakeHostname>;
  records: Map<string, FakeRecord>;
  fallback: { origin: string | null; reads: number };
  /** Every request, as `METHOD path`. */
  calls: string[];
  /** Makes the next matching requests fail with 500. */
  failNext(pattern: RegExp, times?: number): void;
}

const ok = (result: unknown, status = 200) =>
  new Response(JSON.stringify({ success: true, errors: [], result }), {
    status,
    headers: { "content-type": "application/json" },
  });
const fail = (status: number, message: string) =>
  new Response(JSON.stringify({ success: false, errors: [{ code: status, message }] }), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Creates a fake Cloudflare API.
 *
 * @param options - Zone, token and status timing.
 * @returns The fake.
 */
export function fakeCloudflare(options: FakeCloudflareOptions): FakeCloudflare {
  const activateAfter = options.activateAfter ?? 1;
  const fallbackActiveAfter = options.fallbackActiveAfter ?? 1;
  const hostnames = new Map<string, FakeHostname>();
  const records = new Map<string, FakeRecord>();
  const fallback = { origin: null as string | null, reads: 0 };
  const calls: string[] = [];
  const failures: { pattern: RegExp; times: number }[] = [];
  let seq = 0;
  const nextId = () => (++seq).toString(16).padStart(32, "0");

  const view = (h: FakeHostname, withDcv: boolean) => {
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
                {
                  txt_name: `_acme-challenge.${h.hostname}`,
                  txt_value: `ssl-${h.id.slice(-8)}`,
                },
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

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/client\/v4/, "");
    calls.push(`${req.method} ${path}${url.search}`);
    const failure = failures.find((f) => f.pattern.test(`${req.method} ${path}`));
    if (failure) {
      failure.times--;
      if (failure.times <= 0) failures.splice(failures.indexOf(failure), 1);
      return fail(500, "internal error");
    }
    if (path === "/ips" && req.method === "GET") {
      return ok({
        ipv4_cidrs: ["173.245.48.0/20", "103.21.244.0/22", "104.16.0.0/13"],
        ipv6_cidrs: ["2400:cb00::/32", "2606:4700::/32"],
      });
    }
    if (req.headers.get("authorization") !== `Bearer ${options.token}`) {
      return fail(403, "Authentication error");
    }
    const zone = `/zones/${options.zoneId}`;
    if (!path.startsWith(zone)) return fail(404, "Could not route to zone");
    const rest = path.slice(zone.length);
    const body = req.method === "GET" || req.method === "DELETE" ? null : await req.json();

    if (rest === "" && req.method === "GET")
      return ok({ id: options.zoneId, name: options.zoneName });
    if (rest === "/custom_hostnames" && req.method === "GET") {
      return ok([...hostnames.values()].filter((h) => !h.deleted).map((h) => view(h, false)));
    }
    if (rest === "/custom_hostnames" && req.method === "POST") {
      const b = body as { hostname: string; custom_origin_server?: string };
      if ([...hostnames.values()].some((h) => !h.deleted && h.hostname === b.hostname)) {
        return fail(409, "Duplicate custom hostname found.");
      }
      const h: FakeHostname = {
        id: nextId(),
        hostname: b.hostname,
        custom_origin_server: b.custom_origin_server ?? null,
        reads: 0,
        deleted: false,
      };
      hostnames.set(h.id, h);
      // NOTE: like Cloudflare, the create answer may omit the DCV records.
      return ok(view(h, false), 201);
    }
    if (rest === "/custom_hostnames/fallback_origin") {
      if (req.method === "PUT") {
        fallback.origin = (body as { origin: string }).origin;
        fallback.reads = 0;
        return ok({ origin: fallback.origin, status: "pending_deployment" });
      }
      if (req.method === "GET") {
        if (!fallback.origin) return fail(404, "No fallback origin");
        fallback.reads++;
        return ok({
          origin: fallback.origin,
          status: fallback.reads >= fallbackActiveAfter ? "active" : "pending_deployment",
        });
      }
    }
    const hostnameMatch = rest.match(/^\/custom_hostnames\/([^/]+)$/);
    if (hostnameMatch) {
      const h = hostnames.get(decodeURIComponent(hostnameMatch[1]!));
      if (!h || h.deleted) return fail(404, "Custom hostname not found");
      if (req.method === "GET") {
        h.reads++;
        return ok(view(h, true));
      }
      if (req.method === "DELETE") {
        h.deleted = true;
        return ok({ id: h.id });
      }
    }
    if (rest === "/dns_records" && req.method === "GET") {
      const name = url.searchParams.get("name");
      return ok([...records.values()].filter((r) => !name || r.name === name));
    }
    if (rest === "/dns_records" && req.method === "POST") {
      const b = body as { type: string; name: string; content: string; proxied?: boolean };
      const r: FakeRecord = {
        id: nextId(),
        type: b.type,
        name: b.name,
        content: b.content,
        proxied: b.proxied ?? false,
      };
      records.set(r.id, r);
      return ok(r);
    }
    const recordMatch = rest.match(/^\/dns_records\/([^/]+)$/);
    if (recordMatch && req.method === "DELETE") {
      if (!records.delete(recordMatch[1]!)) return fail(404, "Record not found");
      return ok({ id: recordMatch[1] });
    }
    return fail(404, `No route for ${req.method} ${path}`);
  };

  return {
    fetch: handler as typeof fetch,
    hostnames,
    records,
    fallback,
    calls,
    failNext(pattern, times = 1) {
      failures.push({ pattern, times });
    },
  };
}
