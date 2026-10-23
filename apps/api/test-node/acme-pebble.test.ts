/**
 * End-to-end ACME issuance against Pebble in Docker (ADR 0009 "Testing
 * strategy"). Run with `pnpm --filter @roundhouse/api run test:pebble`; the
 * suite skips itself when no Docker daemon is reachable.
 */

import { randomBytes, X509Certificate } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AcmeAuthorization,
  AcmeClient,
  AcmeError,
  type AcmeOrder,
  ariCertId,
  computeRenewAfter,
  createCsr,
  exportPrivateKeyPem,
  generateAccountKey,
  generateCertificateKey,
  parseCertificateChain,
  splitPemChain,
} from "../src/lib/acme/index";
import { dockerAvailable, type PebbleHarness, startPebble } from "./pebble";

const hasDocker = dockerAvailable();

async function poll<T>(
  load: () => Promise<T>,
  done: (value: T) => boolean,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await load();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const unique = (label: string) => `${label}-${randomBytes(4).toString("hex")}.example.com`;

describe.skipIf(!hasDocker)("ACME client against Pebble", () => {
  let pebble: PebbleHarness;
  let client: AcmeClient;
  let accountKey: JsonWebKey;

  beforeAll(async () => {
    pebble = await startPebble();
    accountKey = await generateAccountKey();
    client = new AcmeClient({ directoryUrl: pebble.directoryUrl, accountKey, fetch: pebble.fetch });
    await client.register({ contact: ["mailto:ops@example.com"] });
  });

  afterAll(() => {
    pebble?.stop();
  });

  type Solver = (authz: AcmeAuthorization) => Promise<string>;

  const http01: Solver = async (authz) => {
    const challenge = authz.challenges.find((c) => c.type === "http-01");
    if (!challenge) throw new Error("no http-01 challenge");
    await pebble.addHttp01(challenge.token, await client.keyAuthorization(challenge.token));
    return challenge.url;
  };

  const dns01: Solver = async (authz) => {
    const challenge = authz.challenges.find((c) => c.type === "dns-01");
    if (!challenge) throw new Error("no dns-01 challenge");
    await pebble.setTxt(authz.identifier.value, await client.dns01Value(challenge.token));
    return challenge.url;
  };

  async function authorize(order: AcmeOrder, solve: Solver): Promise<void> {
    for (const url of order.authorizations) {
      const authz = await client.getAuthorization(url);
      if (authz.status === "valid") continue;
      await client.respondToChallenge(await solve(authz));
    }
  }

  async function issue(hostnames: string[], solve: Solver, replaces?: string) {
    const order = await client.newOrder(hostnames, replaces ? { replaces } : {});
    await authorize(order, solve);
    const ready = await poll(
      () => client.getOrder(order.url),
      (o) => o.status !== "pending",
      "order ready",
    );
    expect(ready.status).toBe("ready");
    const keys = await generateCertificateKey();
    await client.finalize(ready.finalize, await createCsr(keys, hostnames));
    const valid = await poll(
      () => client.getOrder(order.url),
      (o) => o.status !== "processing",
      "order valid",
    );
    expect(valid.status).toBe("valid");
    const pem = await client.downloadCertificate(valid.certificate!);
    return { pem, keys };
  }

  async function verifyChain(pem: string, keys: CryptoKeyPair, hostnames: string[]) {
    const blocks = splitPemChain(pem);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    expect(pem).toBe(blocks.join(""));
    expect(pem.endsWith("-----END CERTIFICATE-----\n")).toBe(true);
    const [leaf, intermediate] = blocks.map((b) => new X509Certificate(b));
    const root = new X509Certificate(await pebble.root());
    expect(leaf!.checkIssued(intermediate!)).toBe(true);
    expect(leaf!.verify(intermediate!.publicKey)).toBe(true);
    expect(intermediate!.checkIssued(root)).toBe(true);
    expect(intermediate!.verify(root.publicKey)).toBe(true);

    const ours = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
    const theirs = leaf!.publicKey.export({ format: "jwk" });
    expect({ x: theirs.x, y: theirs.y }).toEqual({ x: ours.x, y: ours.y });

    const info = parseCertificateChain(pem);
    expect([...info.subjectAltNames].sort()).toEqual([...hostnames].sort());
    expect(info.notBefore).toBe(Date.parse(leaf!.validFrom));
    expect(info.notAfter).toBe(Date.parse(leaf!.validTo));
    expect(info.serialHex).toBe(leaf!.serialNumber.toLowerCase().replace(/^(00)+(?=.)/, ""));
    expect(info.authorityKeyId).toMatch(/^[0-9a-f]+$/);
    expect(info.issuer).toContain("CN=");
    return info;
  }

  it("issues a single name over HTTP-01", async () => {
    const name = unique("http");
    const { pem, keys } = await issue([name], http01);
    await verifyChain(pem, keys, [name]);
    expect(await exportPrivateKeyPem(keys.privateKey)).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
  });

  it("issues a wildcard and its base name over DNS-01", async () => {
    const base = unique("dns");
    const names = [`*.${base}`, base];
    const { pem, keys } = await issue(names, dns01);
    await verifyChain(pem, keys, names);
  });

  it("surfaces a failed validation with the CA's problem detail", async () => {
    const name = unique("fail");
    const order = await client.newOrder([name]);
    const [authzUrl] = order.authorizations;
    const authz = await client.getAuthorization(authzUrl!);
    const challenge = authz.challenges.find((c) => c.type === "http-01")!;
    await client.respondToChallenge(challenge.url);

    const failed = await poll(
      () => client.getAuthorization(authzUrl!),
      (a) => a.status !== "pending",
      "authz",
    );
    expect(failed.status).toBe("invalid");
    const failedChallenge = failed.challenges.find((c) => c.type === "http-01")!;
    expect(failedChallenge.status).toBe("invalid");
    expect(failedChallenge.error?.type).toMatch(/^urn:ietf:params:acme:error:/);
    expect(failedChallenge.error?.detail).toBeTruthy();

    const invalid = await client.getOrder(order.url);
    expect(invalid.status).toBe("invalid");

    const err = await client
      .finalize(invalid.finalize, await createCsr(await generateCertificateKey(), [name]))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AcmeError);
    expect((err as AcmeError).type).toMatch(/^urn:ietf:params:acme:error:/);
    expect((err as AcmeError).status).toBeGreaterThanOrEqual(400);
    expect((err as AcmeError).detail).toBeTruthy();
  });

  it("finds the existing account for the same key", async () => {
    const again = new AcmeClient({
      directoryUrl: pebble.directoryUrl,
      accountKey,
      fetch: pebble.fetch,
    });
    expect(await again.register()).toBe(client.accountUrl);
  });

  it("schedules renewal from ARI (or the one-third fallback) and renews with replaces", async () => {
    const name = unique("renew");
    const first = await issue([name], http01);
    const leaf = await verifyChain(first.pem, first.keys, [name]);
    const certId = ariCertId(leaf);
    expect(certId).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const directory = await client.directory();
    const ari = await client.renewalInfo(certId!);
    if (directory.renewalInfo) {
      expect(ari).not.toBeNull();
      expect(ari!.end).toBeGreaterThan(ari!.start);
      const at = computeRenewAfter(leaf, ari);
      expect(at).toBeGreaterThanOrEqual(ari!.start);
      expect(at).toBeLessThan(ari!.end);
    } else {
      expect(ari).toBeNull();
      const lifetime = leaf.notAfter - leaf.notBefore;
      expect(computeRenewAfter(leaf, null)).toBe(Math.floor(leaf.notAfter - lifetime / 3));
    }

    const renewed = await issue([name], http01, certId!);
    const next = await verifyChain(renewed.pem, renewed.keys, [name]);
    expect(next.serialHex).not.toBe(leaf.serialHex);
  });

  it("resumes an order from serialisable state", async () => {
    const name = unique("resume");
    const order = await client.newOrder([name]);
    const resumed = new AcmeClient({
      directoryUrl: pebble.directoryUrl,
      accountKey: JSON.parse(JSON.stringify(accountKey)),
      accountUrl: client.accountUrl,
      fetch: pebble.fetch,
    });
    const again = await resumed.getOrder(order.url);
    expect(again.identifiers).toEqual([{ type: "dns", value: name }]);
  });
});
