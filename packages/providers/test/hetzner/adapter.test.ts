import { describe, expect, it } from "vitest";
import { defaultFirewall, defaultFirewallRules } from "../../src/firewall";
import {
  buildHetznerOffers,
  filterHetznerImages,
  ipv6HostAddress,
  toHetznerRules,
} from "../../src/hetzner";
import type { CreateServerBody } from "../../src/hetzner/types";
import { filterOffers } from "../../src/provision";
import { hetznerError } from "../fakes/hetzner";
import { IMAGES, image, LOCATIONS, SERVER_TYPES, server } from "../fixtures/hetzner";
import { JOIN_TOKEN, rejection, SSH_KEY } from "../helpers";
import { setup, hetzner as target } from "../targets";

const NOW = Date.parse("2026-10-22T00:00:00Z");
const EUR = { currency: "EUR" };
const input = {
  name: "web-1",
  plan: "cx23",
  region: "fsn1",
  controlPlaneUrl: "https://cp.example.com",
  joinToken: JOIN_TOKEN,
};

describe("offers", () => {
  const offers = filterOffers(buildHetznerOffers(SERVER_TYPES, LOCATIONS, EUR, NOW));
  const keys = offers.map((o) => o.id);

  it("joins types with per-location prices, sorted by gross monthly price", () => {
    expect(keys).toEqual([
      "cx11@fsn1",
      "cx23@fsn1",
      "cx23@nbg1",
      "cax11@fsn1",
      "cx33@fsn1",
      "cx33@nbg1",
      "cpx22@fsn1",
      "cpx22@ash",
      "ccx13@fsn1",
      "ccx13@ash",
    ]);
  });

  it("normalises fields, architecture, memory, and gross prices", () => {
    const cx23 = offers.find((o) => o.id === "cx23@nbg1")!;
    expect(cx23).toMatchObject({
      provider: "hetzner",
      plan: "cx23",
      region: "nbg1",
      regionName: "Nuremberg",
      country: "DE",
      vcpus: 2,
      memoryMib: 4096,
      diskGb: 40,
      arch: "amd64",
      dedicated: false,
      category: "Shared vCPU",
      price: { monthlyCents: 415, currency: "EUR" },
      includedTrafficTb: 20,
      recommended: true,
      deprecated: false,
      unavailableAfter: null,
    });
    expect(offers.find((o) => o.plan === "cax11")!.arch).toBe("arm64");
    expect(offers.find((o) => o.plan === "ccx13")!.dedicated).toBe(true);
    expect(offers.find((o) => o.id === "cx11@fsn1")!.price.monthlyCents).toBe(101);
  });

  it("excludes temporarily unavailable, unpriced, and unknown locations", () => {
    expect(keys).not.toContain("cx23@hel1");
    expect(keys).not.toContain("cpx22@nbg1");
    expect(keys.some((k) => k.startsWith("cx43@"))).toBe(false);
  });

  it("flags deprecated types, and drops ones past unavailable_after", () => {
    const all = buildHetznerOffers(SERVER_TYPES, LOCATIONS, EUR, NOW);
    const cx22 = all.filter((o) => o.plan === "cx22");
    expect(cx22.map((o) => o.region)).toEqual(["fsn1"]);
    expect(cx22[0]).toMatchObject({ deprecated: true, unavailableAfter: "2099-01-01T00:00:00Z" });
    expect(keys.some((k) => k.startsWith("cx22@"))).toBe(false);
  });

  it("honours the legacy type-level deprecated flag", () => {
    const legacy = structuredClone(SERVER_TYPES.filter((t) => t.name === "cx33"));
    legacy[0]!.deprecated = true;
    expect(buildHetznerOffers(legacy, LOCATIONS, EUR, NOW).every((o) => o.deprecated)).toBe(true);
  });

  it("reads types, locations, and the currency live from the API", async () => {
    const { fake, provider } = setup(target);
    fake.serverTypes = fake.serverTypes.filter((t) => t.name === "cx23");
    fake.serverTypes[0]!.prices[0]!.price_monthly.gross = "5.0000";
    const live = await provider.listOffers({ now: NOW });
    expect(live.find((o) => o.region === "fsn1")!.price.monthlyCents).toBe(500);
    expect(new Set(fake.requests.map((r) => r.path))).toEqual(
      new Set(["/server_types", "/locations", "/pricing"]),
    );
  });
});

describe("images", () => {
  it("keeps Ubuntu 22.04/24.04 and Debian 12 for both architectures", () => {
    expect(filterHetznerImages(IMAGES, NOW).map((i) => `${i.name}/${i.arch}`)).toEqual([
      "ubuntu-24.04/amd64",
      "ubuntu-24.04/arm64",
      "ubuntu-22.04/amd64",
      "ubuntu-22.04/arm64",
      "debian-12/amd64",
      "debian-12/arm64",
    ]);
  });

  it("flags deprecated images and drops ones past unavailable_after or unavailable", () => {
    const imgs = filterHetznerImages(
      [
        image(1, "ubuntu-22.04", "x86", {
          deprecation: {
            announced: "2026-01-01T00:00:00Z",
            unavailable_after: "2099-01-01T00:00:00Z",
          },
        }),
        image(2, "ubuntu-22.04", "arm", {
          deprecation: {
            announced: "2025-01-01T00:00:00Z",
            unavailable_after: "2026-01-01T00:00:00Z",
          },
        }),
        image(3, "debian-12", "x86", { status: "unavailable" }),
      ],
      NOW,
    );
    expect(imgs).toEqual([
      {
        id: "1",
        name: "ubuntu-22.04",
        arch: "amd64",
        description: "ubuntu-22.04",
        deprecated: true,
        regions: null,
      },
    ]);
  });

  it("queries system images by architecture", async () => {
    const { fake, provider } = setup(target);
    const imgs = await provider.listImages({ arch: "arm64" });
    expect(imgs.every((i) => i.arch === "arm64")).toBe(true);
    expect(fake.requests[0]!.query.get("architecture")).toBe("arm");
    expect(fake.requests[0]!.query.get("type")).toBe("system");
  });
});

describe("firewall", () => {
  it("maps the neutral rules to inbound-only Hetzner rules", () => {
    expect(toHetznerRules(defaultFirewallRules())).toEqual([
      {
        direction: "in",
        protocol: "tcp",
        port: "80",
        source_ips: ["0.0.0.0/0", "::/0"],
        description: "HTTP ingress and ACME",
      },
      {
        direction: "in",
        protocol: "tcp",
        port: "443",
        source_ips: ["0.0.0.0/0", "::/0"],
        description: "HTTPS ingress",
      },
      {
        direction: "in",
        protocol: "udp",
        port: "443",
        source_ips: ["0.0.0.0/0", "::/0"],
        description: "HTTP/3 ingress",
      },
    ]);
  });

  it("creates the managed firewall once, labelled, and reuses it", async () => {
    const { fake, driver } = setup(target);
    const a = await driver.ensureFirewall(defaultFirewall(), {});
    const b = await driver.ensureFirewall(defaultFirewall(), {});
    expect(a).toBe(b);
    const fw = fake.firewalls.get(Number(a))!;
    expect(fw.name).toBe("roundhouse-default");
    expect(fw.labels).toEqual({ "roundhouse.managed": "true", "roundhouse.firewall": "default" });
  });

  it("recovers from a concurrent create, and refuses an unmanaged firewall with the name", async () => {
    const { fake, driver } = setup(target);
    let raced = false;
    fake.intercept((r) => {
      if (r.method === "POST" && r.path === "/firewalls" && !raced) {
        raced = true;
        const labels = { "roundhouse.managed": "true", "roundhouse.firewall": "default" };
        fake.firewalls.set(1, {
          id: 1,
          name: "roundhouse-default",
          labels,
          created: "",
          rules: [],
          applied_to: [],
        });
        return hetznerError(409, "uniqueness_error", "name is already used");
      }
      return undefined;
    });
    expect(await driver.ensureFirewall(defaultFirewall(), {})).toBe("1");

    const { fake: f2, driver: d2 } = setup(target);
    f2.firewalls.set(9, {
      id: 9,
      name: "roundhouse-default",
      labels: {},
      created: "",
      rules: [],
      applied_to: [],
    });
    expect((await rejection(d2.ensureFirewall(defaultFirewall(), {}))).reason).toBe("name_taken");
  });
});

describe("provision specifics", () => {
  const createBody = (fake: ReturnType<typeof setup>["fake"]) =>
    fake.requests.find((r) => fake.isCreate(r))?.body as CreateServerBody;

  it("sends labels, firewall, key, and image by ID, and drops the root password", async () => {
    const { fake, provider } = setup(target);
    const r = await provider.provision({ ...input, workspaceId: "ws_123", sshPublicKey: SSH_KEY });
    const body = createBody(fake);
    expect(body).toMatchObject({
      name: "web-1",
      server_type: "cx23",
      location: "fsn1",
      image: "161547269",
      start_after_create: true,
      firewalls: [{ firewall: Number(r.firewallId) }],
      ssh_keys: [Number(r.sshKeyId)],
      public_net: { enable_ipv4: true, enable_ipv6: true },
      labels: {
        "roundhouse.managed": "true",
        "roundhouse.node": "web-1",
        "roundhouse.role": "node",
        "roundhouse.workspace": "ws_123",
      },
    });
    expect(r.server.ipv6).toMatch(/::1$/);
    expect([...fake.sshKeys.values()][0]!.name).toMatch(/^roundhouse-[0-9a-f]{12}$/);
  });

  it("picks the arm image for an arm server type", async () => {
    const { fake, provider } = setup(target);
    await provider.provision({ ...input, plan: "cax11", image: "debian-12", builder: true });
    const body = createBody(fake);
    expect(body.image).toBe("114690389");
    expect(body.labels!["roundhouse.role"]).toBe("builder");
    expect(body.user_data).toContain("--builder");
  });

  it("rejects types that are sold out, deprecated past removal, or not offered there", async () => {
    for (const [plan, region] of [
      ["cx23", "hel1"],
      ["cx22", "nbg1"],
      ["cax11", "ash"],
    ]) {
      const { provider } = setup(target);
      const err = await rejection(provider.provision({ ...input, plan: plan!, region: region! }));
      expect(err.reason).toBe("offer_unavailable");
    }
  });

  it("asks to retry while a managed server with the name is deleting", async () => {
    const { fake, provider } = setup(target);
    fake.seedServer({
      name: "web-1",
      labels: { "roundhouse.managed": "true", "roundhouse.node": "web-1" },
      status: "deleting",
    });
    expect((await rejection(provider.provision(input))).reason).toBe("server_deleting");
  });

  it("returns the winner when a concurrent provision creates the node first", async () => {
    const { fake, provider } = setup(target);
    fake.intercept((r) => {
      if (fake.isCreate(r) && fake.servers.size === 0) {
        fake.addServer(
          server({
            id: 77,
            name: "web-1",
            labels: { "roundhouse.managed": "true", "roundhouse.node": "web-1" },
          }),
        );
      }
      return undefined;
    });
    expect(await provider.provision(input)).toMatchObject({ created: false, server: { id: "77" } });
  });

  it("rejects label values Hetzner cannot store", async () => {
    const { driver } = setup(target);
    expect(() => driver.validateLabels({ "roundhouse.workspace": "a:b" })).toThrow();
  });

  it("computes the IPv6 host address Hetzner configures", () => {
    expect(ipv6HostAddress("2001:db8::/64")).toBe("2001:db8::1");
    expect(ipv6HostAddress("2a01:4f8:c17:1234::/64")).toBe("2a01:4f8:c17:1234::1");
  });
});
