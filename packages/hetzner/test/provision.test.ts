import { describe, expect, it } from "vitest";
import { HetznerApiError, ProvisionError } from "../src/errors";
import {
  deprovisionServer,
  ipv6HostAddress,
  listManagedServers,
  type ProvisionInput,
  type ProvisionStep,
  provisionServer,
} from "../src/provision";
import type { CreateServerBody } from "../src/types";
import { apiError } from "./fake-hetzner";
import { JOIN_TOKEN, SSH_KEY, server } from "./fixtures";
import { harness } from "./helpers";

const input: ProvisionInput = {
  name: "web-1",
  serverType: "cx23",
  location: "fsn1",
  controlPlaneUrl: "https://cp.example.com",
  joinToken: JOIN_TOKEN,
};

const createBody = (fake: ReturnType<typeof harness>["fake"]) =>
  fake.requests.find((r) => r.method === "POST" && r.path === "/servers")?.body as CreateServerBody;

async function rejection(p: Promise<unknown>): Promise<ProvisionError> {
  const e = await p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ProvisionError);
  return e as ProvisionError;
}

describe("provisionServer", () => {
  it("creates a labelled server behind the default firewall and waits for it", async () => {
    const { fake, client } = harness();
    const steps: ProvisionStep[] = [];
    const result = await provisionServer(
      client,
      { ...input, workspaceId: "ws_123" },
      { onStep: (s) => steps.push(s) },
    );

    expect(steps).toEqual([
      "validate_token",
      "check_existing",
      "check_server_type",
      "ensure_firewall",
      "create_server",
      "wait_for_actions",
      "done",
    ]);
    const body = createBody(fake);
    expect(body).toMatchObject({
      name: "web-1",
      server_type: "cx23",
      location: "fsn1",
      image: "161547269",
      start_after_create: true,
      labels: {
        "roundhouse.managed": "true",
        "roundhouse.node": "web-1",
        "roundhouse.role": "node",
        "roundhouse.workspace": "ws_123",
      },
    });
    expect(body.ssh_keys).toBeUndefined();
    const fw = [...fake.firewalls.values()][0]!;
    expect(body.firewalls).toEqual([{ firewall: fw.id }]);
    expect(body.user_data).toContain("#cloud-config");
    expect(body.user_data).toContain(JOIN_TOKEN);

    expect(result).toMatchObject({
      name: "web-1",
      status: "running",
      location: "fsn1",
      serverType: "cx23",
      firewallId: fw.id,
      sshKeyId: null,
      created: true,
    });
    expect(result.ipv4).toMatch(/^203\.0\.113\./);
    expect(result.ipv6).toBe(ipv6HostAddress(result.ipv6Network!));
    expect(result.ipv6).toMatch(/::1$/);
    expect(JSON.stringify(result)).not.toContain("YItygq1v3GYjjMomLaKc");
  });

  it("picks the image for the server type's architecture", async () => {
    const { fake, client } = harness();
    await provisionServer(client, {
      ...input,
      serverType: "cax11",
      image: "debian-12",
      builder: true,
    });
    const body = createBody(fake);
    expect(body.image).toBe("114690389");
    expect(body.labels!["roundhouse.role"]).toBe("builder");
    expect(body.user_data).toContain("--builder");
  });

  it("uploads the SSH key once and opens port 22 only when asked", async () => {
    const { fake, client } = harness();
    const r1 = await provisionServer(client, { ...input, sshPublicKey: SSH_KEY, allowSsh: true });
    const r2 = await provisionServer(client, {
      ...input,
      name: "web-2",
      sshPublicKey: `  ${SSH_KEY.replace("ops@laptop", "other-comment")}\n`,
      allowSsh: true,
    });
    expect(fake.sshKeys.size).toBe(1);
    const key = [...fake.sshKeys.values()][0]!;
    expect(key.name).toMatch(/^roundhouse-[0-9a-f]{12}$/);
    expect(key.public_key).toBe(SSH_KEY);
    expect(r1.sshKeyId).toBe(key.id);
    expect(r2.sshKeyId).toBe(key.id);
    expect(createBody(fake).ssh_keys).toEqual([key.id]);
    const fw = fake.firewalls.get(r1.firewallId!)!;
    expect(fw.rules.map((r) => r.port)).toContain("22");
  });

  it("is idempotent by label: a retry returns the existing server", async () => {
    const { fake, client } = harness();
    const first = await provisionServer(client, input);
    const before = fake.requests.length;
    const again = await provisionServer(client, { ...input, joinToken: `${JOIN_TOKEN}x` });
    expect(again).toMatchObject({ serverId: first.serverId, created: false });
    expect(fake.servers.size).toBe(1);
    expect(
      fake.requests.slice(before).filter((r) => r.method === "POST" && r.path === "/servers"),
    ).toEqual([]);
  });

  it("refuses a name used by an unmanaged server, without touching it", async () => {
    const { fake, client } = harness();
    fake.addServer(server({ id: 5, name: "web-1", labels: { owner: "me" } }));
    const err = await rejection(provisionServer(client, input));
    expect(err.reason).toBe("name_taken");
    expect(err.serverId).toBe(5);
    expect(fake.mutations.filter((r) => r.path !== "/ssh_keys")).toEqual([]);
  });

  it("asks to retry while a previous server with the name is deleting", async () => {
    const { fake, client } = harness();
    fake.addServer(
      server({
        id: 5,
        name: "web-1",
        status: "deleting",
        labels: { "roundhouse.managed": "true", "roundhouse.node": "web-1" },
      }),
    );
    expect((await rejection(provisionServer(client, input))).reason).toBe("server_deleting");
  });

  it("stops before any change for an invalid or read-only token", async () => {
    for (const [token, reason] of [
      ["nope", "token_invalid"],
      ["ro-token", "token_read_only"],
    ] as const) {
      const { fake, client } = harness({ token });
      expect((await rejection(provisionServer(client, input))).reason).toBe(reason);
      expect(fake.servers.size + fake.firewalls.size + fake.sshKeys.size).toBe(0);
    }
  });

  it("validates input before calling the API", async () => {
    const { fake, client } = harness();
    const bad: Partial<ProvisionInput>[] = [
      { name: "Web_1" },
      { controlPlaneUrl: "http://cp.example.com" },
      { joinToken: "x" },
      { image: "fedora-42" as never },
      { labels: { "roundhouse.managed": "false" } },
      { labels: { "hetzner.cloud/x": "y" } },
      { workspaceId: "not valid!" },
      { sshPublicKey: "not a key" },
    ];
    for (const b of bad) {
      const err = await rejection(provisionServer(client, { ...input, ...b }));
      expect(err.reason, JSON.stringify(b)).toBe("invalid_input");
    }
    expect(fake.servers.size + fake.firewalls.size).toBe(0);
    expect(fake.requests.filter((r) => r.path === "/servers")).toEqual([]);
  });

  it("rejects a type that is unavailable, deprecated past removal, or not offered in the location", async () => {
    for (const [serverType, location] of [
      ["cx23", "hel1"],
      ["cx22", "nbg1"],
      ["cax11", "ash"],
      ["nope", "fsn1"],
    ]) {
      const { fake, client } = harness();
      const err = await rejection(
        provisionServer(client, { ...input, serverType: serverType!, location: location! }),
      );
      expect(err.reason).toBe("server_type_unavailable");
      expect(fake.servers.size).toBe(0);
    }
  });

  it("deletes the server when a creation action fails", async () => {
    const { fake, client } = harness();
    fake.failCommands.add("start_server");
    const err = await rejection(provisionServer(client, input));
    expect(err.reason).toBe("failed_cleaned_up");
    expect(err.serverId).not.toBeNull();
    expect(fake.servers.size).toBe(0);
    expect(
      fake.requests.some((r) => r.method === "DELETE" && r.path === `/servers/${err.serverId}`),
    ).toBe(true);
  });

  it("reports the server ID when cleanup also fails", async () => {
    const { fake, client } = harness({ maxRetries: 0 });
    fake.failCommands.add("create_server");
    fake.intercept((r) => (r.method === "DELETE" ? apiError(503, "unavailable") : undefined));
    const err = await rejection(provisionServer(client, input));
    expect(err.reason).toBe("failed_cleanup_failed");
    expect(fake.servers.has(err.serverId!)).toBe(true);
  });

  it("deletes the server when the caller aborts while waiting", async () => {
    const ctrl = new AbortController();
    const { fake, client } = harness({
      sleep: async (_ms, signal) => {
        ctrl.abort(new Error("cancelled"));
        signal?.throwIfAborted();
      },
    });
    const err = await rejection(provisionServer(client, input, { signal: ctrl.signal }));
    expect(err.reason).toBe("failed_cleaned_up");
    expect((err.cause as Error).message).toBe("cancelled");
    expect(fake.servers.size).toBe(0);
  });

  it("deletes the server when the caller aborts while the create request is in flight", async () => {
    const ctrl = new AbortController();
    const { fake, client } = harness();
    fake.intercept(async (r) => {
      if (r.method !== "POST" || r.path !== "/servers") return undefined;
      // Let the create land, then abort before the response is read.
      ctrl.abort(new Error("cancelled"));
      return undefined;
    });
    const err = await rejection(provisionServer(client, input, { signal: ctrl.signal }));
    expect(err.reason).toBe("failed_cleaned_up");
    expect(fake.servers.size).toBe(0);
    // The response was lost, so no action was ever polled.
    expect(fake.requests.some((r) => r.path === "/actions")).toBe(false);
  });

  it("finds a server whose create timed out at the gateway instead of duplicating it", async () => {
    const { fake, client } = harness();
    let swallowed = false;
    fake.intercept(async (r) => {
      if (r.method === "POST" && r.path === "/servers" && !swallowed) {
        swallowed = true;
        // Apply the create, then lose the response.
        await fake.fetch("https://api.hetzner.cloud/v1/servers", {
          method: "POST",
          headers: { authorization: "Bearer rw-token" },
          body: JSON.stringify(r.body),
        });
        return apiError(504, "timeout");
      }
      return undefined;
    });
    const result = await provisionServer(client, input);
    expect(result.created).toBe(true);
    expect(fake.servers.size).toBe(1);
    expect(result.serverId).toBe([...fake.servers.keys()][0]);
  });

  it("returns the winner when a concurrent provision creates the same node first", async () => {
    const { fake, client } = harness();
    fake.intercept((r) => {
      if (r.method === "POST" && r.path === "/servers" && fake.servers.size === 0) {
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
    const result = await provisionServer(client, input);
    expect(result).toMatchObject({ serverId: 77, created: false });
    expect(fake.servers.size).toBe(1);
  });

  it("surfaces API errors from the create call", async () => {
    const { fake, client } = harness();
    fake.intercept((r) =>
      r.method === "POST" && r.path === "/servers"
        ? apiError(403, "resource_limit_exceeded", "server limit")
        : undefined,
    );
    const err = await provisionServer(client, input).catch((e) => e);
    expect(err).toBeInstanceOf(HetznerApiError);
    expect(err.code).toBe("resource_limit_exceeded");
    expect(fake.servers.size).toBe(0);
  });
});

describe("deprovisionServer", () => {
  const managed = { "roundhouse.managed": "true", "roundhouse.node": "web-1" };

  it("deletes a managed server and waits for the action", async () => {
    const { fake, client } = harness();
    fake.addServer(server({ id: 5, name: "web-1", labels: managed }));
    expect(await deprovisionServer(client, { serverId: 5, expectedName: "web-1" })).toEqual({
      serverId: 5,
      deleted: true,
    });
    expect(fake.servers.size).toBe(0);
    expect(fake.requests.some((r) => r.path === "/actions")).toBe(true);
  });

  it("never deletes a server without the managed label", async () => {
    const variants: Record<string, string>[] = [
      {},
      { "roundhouse.managed": "false" },
      { "roundhouse.node": "web-1" },
    ];
    for (const labels of variants) {
      const { fake, client } = harness();
      fake.addServer(server({ id: 5, name: "web-1", labels }));
      const err = await rejection(deprovisionServer(client, { serverId: 5 }));
      expect(err.reason).toBe("not_managed");
      expect(fake.mutations).toEqual([]);
      expect(fake.servers.has(5)).toBe(true);
    }
  });

  it("refuses a managed server belonging to another node", async () => {
    const { fake, client } = harness();
    fake.addServer(server({ id: 5, name: "web-1", labels: managed }));
    const err = await rejection(deprovisionServer(client, { serverId: 5, expectedName: "web-2" }));
    expect(err.reason).toBe("not_managed");
    expect(fake.mutations).toEqual([]);
  });

  it("is idempotent for servers that are already gone", async () => {
    const { client } = harness();
    expect(await deprovisionServer(client, { serverId: 404 })).toEqual({
      serverId: 404,
      deleted: false,
    });
  });

  it("can skip waiting", async () => {
    const { fake, client } = harness();
    fake.addServer(server({ id: 5, name: "web-1", labels: managed }));
    await deprovisionServer(client, { serverId: 5, wait: false });
    expect(fake.requests.some((r) => r.path === "/actions")).toBe(false);
  });
});

describe("listManagedServers", () => {
  it("filters by the managed label and workspace", async () => {
    const { fake, client } = harness();
    fake.addServer(
      server({
        id: 1,
        name: "a",
        labels: { "roundhouse.managed": "true", "roundhouse.workspace": "ws_1" },
      }),
    );
    fake.addServer(
      server({
        id: 2,
        name: "b",
        labels: { "roundhouse.managed": "true", "roundhouse.workspace": "ws_2" },
      }),
    );
    fake.addServer(server({ id: 3, name: "c", labels: {} }));
    expect((await listManagedServers(client)).map((s) => s.id)).toEqual([1, 2]);
    expect((await listManagedServers(client, { workspaceId: "ws_2" })).map((s) => s.id)).toEqual([
      2,
    ]);
  });
});

describe("ipv6HostAddress", () => {
  it("returns the first host of the /64", () => {
    expect(ipv6HostAddress("2001:db8::/64")).toBe("2001:db8::1");
    expect(ipv6HostAddress("2a01:4f8:c17:1234::/64")).toBe("2a01:4f8:c17:1234::1");
  });
});
