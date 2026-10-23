/**
 * The same behavioural contract, run against every adapter through its fake.
 * A new adapter is done when it passes this file unchanged.
 */
import { describe, expect, it } from "vitest";
import { SUPPORTED_IMAGES } from "../src/catalog";
import { TOKEN_PATH } from "../src/cloud-init";
import { ProviderActionError, ProviderApiError } from "../src/errors";
import type { ProvisionInput, ProvisionStep } from "../src/provider";
import { JOIN_TOKEN, rejection, SSH_KEY } from "./helpers";
import { setup, TARGETS } from "./targets";

const managed = (node: string, extra: Record<string, string> = {}) => ({
  "roundhouse.managed": "true",
  "roundhouse.node": node,
  "roundhouse.role": "node",
  ...extra,
});

describe.each(TARGETS)("$id conformance", (target) => {
  const input: ProvisionInput = {
    name: "web-1",
    plan: target.plan,
    region: target.region,
    controlPlaneUrl: "https://cp.example.com",
    joinToken: JOIN_TOKEN,
  };
  const creates = (fake: ReturnType<typeof setup>["fake"]) =>
    fake.requests.filter((r) => fake.isCreate(r));

  describe("validateToken", () => {
    it("rejects an unknown token", async () => {
      const { provider } = setup(target, { token: "nope" });
      expect(await provider.validateToken()).toMatchObject({ valid: false, canWrite: false });
    });

    it("reports a read-only token", async () => {
      const { provider } = setup(target, { token: "ro-token" });
      expect(await provider.validateToken()).toMatchObject({ valid: true, canWrite: false });
    });

    it("accepts a read/write token without creating anything", async () => {
      const { fake, provider } = setup(target);
      expect(await provider.validateToken()).toMatchObject({ valid: true, canWrite: true });
      expect(fake.serverIds()).toEqual([]);
      expect(fake.firewallCount() + fake.sshKeyCount()).toBe(0);
    });
  });

  describe("catalogue", () => {
    it("lists normalised offers, cheapest first, above the installer floor", async () => {
      const { provider } = setup(target);
      const offers = await provider.listOffers();
      expect(offers.length).toBeGreaterThan(0);
      for (const o of offers) {
        expect(o.provider).toBe(target.id);
        expect(o.id).toBe(`${o.plan}@${o.region}`);
        expect(Number.isInteger(o.price.monthlyCents) && o.price.monthlyCents > 0).toBe(true);
        expect(o.price.currency).toMatch(/^[A-Z]{3}$/);
        expect(o.memoryMib).toBeGreaterThanOrEqual(1024);
        expect(o.diskGb).toBeGreaterThanOrEqual(10);
        expect(["amd64", "arm64"]).toContain(o.arch);
        expect(o.deprecated).toBe(false);
      }
      const prices = offers.map((o) => o.price.monthlyCents);
      expect(prices).toEqual([...prices].sort((a, b) => a - b));
      expect(offers.some((o) => o.plan === target.plan && o.region === target.region)).toBe(true);
    });

    it("applies the builder floor and the region filter", async () => {
      const { provider } = setup(target);
      const builders = await provider.listOffers({ role: "builder" });
      expect(builders.every((o) => o.diskGb >= 20)).toBe(true);
      const here = await provider.listOffers({ region: target.region });
      expect(here.length).toBeGreaterThan(0);
      expect(here.every((o) => o.region === target.region)).toBe(true);
    });

    it("lists exactly the supported images for amd64", async () => {
      const { provider } = setup(target);
      const images = await provider.listImages({ arch: "amd64" });
      expect(new Set(images.map((i) => i.name))).toEqual(new Set(SUPPORTED_IMAGES));
      expect(images.every((i) => i.arch === "amd64")).toBe(true);
      const arm = await provider.listImages({ arch: "arm64" });
      expect(arm.every((i) => i.arch === "arm64")).toBe(true);
    });
  });

  describe("provision", () => {
    it("creates a labelled server behind the firewall and waits until it runs", async () => {
      const { fake, provider } = setup(target);
      const steps: ProvisionStep[] = [];
      const result = await provider.provision(
        { ...input, workspaceId: "ws_123" },
        { onStep: (s) => steps.push(s) },
      );
      expect(steps).toEqual([
        "validate_token",
        "check_existing",
        "check_offer",
        "ensure_firewall",
        "create_server",
        "wait_until_running",
        "done",
      ]);
      expect(result.created).toBe(true);
      expect(result.firewallId).not.toBeNull();
      expect(result.server).toMatchObject({
        provider: target.id,
        name: "web-1",
        status: "running",
        region: target.region,
        plan: target.plan,
        managed: { node: "web-1", role: "node", workspaceId: "ws_123" },
      });
      expect(result.server.ipv4).not.toBeNull();
      expect(fake.serverIds()).toEqual([result.server.id]);
      expect(fake.firewallCount()).toBe(1);

      const [create] = creates(fake);
      const userData = target.userData(create!.body as Record<string, unknown>);
      expect(userData.startsWith("#cloud-config\n")).toBe(true);
      expect(userData).toContain(TOKEN_PATH);
      expect(userData).toContain(JOIN_TOKEN);
    });

    it("never returns a root password", async () => {
      const { fake, provider } = setup(target);
      const json = JSON.stringify(await provider.provision(input));
      for (const secret of fake.secrets) expect(json).not.toContain(secret);
    });

    it("is idempotent by label: a retry returns the existing server", async () => {
      const { fake, provider } = setup(target);
      const first = await provider.provision(input);
      const again = await provider.provision({ ...input, joinToken: `${JOIN_TOKEN}x` });
      expect(again).toMatchObject({ created: false, server: { id: first.server.id } });
      expect(creates(fake)).toHaveLength(1);
      expect(fake.serverIds()).toHaveLength(1);
    });

    it("refuses a name an unmanaged server uses, without touching it", async () => {
      const { fake, provider } = setup(target);
      const id = fake.seedServer({ name: "web-1", labels: { owner: "me" } });
      const err = await rejection(provider.provision(input));
      expect(err.reason).toBe("name_taken");
      expect(err.serverId).toBe(id);
      expect(creates(fake)).toEqual([]);
      expect(fake.serverIds()).toEqual([id]);
    });

    it("stops before any change for an invalid or read-only token", async () => {
      for (const [token, reason] of [
        ["nope", "token_invalid"],
        ["ro-token", "token_read_only"],
      ] as const) {
        const { fake, provider } = setup(target, { token });
        expect((await rejection(provider.provision(input))).reason).toBe(reason);
        expect(fake.serverIds()).toEqual([]);
        expect(fake.firewallCount() + fake.sshKeyCount()).toBe(0);
      }
    });

    it("validates input before calling the API", async () => {
      const { fake, provider } = setup(target);
      const bad: Partial<ProvisionInput>[] = [
        { name: "Web_1" },
        { controlPlaneUrl: "http://cp.example.com" },
        { joinToken: "x" },
        { image: "fedora-42" as never },
        { workspaceId: "not valid!" },
        { sshPublicKey: "not a key" },
      ];
      for (const b of bad) {
        const err = await rejection(provider.provision({ ...input, ...b }));
        expect(err.reason, JSON.stringify(b)).toBe("invalid_input");
      }
      expect(fake.requests).toEqual([]);
    });

    it("rejects a plan that cannot be ordered in the region", async () => {
      const { fake, provider } = setup(target);
      for (const [plan, region] of [
        ["no-such-plan", target.region],
        [target.plan, "no-such-region"],
      ]) {
        const err = await rejection(provider.provision({ ...input, plan: plan!, region: region! }));
        expect(err.reason).toBe("offer_unavailable");
      }
      expect(creates(fake)).toEqual([]);
    });

    it("shares one firewall per SSH variant", async () => {
      const { fake, provider } = setup(target);
      const a = await provider.provision(input);
      const b = await provider.provision({ ...input, name: "web-2" });
      expect(a.firewallId).toBe(b.firewallId);
      expect(fake.firewallCount()).toBe(1);
      const c = await provider.provision({ ...input, name: "web-3", allowSsh: true });
      expect(c.firewallId).not.toBe(a.firewallId);
      expect(fake.firewallCount()).toBe(2);
    });

    it("installs the SSH key once, reusing it across servers", async () => {
      const { fake, provider } = setup(target);
      const a = await provider.provision({ ...input, sshPublicKey: SSH_KEY });
      const b = await provider.provision({
        ...input,
        name: "web-2",
        sshPublicKey: `  ${SSH_KEY.replace("ops@laptop", "other")}\n`,
      });
      expect(a.sshKeyId).toBe(b.sshKeyId);
      expect(fake.sshKeyCount()).toBeLessThanOrEqual(1);
      const body = JSON.stringify(creates(fake)[0]!.body);
      expect(a.sshKeyId === null ? body.includes(SSH_KEY.split(" ")[1]!) : true).toBe(true);
    });

    it("deletes the server when it never comes up", async () => {
      const { fake, provider } = setup(target);
      fake.neverBoot = true;
      const err = await rejection(provider.provision(input, { readyTimeoutMs: 30_000 }));
      expect(err.reason).toBe("failed_cleaned_up");
      expect(err.cause).toBeInstanceOf(ProviderActionError);
      expect(err.serverId).not.toBeNull();
      expect(fake.serverIds()).toEqual([]);
      expect(fake.requests.some((r) => fake.isDelete(r))).toBe(true);
    });

    it("reports the server ID when cleanup also fails", async () => {
      const { fake, provider } = setup(target, { maxRetries: 0 });
      fake.neverBoot = true;
      fake.intercept((r) => (fake.isDelete(r) ? fake.errorResponse(503, "down") : undefined));
      const err = await rejection(provider.provision(input, { readyTimeoutMs: 30_000 }));
      expect(err.reason).toBe("failed_cleanup_failed");
      expect(fake.serverIds()).toEqual([err.serverId]);
    });

    it("deletes the server when the caller aborts while waiting", async () => {
      const ctrl = new AbortController();
      const { fake, provider } = setup(target, {
        onSleep: () => ctrl.abort(new Error("cancelled")),
      });
      const err = await rejection(provider.provision(input, { signal: ctrl.signal }));
      expect(err.reason).toBe("failed_cleaned_up");
      expect((err.cause as Error).message).toBe("cancelled");
      expect(fake.serverIds()).toEqual([]);
    });

    it("deletes the server when the caller aborts while the create is in flight", async () => {
      const ctrl = new AbortController();
      const { fake, provider } = setup(target);
      fake.intercept((r) => {
        if (fake.isCreate(r)) ctrl.abort(new Error("cancelled"));
        return undefined;
      });
      const err = await rejection(provider.provision(input, { signal: ctrl.signal }));
      expect(err.reason).toBe("failed_cleaned_up");
      expect(fake.serverIds()).toEqual([]);
    });

    it("recovers a create whose response was lost instead of duplicating it", async () => {
      const { fake, provider } = setup(target);
      let lost = false;
      fake.intercept(async (r) => {
        if (!fake.isCreate(r) || lost) return undefined;
        lost = true;
        await fake.passthrough(r);
        return fake.errorResponse(504, "gateway timeout");
      });
      const result = await provider.provision(input);
      expect(result.created).toBe(true);
      expect(result.server.status).toBe("running");
      expect(creates(fake)).toHaveLength(1);
      expect(fake.serverIds()).toEqual([result.server.id]);
    });

    it("surfaces an ambiguous create failure when nothing was created", async () => {
      const { fake, provider } = setup(target);
      fake.intercept((r) => (fake.isCreate(r) ? fake.errorResponse(503, "down") : undefined));
      const err = await provider.provision(input).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderApiError);
      expect(err.code).toBe("unavailable");
      expect(creates(fake)).toHaveLength(1);
      expect(fake.serverIds()).toEqual([]);
    });
  });

  describe("deprovision", () => {
    it("deletes a managed server and waits until it is gone", async () => {
      const { fake, provider } = setup(target);
      const id = fake.seedServer({ name: "web-1", labels: managed("web-1") });
      expect(await provider.deprovision({ serverId: id, expectedName: "web-1" })).toEqual({
        serverId: id,
        deleted: true,
      });
      expect(fake.serverIds()).toEqual([]);
    });

    it("never deletes a server without the managed marker", async () => {
      const variants: Record<string, string>[] = [
        {},
        { "roundhouse.managed": "false" },
        { "roundhouse.node": "web-1" },
      ];
      for (const labels of variants) {
        const { fake, provider } = setup(target);
        const id = fake.seedServer({ name: "web-1", labels });
        const err = await rejection(provider.deprovision({ serverId: id }));
        expect(err.reason).toBe("not_managed");
        expect(fake.mutations).toEqual([]);
        expect(fake.serverIds()).toEqual([id]);
      }
    });

    it("refuses a managed server that belongs to another node", async () => {
      const { fake, provider } = setup(target);
      const id = fake.seedServer({ name: "web-1", labels: managed("web-1") });
      const err = await rejection(provider.deprovision({ serverId: id, expectedName: "web-2" }));
      expect(err.reason).toBe("not_managed");
      expect(fake.mutations).toEqual([]);
    });

    it("is idempotent for servers that are already gone", async () => {
      const { fake, provider } = setup(target);
      const id = fake.seedServer({ name: "web-1", labels: managed("web-1") });
      await provider.deprovision({ serverId: id });
      expect(await provider.deprovision({ serverId: id })).toEqual({
        serverId: id,
        deleted: false,
      });
      expect(await provider.deprovision({ serverId: "not-an-id" })).toEqual({
        serverId: "not-an-id",
        deleted: false,
      });
    });
  });

  describe("reads", () => {
    it("lists managed servers, optionally for one workspace", async () => {
      const { fake, provider } = setup(target);
      const a = fake.seedServer({
        name: "a-1",
        labels: managed("a-1", { "roundhouse.workspace": "ws_1" }),
      });
      const b = fake.seedServer({
        name: "b-1",
        labels: managed("b-1", { "roundhouse.workspace": "ws_2" }),
      });
      fake.seedServer({ name: "c-1", labels: {} });
      expect((await provider.listManaged()).map((s) => s.id).sort()).toEqual([a, b].sort());
      expect((await provider.listManaged({ workspaceId: "ws_2" })).map((s) => s.id)).toEqual([b]);
    });

    it("reads one server, managed or not, and returns null when it is missing", async () => {
      const { fake, provider } = setup(target);
      const id = fake.seedServer({ name: "mine", labels: {} });
      expect(await provider.getServer(id)).toMatchObject({ id, name: "mine", managed: null });
      expect(await provider.getServer("999999")).toBeNull();
    });

    it("maps a rejected token to the normalised unauthorized code", async () => {
      const { provider } = setup(target, { token: "nope" });
      const err = await provider.listManaged().catch((e) => e);
      expect(err).toBeInstanceOf(ProviderApiError);
      expect(err.code).toBe("unauthorized");
      expect(err.provider).toBe(target.id);
    });

    it("retries a rate-limited listing with backoff", async () => {
      const { fake, provider, clock } = setup(target);
      let n = 0;
      fake.intercept((r) =>
        r.method === "GET" && n++ === 0 ? fake.errorResponse(429, "slow down") : undefined,
      );
      expect((await provider.listOffers()).length).toBeGreaterThan(0);
      expect(clock.sleeps.length).toBeGreaterThanOrEqual(1);
      expect(clock.sleeps[0]).toBeGreaterThan(0);
    });
  });
});
