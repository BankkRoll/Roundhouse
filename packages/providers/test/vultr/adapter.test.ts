import { describe, expect, it } from "vitest";
import { defaultFirewall, defaultFirewallRules } from "../../src/firewall";
import { filterOffers } from "../../src/provision";
import {
  buildVultrOffers,
  filterVultrImages,
  fromVultrInstance,
  parseVultrError,
  toVultrRules,
  vultrFirewallDescriptions,
  vultrStatus,
} from "../../src/vultr";
import type { VultrCreateInstanceBody } from "../../src/vultr/types";
import { vultrError } from "../fakes/vultr";
import { docCreatedInstance, errors, OS_LIST, PLANS, REGIONS } from "../fixtures/vultr";
import { JOIN_TOKEN, SSH_KEY } from "../helpers";
import { setup, vultr as target } from "../targets";

const input = {
  name: "web-1",
  plan: "vc2-2c-4gb",
  region: "ewr",
  controlPlaneUrl: "https://cp.example.com",
  joinToken: JOIN_TOKEN,
};

describe("client", () => {
  it("follows meta.links.next cursors until the empty string, ignoring meta.total", async () => {
    const { fake, driver } = setup(target);
    fake.pageCap = 2;
    const regions = await driver.client.listRegions();
    expect(regions.map((r) => r.id)).toEqual(["ewr", "ams", "sao"]);
    const cursors = fake.requests.map((r) => [r.query.get("per_page"), r.query.get("cursor")]);
    expect(cursors).toEqual([
      ["500", null],
      ["500", btoa("next__2")],
    ]);
  });

  it("honours Retry-After on 429, Vultr's only rate-limit signal", async () => {
    const { fake, driver, clock } = setup(target);
    let n = 0;
    fake.intercept(() =>
      n++ === 0
        ? new Response('{"error":"Rate limit","status":429}', {
            status: 429,
            headers: { "retry-after": "2" },
          })
        : undefined,
    );
    await driver.client.listPlans();
    expect(clock.sleeps).toEqual([2000]);
  });

  it("maps {error, status} bodies, refining 400s by message", () => {
    expect(parseVultrError(401, JSON.stringify(errors.unauthorized))).toMatchObject({
      provider: "vultr",
      code: "unauthorized",
      providerCode: "http_401",
      message: expect.stringContaining("Invalid API token."),
    });
    expect(parseVultrError(404, JSON.stringify(errors.not_found)).code).toBe("not_found");
    expect(parseVultrError(400, JSON.stringify(errors.per_page)).code).toBe("invalid_input");
    expect(
      parseVultrError(
        400,
        '{"error":"You have reached the maximum number of active instances (instance limit)","status":400}',
      ).code,
    ).toBe("quota_exceeded");
    expect(parseVultrError(500, "oops").code).toBe("unavailable");
    expect(parseVultrError(405, JSON.stringify(errors.method_not_allowed)).code).toBe("unknown");
  });
});

describe("validateToken", () => {
  it("accepts the account owner's key and returns the account", async () => {
    const { provider } = setup(target);
    expect(await provider.validateToken()).toEqual({
      valid: true,
      canWrite: true,
      account: { email: "admin@example.com", name: "Example Account" },
    });
  });

  it("names the ACLs a sub-user lacks", async () => {
    const { fake, provider } = setup(target);
    fake.acls = ["subscriptions_view", "subscriptions", "provisioning"];
    expect(await provider.validateToken()).toMatchObject({
      valid: true,
      canWrite: false,
      missing: ["firewall"],
    });
    fake.acls = ["provisioning", "subscriptions", "firewall"];
    expect(await provider.validateToken()).toMatchObject({ canWrite: true });
  });

  it("treats an empty ACL list as the unrestricted account owner", async () => {
    const { fake, provider } = setup(target);
    fake.acls = [];
    expect(await provider.validateToken()).toMatchObject({ canWrite: true });
  });
});

describe("offers and images", () => {
  const offers = filterOffers(buildVultrOffers(PLANS, REGIONS));

  it("applies per-region price overrides", () => {
    const one = offers.filter((o) => o.plan === "vc2-1c-1gb");
    expect(Object.fromEntries(one.map((o) => [o.region, o.price.monthlyCents]))).toEqual({
      ams: 500,
      ewr: 500,
      sao: 750,
    });
    expect(one[0]).toMatchObject({
      price: { currency: "USD" },
      arch: "amd64",
      category: "Cloud Compute",
      memoryMib: 1024,
    });
  });

  it("marks Optimized Cloud plans dedicated and skips GPU, undeployable, and below-floor plans", () => {
    expect(offers.find((o) => o.plan === "voc-g-2c-8gb-50s")).toMatchObject({
      dedicated: true,
      category: "Optimized Cloud Compute",
    });
    const ids = buildVultrOffers(PLANS, REGIONS).map((o) => o.plan);
    expect(ids).not.toContain("vcg-a16-2c-16g-4vram");
    expect(ids).not.toContain("vhf-1c-1gb");
    expect(offers.map((o) => o.plan)).not.toContain("vc2-1c-0.5gb");
    expect(offers.find((o) => o.id === "vc2-2c-4gb@ewr")!.includedTrafficTb).toBeCloseTo(3.072);
  });

  it("maps OS names to the supported images by numeric os_id", () => {
    expect(filterVultrImages(OS_LIST).map((i) => [i.id, i.name])).toEqual([
      ["2284", "ubuntu-24.04"],
      ["1743", "ubuntu-22.04"],
      ["2136", "debian-12"],
    ]);
    expect(
      filterVultrImages([
        { id: 9, name: "Ubuntu 24.04 LTS arm64", arch: "arm64", family: "ubuntu" },
      ]),
    ).toEqual([]);
  });
});

describe("firewall groups", () => {
  it("maps each neutral rule to one rule per IP family", () => {
    const rules = toVultrRules(defaultFirewallRules());
    expect(rules).toHaveLength(6);
    expect(rules.slice(0, 2)).toEqual([
      {
        ip_type: "v4",
        protocol: "tcp",
        port: "80",
        subnet: "0.0.0.0",
        subnet_size: 0,
        source: "",
        notes: "HTTP ingress and ACME",
      },
      {
        ip_type: "v6",
        protocol: "tcp",
        port: "80",
        subnet: "::",
        subnet_size: 0,
        source: "",
        notes: "HTTP ingress and ACME",
      },
    ]);
  });

  it("creates the group pending, adds every rule, then marks it ready", async () => {
    const { fake, driver } = setup(target);
    const id = await driver.ensureFirewall(defaultFirewall({ allowSsh: true }), {});
    const { ready } = vultrFirewallDescriptions("roundhouse-default-ssh");
    expect(fake.groups.get(id)!.description).toBe(ready);
    expect(fake.rules.get(id)).toHaveLength(8);
    const puts = fake.requests.filter((r) => r.method === "PUT");
    expect(puts).toHaveLength(1);
    expect(fake.requests.indexOf(puts[0]!)).toBe(fake.requests.length - 1);
    expect(await driver.ensureFirewall(defaultFirewall({ allowSsh: true }), {})).toBe(id);
  });

  it("replaces a group left pending by a crash, and deletes a group whose rules failed", async () => {
    const { fake, driver } = setup(target);
    const { pending } = vultrFirewallDescriptions("roundhouse-default");
    const stale = (await driver.client.createFirewallGroup(pending)).id;
    const id = await driver.ensureFirewall(defaultFirewall(), {});
    expect(fake.groups.has(stale)).toBe(false);
    expect(fake.groups.size).toBe(1);
    expect(id).not.toBe(stale);

    const { fake: f2, driver: d2 } = setup(target, { maxRetries: 0 });
    let n = 0;
    f2.intercept((r) =>
      r.path.endsWith("/rules") && n++ === 2 ? vultrError(500, "boom") : undefined,
    );
    await expect(d2.ensureFirewall(defaultFirewall(), {})).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(f2.groups.size).toBe(0);
  });
});

describe("instances", () => {
  it("creates with base64 user data, the firewall group, the key, and tags", async () => {
    const { fake, provider } = setup(target);
    const r = await provider.provision({ ...input, sshPublicKey: SSH_KEY });
    const body = fake.requests.find((q) => fake.isCreate(q))!.body as VultrCreateInstanceBody;
    expect(body).toMatchObject({
      region: "ewr",
      plan: "vc2-2c-4gb",
      os_id: 2284,
      label: "web-1",
      hostname: "web-1",
      enable_ipv6: true,
      firewall_group_id: r.firewallId,
      sshkey_id: [r.sshKeyId],
      backups: "disabled",
      activation_email: false,
    });
    expect(body.tags).toEqual([
      "roundhouse.managed=true",
      "roundhouse.node=web-1",
      "roundhouse.role=node",
    ]);
    expect(atob(body.user_data)).toContain(JOIN_TOKEN);
    expect(r.server).toMatchObject({
      ipv4: "192.0.2.123",
      ipv6: "2001:db8::123",
      status: "running",
    });
  });

  it("normalises the three status fields and drops default_password", () => {
    expect(vultrStatus({ status: "pending", power_status: "running" })).toBe("provisioning");
    expect(vultrStatus({ status: "active", power_status: "running" })).toBe("running");
    expect(vultrStatus({ status: "active", power_status: "stopped" })).toBe("stopped");
    expect(vultrStatus({ status: "suspended", power_status: "stopped" })).toBe("stopped");
    const s = fromVultrInstance(docCreatedInstance);
    expect(s).toMatchObject({ ipv4: null, ipv6: null, status: "provisioning" });
    expect(JSON.stringify(s)).not.toContain(docCreatedInstance.default_password!);
  });

  it("returns null for IDs that are not instance UUIDs", async () => {
    const { fake, provider } = setup(target);
    expect(await provider.getServer("123")).toBeNull();
    expect(fake.requests).toEqual([]);
  });
});
