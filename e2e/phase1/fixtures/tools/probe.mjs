/**
 * Talks to the node's Caddy from inside the engine's host network, where its
 * :80/:443 and admin API live. Hostnames never need DNS: requests go to
 * 127.0.0.1 with the right Host header (and SNI for HTTPS), so the test
 * works offline and with any apps domain.
 *
 *   node probe.mjs get <host> [path] [--https]   one request, JSON result on stdout
 *   node probe.mjs loop <host> [path] [--https]  requests back to back until stdin
 *                                               closes, then a JSON summary
 *   node probe.mjs admin <path>                  GET Caddy's admin API
 *   node probe.mjs url <url>                     GET any http:// URL (e.g. the registry)
 */
import http from "node:http";
import https from "node:https";

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const [host, path = "/"] = rest.filter((a) => !a.startsWith("--"));
const secure = flags.has("--https");

function admin(p) {
  return new Promise((resolve, reject) => {
    http
      .get(
        { host: "127.0.0.1", port: 2019, path: p, headers: { host: "localhost:2019" } },
        (res) => {
          let body = "";
          res.on("data", (d) => {
            body += d;
          });
          res.on("end", () => resolve({ status: res.statusCode, body }));
        },
      )
      .on("error", reject);
  });
}

let ca;
async function caddyRoot() {
  if (!ca) {
    const res = await admin("/pki/ca/local");
    if (res.status !== 200) throw new Error(`caddy pki: ${res.status} ${res.body}`);
    ca = JSON.parse(res.body).root_certificate;
  }
  return ca;
}

async function request(timeoutMs = 5000) {
  const started = Date.now();
  const opts = {
    host: "127.0.0.1",
    port: secure ? 443 : 80,
    path,
    headers: { host, connection: "close" },
    agent: false,
    timeout: timeoutMs,
  };
  if (secure) {
    opts.servername = host;
    opts.ca = await caddyRoot();
  }
  return new Promise((resolve) => {
    const req = (secure ? https : http).get(opts, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => {
        body += d;
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          body,
          headers: res.headers,
          ms: Date.now() - started,
          ...(secure
            ? {
                tls: {
                  authorized: res.socket.authorized ?? null,
                  protocol: res.socket.getProtocol?.() ?? null,
                  issuer: res.socket.getPeerCertificate?.()?.issuer?.CN ?? null,
                },
              }
            : {}),
        }),
      );
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ status: 0, error: err.message, ms: Date.now() - started }));
  });
}

if (cmd === "get") {
  process.stdout.write(`${JSON.stringify(await request())}\n`);
} else if (cmd === "admin") {
  const res = await admin(host);
  process.stdout.write(`${JSON.stringify(res)}\n`);
} else if (cmd === "url") {
  const res = await fetch(host, {
    headers: {
      accept: [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
      ].join(", "),
    },
  });
  process.stdout.write(`${JSON.stringify({ status: res.status, body: await res.text() })}\n`);
} else if (cmd === "loop") {
  let stop = false;
  process.stdin.on("data", () => {
    stop = true;
  });
  process.stdin.on("end", () => {
    stop = true;
  });
  const summary = {
    total: 0,
    failed: 0,
    resets: [],
    statuses: {},
    bodies: {},
    failures: [],
    max_ms: 0,
  };
  process.stdout.write("ready\n");
  while (!stop) {
    let r = await request(10_000);
    // NOTE: Each Caddy config load shuts the previous server down, and Go's
    // net/http closes, without an answer, a connection whose first request
    // it reads after shutdown began. A connection reset is therefore retried
    // once, as an idempotent-retrying client would, and counted in `resets`;
    // HTTP errors (404, 502, ...) are never retried.
    if (r.status === 0 && /socket hang up|ECONNRESET/.test(r.error ?? "")) {
      summary.resets.push({ at: new Date().toISOString(), error: r.error });
      r = await request(10_000);
    }
    summary.total += 1;
    summary.statuses[r.status] = (summary.statuses[r.status] ?? 0) + 1;
    summary.max_ms = Math.max(summary.max_ms, r.ms);
    if (r.status < 200 || r.status >= 400) {
      summary.failed += 1;
      if (summary.failures.length < 20) {
        summary.failures.push({
          at: new Date().toISOString(),
          status: r.status,
          error: r.error,
          body: r.body?.slice(0, 200),
        });
      }
    } else {
      const key = r.body.slice(0, 200);
      summary.bodies[key] = (summary.bodies[key] ?? 0) + 1;
    }
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
