import { describe, expect, it } from "vitest";
import {
  buildDigitalOceanOffers,
  DIGITALOCEAN_TAGS,
  filterDigitalOceanImages,
  fromDroplet,
  parseDigitalOceanError,
  toDigitalOceanRules,
} from "../../src/digitalocean";
import type { DoCreateDropletBody } from "../../src/digitalocean/types";
import { defaultFirewall, defaultFirewallRules } from "../../src/firewall";
import { filterOffers } from "../../src/provision";
import { doError } from "../fakes/digitalocean";
import { docDroplet, droplet, errors, IMAGES, REGIONS, SIZES } from "../fixtures/digitalocean";
import { JOIN_TOKEN, rejection, SSH_KEY } from "../helpers";
import { setup, digitalocean as target } from "../targets";

const input = {
  name: "web-1",
  plan: "s-2vcpu-4gb",
  region: "nyc3",
  controlPlaneUrl: "https://cp.example.com",
  joinToken: JOIN_TOKEN,
};

describe("client", () => {
  it("paginates with page/per_page=200 following links.pages.next", async () => {
    const { fake, driver } = setup(target);
    for (let i = 0; i < 450; i++)
      fake.seedServer({
        name: `d${i}`,
        labels: { "roundhouse.managed": "true", "roundhouse.node": `d${i}` },
      });
    const all = await driver.client.listDroplets({ tag: "roundhouse:managed:true" });
    expect(all).toHaveLength(450);
    const pages = fake.requests.map((r) => [r.query.get("page"), r.query.get("per_page")]);
    expect(pages).toEqual([
      ["1", "200"],
      ["2", "200"],
      ["3", "200"],
    ]);
  });

  it("tracks ratelimit-* headers and honours retry-after on the burst limit", async () => {
    const { fake, driver, clock } = setup(target);
    let n = 0;
    fake.intercept(() =>
      n++ === 0
        ? new Response(JSON.stringify(errors.too_many_requests), {
            status: 429,
            headers: { "retry-after": "29" },
          })
        : undefined,
    );
    await driver.client.listRegions();
    expect(clock.sleeps).toEqual([29_000]);
    expect(driver.client.http.rateLimit).toMatchObject({
      limit: 5000,
      resetAt: fake.rateLimit.reset * 1000,
    });
  });

  it("maps documented error bodies to normalised codes", () => {
    const cases: [number, unknown, string][] = [
      [400, errors.bad_request, "invalid_input"],
      [401, errors.unauthorized, "unauthorized"],
      [403, errors.forbidden, "forbidden"],
      [404, errors.not_found, "not_found"],
      [409, errors.conflict, "conflict"],
      [422, errors.unprocessable_entity, "invalid_input"],
      [429, errors.too_many_requests, "rate_limited"],
      [500, errors.server_error, "unavailable"],
    ];
    for (const [status, body, code] of cases) {
      const e = parseDigitalOceanError(status, JSON.stringify(body));
      expect(e).toMatchObject({
        provider: "digitalocean",
        status,
        code,
        providerCode: (body as { id: string }).id,
      });
    }
  });

  it("reads the {error, root_causes} shape and refines 422s by message", () => {
    const tag = parseDigitalOceanError(400, JSON.stringify(errors.tags_bad_request));
    expect(tag).toMatchObject({ code: "invalid_input", providerCode: "http_400" });
    expect(tag.message).toContain("invalid characters");
    const limit =
      '{"id":"unprocessable_entity","message":"creating this/these droplet(s) will exceed your droplet limit"}';
    expect(parseDigitalOceanError(422, limit).code).toBe("quota_exceeded");
    const dup =
      '{"id":"unprocessable_entity","message":"SSH Key is already in use on your account"}';
    expect(parseDigitalOceanError(422, dup).code).toBe("conflict");
  });

  it("refuses to delete without a positive droplet ID, and never deletes by tag", async () => {
    const { fake, driver } = setup(target);
    await expect(driver.client.deleteDroplet(0)).rejects.toThrow(RangeError);
    await expect(driver.client.deleteDroplet(Number.NaN)).rejects.toThrow(RangeError);
    const result = await setup(target, {}, fake).provider.provision(input);
    await setup(target, {}, fake).provider.deprovision({ serverId: result.server.id });
    expect(fake.requests.some((r) => r.method === "DELETE" && r.path === "/droplets")).toBe(false);
  });
});

describe("validateToken", () => {
  it("returns the account and probes each write scope without creating anything", async () => {
    const { fake, provider } = setup(target);
    expect(await provider.validateToken()).toEqual({
      valid: true,
      canWrite: true,
      account: {
        id: "b6fr89dbf6d9156cace5f3c78dc9851d957381ef",
        email: "sammy@digitalocean.com",
        name: "My Team",
      },
    });
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /account",
      "POST /droplets",
      "POST /firewalls",
      "POST /tags",
    ]);
    expect(fake.droplets.size + fake.firewalls.size + fake.tags.size).toBe(0);
  });

  it("names the scopes a custom-scoped token lacks", async () => {
    const { fake, provider } = setup(target);
    fake.intercept((r) =>
      (r.method === "POST" && r.path === "/firewalls") || r.path === "/account"
        ? json403()
        : undefined,
    );
    expect(await provider.validateToken()).toEqual({
      valid: true,
      canWrite: false,
      missing: ["firewall:create"],
    });
  });
});

const json403 = () => new Response(JSON.stringify(errors.forbidden), { status: 403 });

describe("offers and images", () => {
  const offers = filterOffers(buildDigitalOceanOffers(SIZES, REGIONS));

  it("joins available sizes with available regions, in USD", () => {
    expect(offers.map((o) => o.id)).toEqual([
      "s-1vcpu-1gb@fra1",
      "s-1vcpu-1gb@nyc3",
      "s-2vcpu-4gb@fra1",
      "s-2vcpu-4gb@nyc3",
      "g-2vcpu-8gb@nyc3",
    ]);
    expect(offers.find((o) => o.id === "s-2vcpu-4gb@nyc3")).toMatchObject({
      vcpus: 2,
      memoryMib: 4096,
      diskGb: 80,
      arch: "amd64",
      dedicated: false,
      category: "Basic",
      regionName: "New York 3",
      price: { monthlyCents: 2400, currency: "USD" },
      includedTrafficTb: 4,
    });
    expect(offers.find((o) => o.plan === "g-2vcpu-8gb")!.dedicated).toBe(true);
  });

  it("drops GPU, unavailable, and below-floor sizes and unavailable regions", () => {
    const all = buildDigitalOceanOffers(SIZES, REGIONS).map((o) => o.id);
    expect(all).not.toContain("s-2vcpu-4gb@sgp1");
    expect(all.some((id) => id.startsWith("gpu-") || id.startsWith("s-4vcpu-8gb"))).toBe(false);
    expect(offers.some((o) => o.plan === "s-1vcpu-512mb-10gb")).toBe(false);
  });

  it("keeps only the supported distribution slugs, with their regions", () => {
    const images = filterDigitalOceanImages(IMAGES);
    expect(images.map((i) => [i.id, i.name])).toEqual([
      ["ubuntu-24-04-x64", "ubuntu-24.04"],
      ["ubuntu-22-04-x64", "ubuntu-22.04"],
      ["debian-12-x64", "debian-12"],
    ]);
    expect(images.find((i) => i.name === "debian-12")!.regions).toEqual(["nyc3"]);
  });

  it("refuses an image that is not offered in the region", async () => {
    const { provider } = setup(target);
    const err = await rejection(
      provider.provision({ ...input, region: "fra1", image: "debian-12" }),
    );
    expect(err.reason).toBe("image_unavailable");
    expect(await provider.listImages({ arch: "arm64" })).toEqual([]);
  });
});

describe("tags, firewall, and create", () => {
  it("encodes labels as colon tags DigitalOcean accepts", () => {
    expect(DIGITALOCEAN_TAGS.tag("roundhouse.managed", "true")).toBe("roundhouse:managed:true");
    const { driver } = setup(target);
    expect(() => driver.validateLabels({ "roundhouse.workspace": "ws.1" })).toThrow();
    expect(() => driver.validateLabels({ "roundhouse.workspace": "ws_01HABC" })).not.toThrow();
  });

  it("adds allow-all outbound rules, since cloud firewalls deny unlisted egress", () => {
    const rules = toDigitalOceanRules(defaultFirewallRules({ allowSsh: true }));
    expect(rules.inbound_rules.map((r) => `${r.protocol}/${r.ports}`)).toEqual([
      "tcp/22",
      "tcp/80",
      "tcp/443",
      "udp/443",
    ]);
    expect(rules.inbound_rules[0]!.sources).toEqual({ addresses: ["0.0.0.0/0", "::/0"] });
    expect(rules.outbound_rules).toEqual(
      ["tcp", "udp", "icmp"].map((protocol) => ({
        protocol,
        ports: "0",
        destinations: { addresses: ["0.0.0.0/0", "::/0"] },
      })),
    );
  });

  it("creates the target tag before the firewall, and tags the droplet with it", async () => {
    const { fake, provider } = setup(target);
    const r = await provider.provision({ ...input, sshPublicKey: SSH_KEY, workspaceId: "ws_1" });
    const named = (path: string, key: string, value: string) =>
      fake.requests.findIndex(
        (q) =>
          q.method === "POST" &&
          q.path === path &&
          (q.body as Record<string, unknown>)[key] === value,
      );
    expect(named("/tags", "name", "roundhouse:firewall:default")).toBeGreaterThan(-1);
    expect(named("/tags", "name", "roundhouse:firewall:default")).toBeLessThan(
      named("/firewalls", "name", "roundhouse-default"),
    );
    const fw = fake.firewalls.get(r.firewallId!)!;
    expect(fw).toMatchObject({ name: "roundhouse-default", tags: ["roundhouse:firewall:default"] });
    const body = fake.requests.find((q) => fake.isCreate(q))!.body as DoCreateDropletBody;
    expect(body).toMatchObject({
      name: "web-1",
      region: "nyc3",
      size: "s-2vcpu-4gb",
      image: "ubuntu-24-04-x64",
      ipv6: true,
      ssh_keys: [Number(r.sshKeyId)],
    });
    expect(body.tags).toEqual([
      "roundhouse:managed:true",
      "roundhouse:node:web-1",
      "roundhouse:role:node",
      "roundhouse:workspace:ws_1",
      "roundhouse:firewall:default",
    ]);
    expect(body.user_data).toContain("#cloud-config");
  });

  it("refuses a user's firewall that has the managed name but not the managed tag", async () => {
    const { fake, driver } = setup(target);
    fake.firewalls.set("x", {
      id: "x",
      name: "roundhouse-default",
      status: "succeeded",
      inbound_rules: [],
      outbound_rules: [],
      created_at: "",
      droplet_ids: [],
      tags: ["web"],
    });
    expect((await rejection(driver.ensureFirewall(defaultFirewall(), {}))).reason).toBe(
      "name_taken",
    );
  });

  it("reuses a key with the same material and recovers from a duplicate upload", async () => {
    const { fake, driver } = setup(target);
    fake.intercept((r) => {
      if (r.method === "POST" && r.path === "/account/keys") {
        fake.sshKeys.set(9, { id: 9, name: "laptop", public_key: SSH_KEY, fingerprint: "" });
        return doError(422, "unprocessable_entity", "SSH Key is already in use on your account");
      }
      return undefined;
    });
    expect(await driver.ensureSshKey(SSH_KEY.split(" ").slice(0, 2).join(" "), {})).toBe("9");
  });
});

describe("droplet mapping", () => {
  it("reads public addresses, ignores the private one and the 'nil' gateway", () => {
    const s = fromDroplet(
      droplet({ id: 1, name: "a", tags: ["web", "roundhouse:managed:true", "roundhouse:node:a"] }),
    );
    expect(s).toMatchObject({
      id: "1",
      ipv4: "192.241.165.154",
      ipv6: "2604:a880:0:1010::18a:a001",
      status: "running",
      managed: { node: "a", role: "node", workspaceId: null },
    });
  });

  it("maps a new droplet without networks", () => {
    expect(fromDroplet(docDroplet)).toMatchObject({
      status: "provisioning",
      ipv4: null,
      ipv6: null,
      managed: null,
    });
    expect(fromDroplet({ ...docDroplet, status: "off" }).status).toBe("stopped");
  });
});
