/**
 * Docker harness for the Pebble ACME integration test: a uniquely named
 * network with `pebble-challtestsrv` (DNS + HTTP-01 responder) and Pebble
 * pointed at it, plus a `fetch` that trusts Pebble's test CA.
 *
 * Everything is named `rh-acme-<random>` so concurrent runs (other agents,
 * CI shards) never collide, and {@link PebbleHarness.stop} removes it all.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Pebble, pinned by digest (`docker inspect --format '{{index .RepoDigests 0}}'`). */
export const PEBBLE_IMAGE =
  "ghcr.io/letsencrypt/pebble@sha256:ddf230642b1a584f519f32e347de1b05a6e4c1f6c35c1863b33effeab5f78199";

/** pebble-challtestsrv, pinned by digest. */
export const CHALLTESTSRV_IMAGE =
  "ghcr.io/letsencrypt/pebble-challtestsrv@sha256:12ce21884def456bcf9786542113949e1f19dc7738d2c70e156c2d0c38a1405b";

/** Path of the minica root that signs Pebble's own HTTPS certificate, inside the image. */
const MINICA_PATH = "/test/certs/pebble.minica.pem";

function docker(args: string[], timeout = 120_000): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Whether a Docker daemon is reachable.
 *
 * @returns `true` when `docker info` succeeds.
 */
export function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * A `fetch` over `node:https` that trusts exactly `ca`. Node's global fetch
 * cannot take a per-call CA without undici's dispatcher, and disabling
 * verification would hide real TLS problems.
 *
 * @param ca - PEM CA certificate(s) to trust.
 * @returns A fetch-compatible function.
 */
export function fetchTrusting(ca: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    // Pebble rejects requests without a User-Agent (RFC 8555 §6.1); the client
    // sends its own, this covers the harness's readiness and root fetches.
    headers["user-agent"] ??= "roundhouse-acme-test";
    return new Promise<Response>((resolve, reject) => {
      const req = httpsRequest(
        url,
        { method, headers, ca, agent: false, signal: init?.signal ?? undefined },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const out = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (Array.isArray(value)) for (const v of value) out.append(key, v);
              else if (value !== undefined) out.set(key, value);
            }
            const status = res.statusCode ?? 0;
            const nullBody = method === "HEAD" || [101, 204, 205, 304].includes(status);
            resolve(
              new Response(nullBody ? null : Buffer.concat(chunks), { status, headers: out }),
            );
          });
        },
      );
      req.on("error", reject);
      if (typeof init?.body === "string") req.write(init.body);
      req.end();
    });
  }) as typeof fetch;
}

/** A running Pebble + challtestsrv pair. */
export interface PebbleHarness {
  /** Pebble's ACME directory URL on the host. */
  directoryUrl: string;
  /** Fetch that trusts Pebble's HTTPS certificate. */
  fetch: typeof fetch;
  /** Pebble's current root certificate (PEM), from its management API. */
  root(): Promise<string>;
  /** Registers an HTTP-01 response with challtestsrv. */
  addHttp01(token: string, content: string): Promise<void>;
  /** Adds a TXT record at `_acme-challenge.<host>` with challtestsrv. */
  setTxt(host: string, value: string): Promise<void>;
  /** Removes containers, network and temp files; safe to call repeatedly. */
  stop(): void;
}

async function waitUntil(
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function hostPort(container: string, port: number): string {
  const line = docker(["port", container, `${port}/tcp`]).split(/\r?\n/)[0] ?? "";
  const match = line.match(/:(\d+)$/);
  if (!match) throw new Error(`no host port for ${container}:${port}`);
  return match[1] as string;
}

/**
 * Starts the harness. On any failure everything already created is removed
 * before the error propagates.
 *
 * @returns The running harness.
 */
export async function startPebble(): Promise<PebbleHarness> {
  const name = `rh-acme-${randomBytes(4).toString("hex")}`;
  const network = name;
  const cts = `${name}-cts`;
  const pebble = `${name}-pebble`;
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const args of [
      ["rm", "-f", pebble, cts],
      ["network", "rm", network],
    ]) {
      try {
        docker(args, 60_000);
      } catch {
        // Already gone (or never created); nothing to clean.
      }
    }
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    docker(["network", "create", network]);
    // An empty defaultIPv6 means no AAAA answers, so Pebble's VA dials the IPv4
    // address we point at challtestsrv instead of ::1 inside Pebble's container.
    docker([
      "run",
      "-d",
      "--name",
      cts,
      "--network",
      network,
      "-p",
      "127.0.0.1::8055",
      CHALLTESTSRV_IMAGE,
      "-defaultIPv6",
      "",
      "-doh",
      "",
      "-tlsalpn01",
      "",
      "-https01",
      "",
    ]);
    const ctsIp = docker([
      "inspect",
      "-f",
      `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
      cts,
    ]);
    const mgmt = `http://127.0.0.1:${hostPort(cts, 8055)}`;
    const ctsPost = async (path: string, body: unknown) => {
      const res = await fetch(`${mgmt}${path}`, { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`challtestsrv ${path}: HTTP ${res.status}`);
    };
    await waitUntil(async () => {
      await ctsPost("/set-default-ipv4", { ip: ctsIp });
      return true;
    }, "challtestsrv");

    docker([
      "run",
      "-d",
      "--name",
      pebble,
      "--network",
      network,
      "-e",
      "PEBBLE_VA_NOSLEEP=1",
      "-e",
      "PEBBLE_WFE_NONCEREJECT=0",
      "-p",
      "127.0.0.1::14000",
      "-p",
      "127.0.0.1::15000",
      PEBBLE_IMAGE,
      "-config",
      "test/config/pebble-config.json",
      "-dnsserver",
      `${ctsIp}:8053`,
    ]);
    const caFile = join(dir, "minica.pem");
    docker(["cp", `${pebble}:${MINICA_PATH}`, caFile]);
    const httpsFetch = fetchTrusting(readFileSync(caFile, "utf8"));
    const directoryUrl = `https://127.0.0.1:${hostPort(pebble, 14000)}/dir`;
    const management = `https://127.0.0.1:${hostPort(pebble, 15000)}`;
    await waitUntil(async () => (await httpsFetch(directoryUrl)).ok, "pebble directory");

    return {
      directoryUrl,
      fetch: httpsFetch,
      async root() {
        const res = await httpsFetch(`${management}/roots/0`);
        if (!res.ok) throw new Error(`pebble roots: HTTP ${res.status}`);
        return res.text();
      },
      addHttp01: (token, content) => ctsPost("/add-http01", { token, content }),
      setTxt: (host, value) => ctsPost("/set-txt", { host: `_acme-challenge.${host}.`, value }),
      stop,
    };
  } catch (err) {
    stop();
    throw err;
  }
}
