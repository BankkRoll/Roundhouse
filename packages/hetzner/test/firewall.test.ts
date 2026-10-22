import { describe, expect, it } from "vitest";
import { ProvisionError } from "../src/errors";
import { defaultFirewallRules, ensureFirewall } from "../src/firewall";
import { harness } from "./helpers";

const ANY = ["0.0.0.0/0", "::/0"];

describe("defaultFirewallRules", () => {
  it("allows only 80/tcp, 443/tcp, and 443/udp inbound", () => {
    const rules = defaultFirewallRules();
    expect(rules.map((r) => [r.direction, r.protocol, r.port, r.source_ips])).toEqual([
      ["in", "tcp", "80", ANY],
      ["in", "tcp", "443", ANY],
      ["in", "udp", "443", ANY],
    ]);
  });

  it("adds 22/tcp only when SSH is allowed", () => {
    const rules = defaultFirewallRules({ allowSsh: true });
    expect(rules.map((r) => `${r.protocol}/${r.port}`)).toEqual([
      "tcp/22",
      "tcp/80",
      "tcp/443",
      "udp/443",
    ]);
    expect(defaultFirewallRules({ allowSsh: false }).some((r) => r.port === "22")).toBe(false);
  });

  it("has no outbound rules, so agents can dial out", () => {
    for (const allowSsh of [true, false]) {
      expect(defaultFirewallRules({ allowSsh }).every((r) => r.direction === "in")).toBe(true);
    }
  });
});

describe("ensureFirewall", () => {
  it("creates the managed firewall once and reuses it", async () => {
    const { fake, client } = harness();
    const a = await ensureFirewall(client);
    const b = await ensureFirewall(client);
    expect(a.id).toBe(b.id);
    expect(fake.firewalls.size).toBe(1);
    expect(a.name).toBe("roundhouse-default");
    expect(a.labels).toEqual({ "roundhouse.managed": "true", "roundhouse.firewall": "default" });
    expect(a.rules).toEqual(defaultFirewallRules());
  });

  it("keeps the SSH and no-SSH variants separate", async () => {
    const { fake, client } = harness();
    const plain = await ensureFirewall(client, { allowSsh: false });
    const ssh = await ensureFirewall(client, { allowSsh: true });
    expect(plain.id).not.toBe(ssh.id);
    expect(ssh.name).toBe("roundhouse-default-ssh");
    expect(fake.firewalls.size).toBe(2);
  });

  it("recovers from a concurrent create", async () => {
    const { fake, client } = harness();
    let raced = false;
    fake.intercept((r) => {
      if (r.method === "POST" && r.path === "/firewalls" && !raced) {
        raced = true;
        fake.firewalls.set(1, {
          id: 1,
          name: "roundhouse-default",
          labels: { "roundhouse.managed": "true", "roundhouse.firewall": "default" },
          created: "",
          rules: [],
          applied_to: [],
        });
        return new Response(
          JSON.stringify({ error: { code: "uniqueness_error", message: "name is already used" } }),
          {
            status: 409,
          },
        );
      }
      return undefined;
    });
    // The label lookup ran before the racer's create landed.
    const fw = await ensureFirewall(client);
    expect(fw.id).toBe(1);
  });

  it("refuses to adopt an unmanaged firewall with the same name", async () => {
    const { fake, client } = harness();
    fake.firewalls.set(9, {
      id: 9,
      name: "roundhouse-default",
      labels: {},
      created: "",
      rules: [],
      applied_to: [],
    });
    const err = await ensureFirewall(client).catch((e) => e);
    expect(err).toBeInstanceOf(ProvisionError);
    expect(err.reason).toBe("name_taken");
  });
});
