import { describe, expect, it } from "vitest";
import { defaultFirewall, defaultFirewallRules } from "../../src/firewall";
import {
  buildLinodeOffers,
  filterLinodeImages,
  fromLinode,
  hasScope,
  isUsableRegion,
  parseLinodeError,
  parseScopes,
  randomRootPassword,
  toLinodeRules,
} from "../../src/linode";
import type { LinodeCreateBody } from "../../src/linode/types";
import { filterOffers } from "../../src/provision";
import { errors, IMAGES, linode, REGIONS, TYPES } from "../fixtures/linode";
import { JOIN_TOKEN, rejection, SSH_KEY } from "../helpers";
import { setup, linode as target } from "../targets";

const input = {
  name: "web-1",
  plan: "g6-standard-2",
  region: "us-east",
  controlPlaneUrl: "https://cp.example.com",
  joinToken: JOIN_TOKEN,
};

describe("client", () => {
  it("pages with page_size=500 and sends filters in X-Filter", async () => {
    const { fake, driver } = setup(target);
    for (let i = 0; i < 1100; i++) {
      fake.seedServer({
        name: `n${i}`,
        labels: { "roundhouse.managed": "true", "roundhouse.node": `n${i}` },
      });
    }
    const all = await driver.client.listLinodes({ tags: "roundhouse.managed=true" });
    expect(all).toHaveLength(1100);
    expect(fake.requests.map((r) => [r.query.get("page"), r.query.get("page_size")])).toEqual([
      ["1", "500"],
      ["2", "500"],
      ["3", "500"],
    ]);
    expect(JSON.parse(fake.requests[0]!.headers.get("x-filter")!)).toEqual({
      tags: "roundhouse.managed=true",
    });
  });

  it("waits out a spent fixed-window rate limit", async () => {
    const { fake, driver, clock } = setup(target);
    fake.rateLimit = { limit: 20, remaining: 1, reset: Math.floor(clock.now / 1000) + 15 };
    await driver.client.listRegions();
    await driver.client.listRegions();
    expect(clock.sleeps).toEqual([15_000]);
  });

  it("maps {errors:[{field,reason}]} to normalised codes", () => {
    expect(parseLinodeError(401, JSON.stringify(errors.unauthorized))).toMatchObject({
      provider: "linode",
      code: "unauthorized",
      providerCode: "http_401",
    });
    expect(parseLinodeError(400, JSON.stringify(errors.page_size))).toMatchObject({
      code: "invalid_input",
      providerCode: "page_size",
      details: errors.page_size.errors,
    });
    const unique =
      '{"errors":[{"field":"label","reason":"Label must be unique among your Linodes"}]}';
    expect(parseLinodeError(400, unique).code).toBe("conflict");
    const limit = '{"errors":[{"reason":"Account limit reached. Please open a support ticket."}]}';
    expect(parseLinodeError(400, limit).code).toBe("quota_exceeded");
    expect(parseLinodeError(429, "").code).toBe("rate_limited");
  });
});

describe("validateToken", () => {
  it("reads scopes from X-OAuth-Scopes and returns the profile", async () => {
    const { provider } = setup(target);
    expect(await provider.validateToken()).toEqual({
      valid: true,
      canWrite: true,
      account: { id: "1234", email: "example-user@gmail.com", name: "exampleUser" },
    });
  });

  it("names the scopes a token lacks", async () => {
    const { fake, provider } = setup(target);
    fake.scopes.set("rw-token", "linodes:read_write images:read_only");
    expect(await provider.validateToken()).toMatchObject({
      canWrite: false,
      missing: ["firewall:read_write"],
    });
    const { provider: ro } = setup(target, { token: "ro-token" });
    expect(await ro.validateToken()).toMatchObject({
      canWrite: false,
      missing: ["linodes:read_write", "firewall:read_write"],
    });
  });

  it("probes the create scope when the header is absent", async () => {
    const { fake, provider } = setup(target);
    fake.scopes.set("rw-token", null);
    expect(await provider.validateToken()).toMatchObject({ canWrite: true });
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /profile",
      "POST /linode/instances",
    ]);
    expect(fake.linodes.size).toBe(0);
  });

  it("refuses a restricted user, who cannot tag Linodes", async () => {
    const { fake, provider } = setup(target);
    fake.restricted = true;
    const check = await provider.validateToken();
    expect(check.canWrite).toBe(false);
    expect(check.missing?.[0]).toMatch(/unrestricted/);
  });

  it("parses scope strings", () => {
    expect(parseScopes("linodes:read_write firewall:read_only")).toEqual([
      "linodes:read_write",
      "firewall:read_only",
    ]);
    expect(parseScopes("unknown")).toBeNull();
    expect(parseScopes(null)).toBeNull();
    expect(hasScope(["*"], "firewall:read_write")).toBe(true);
    expect(hasScope(["images:read_write"], "images:read_only")).toBe(true);
    expect(hasScope(["images:read_only"], "images:read_write")).toBe(false);
  });
});

describe("offers and images", () => {
  const offers = filterOffers(buildLinodeOffers(TYPES, REGIONS));

  it("offers only regions with Linodes, Metadata, and Cloud Firewall that are up", () => {
    expect(REGIONS.filter(isUsableRegion).map((r) => r.id)).toEqual(["us-east", "br-gru"]);
    expect(new Set(offers.map((o) => o.region))).toEqual(new Set(["us-east", "br-gru"]));
  });

  it("applies region price overrides and converts MB disks to GB", () => {
    const std = offers.filter((o) => o.plan === "g6-standard-2");
    expect(Object.fromEntries(std.map((o) => [o.region, o.price.monthlyCents]))).toEqual({
      "us-east": 2400,
      "br-gru": 3360,
    });
    expect(std[0]).toMatchObject({
      vcpus: 2,
      memoryMib: 4096,
      diskGb: 80,
      includedTrafficTb: 4,
      arch: "amd64",
      dedicated: false,
      country: "US",
      regionName: "Newark, NJ",
      price: { currency: "USD" },
    });
  });

  it("classifies dedicated and premium plans, and skips GPUs", () => {
    expect(offers.find((o) => o.plan === "g6-dedicated-2")!.dedicated).toBe(true);
    expect(offers.filter((o) => o.plan === "g7-premium-2").map((o) => o.region)).toEqual([
      "br-gru",
    ]);
    expect(offers.some((o) => o.plan.startsWith("g1-gpu"))).toBe(false);
  });

  it("flags types with a successor as deprecated", () => {
    const all = buildLinodeOffers(TYPES, REGIONS);
    expect(all.find((o) => o.plan === "g6-standard-1")!.deprecated).toBe(true);
    expect(offers.some((o) => o.plan === "g6-standard-1")).toBe(false);
    expect(
      filterOffers(all, { includeDeprecated: true }).some((o) => o.plan === "g6-standard-1"),
    ).toBe(true);
  });

  it("keeps only supported public images with the cloud-init capability", () => {
    const imgs = filterLinodeImages(IMAGES);
    expect(imgs.map((i) => i.id)).toEqual([
      "linode/ubuntu24.04",
      "linode/ubuntu22.04",
      "linode/debian12",
    ]);
    const noInit = filterLinodeImages([{ ...IMAGES[0]!, capabilities: [] }]);
    expect(noInit).toEqual([]);
  });

  it("refuses a region without the Metadata service", async () => {
    const { provider } = setup(target);
    expect((await rejection(provider.provision({ ...input, region: "eu-west" }))).reason).toBe(
      "offer_unavailable",
    );
  });
});

describe("names and tags", () => {
  it("applies Linode's label rules on top of the node-name rule", async () => {
    const { provider } = setup(target);
    for (const name of ["ab", "0node", "a--b"]) {
      expect((await rejection(provider.provision({ ...input, name }))).reason, name).toBe(
        "invalid_input",
      );
    }
  });

  it("rejects labels whose tags exceed 50 characters", async () => {
    const { provider } = setup(target);
    const long = `n${"x".repeat(34)}`;
    expect((await rejection(provider.provision({ ...input, name: long }))).reason).toBe(
      "invalid_input",
    );
    expect((await provider.provision({ ...input, name: long.slice(0, 34) })).created).toBe(true);
  });
});

describe("firewall and create", () => {
  it("maps rules to a DROP-inbound, ACCEPT-outbound rule set", () => {
    expect(toLinodeRules(defaultFirewallRules())).toEqual({
      inbound_policy: "DROP",
      outbound_policy: "ACCEPT",
      inbound: [
        {
          action: "ACCEPT",
          protocol: "TCP",
          ports: "80",
          addresses: { ipv4: ["0.0.0.0/0"], ipv6: ["::/0"] },
          description: "HTTP ingress and ACME",
        },
        {
          action: "ACCEPT",
          protocol: "TCP",
          ports: "443",
          addresses: { ipv4: ["0.0.0.0/0"], ipv6: ["::/0"] },
          description: "HTTPS ingress",
        },
        {
          action: "ACCEPT",
          protocol: "UDP",
          ports: "443",
          addresses: { ipv4: ["0.0.0.0/0"], ipv6: ["::/0"] },
          description: "HTTP/3 ingress",
        },
      ],
      outbound: [],
    });
  });

  it("tags the managed firewall and refuses an unmanaged one with the same label", async () => {
    const { fake, driver } = setup(target);
    const id = await driver.ensureFirewall(defaultFirewall(), {});
    expect(fake.firewalls.get(Number(id))!.tags).toEqual([
      "roundhouse.managed=true",
      "roundhouse.firewall=default",
    ]);
    expect(await driver.ensureFirewall(defaultFirewall(), {})).toBe(id);
    fake.firewalls.get(Number(id))!.tags = [];
    expect((await rejection(driver.ensureFirewall(defaultFirewall(), {}))).reason).toBe(
      "name_taken",
    );
  });

  it("creates with firewall_id, inline keys, base64 metadata, and a throwaway root password", async () => {
    const { fake, provider } = setup(target);
    const r = await provider.provision({ ...input, sshPublicKey: SSH_KEY });
    const body = fake.requests.find((q) => fake.isCreate(q))!.body as LinodeCreateBody;
    expect(body).toMatchObject({
      label: "web-1",
      region: "us-east",
      type: "g6-standard-2",
      image: "linode/ubuntu24.04",
      firewall_id: Number(r.firewallId),
      authorized_keys: [SSH_KEY.split(" ").slice(0, 2).join(" ")],
      booted: true,
      tags: ["roundhouse.managed=true", "roundhouse.node=web-1", "roundhouse.role=node"],
    });
    expect(atob(body.metadata.user_data)).toContain(JOIN_TOKEN);
    expect(body.root_pass.length).toBeGreaterThanOrEqual(40);
    expect(JSON.stringify(r)).not.toContain(body.root_pass);
    expect(r.sshKeyId).toBeNull();
  });

  it("generates strong, distinct root passwords", () => {
    const a = randomRootPassword();
    expect(a).toMatch(/[A-Z]/);
    expect(a).toMatch(/[a-z]/);
    expect(a).toMatch(/\d/);
    expect(a).toMatch(/[^A-Za-z0-9]/);
    expect(randomRootPassword()).not.toBe(a);
  });

  it("maps the public IPv4, strips the IPv6 prefix, and normalises status", () => {
    const l = linode({
      id: 1,
      label: "a",
      ipv4: ["192.168.1.5", "203.0.113.1"],
      status: "booting",
    });
    expect(fromLinode(l)).toMatchObject({
      ipv4: "203.0.113.1",
      ipv6: "c001:d00d::1337",
      status: "provisioning",
    });
    expect(fromLinode({ ...l, ipv6: null, status: "offline" })).toMatchObject({
      ipv6: null,
      status: "stopped",
    });
    expect(fromLinode({ ...l, status: "deleting" }).status).toBe("deleting");
  });

  it("asks to retry while a managed Linode with the name is deleting", async () => {
    const { fake, provider } = setup(target);
    fake.seedServer({
      name: "web-1",
      labels: { "roundhouse.managed": "true", "roundhouse.node": "web-1" },
      status: "deleting",
    });
    expect((await rejection(provider.provision(input))).reason).toBe("server_deleting");
  });
});
