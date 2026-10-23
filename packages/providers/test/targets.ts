/**
 * The four adapters wired to their fakes, for the conformance suite and the
 * per-adapter tests.
 *
 * @module
 */
import { DigitalOceanDriver } from "../src/digitalocean";
import { HetznerDriver } from "../src/hetzner";
import type { TransportOptions } from "../src/http";
import { LinodeDriver } from "../src/linode";
import type { ProviderDriver, ProviderId } from "../src/provider";
import { providerFromDriver } from "../src/provision";
import { VultrDriver } from "../src/vultr";
import type { FakeApi } from "./fakes/base";
import { FakeDigitalOcean } from "./fakes/digitalocean";
import { FakeHetzner } from "./fakes/hetzner";
import { FakeLinode } from "./fakes/linode";
import { FakeVultr } from "./fakes/vultr";
import { virtualClock } from "./helpers";

/** Client options a test may override. */
export type Overrides = Partial<TransportOptions> & { token?: string };

/** An adapter and how to exercise it. */
export interface Target<F extends FakeApi = FakeApi, D extends ProviderDriver = ProviderDriver> {
  id: ProviderId;
  /** A fresh fake. */
  fake: () => F;
  /** A driver talking to `fake`. */
  driver: (fake: F, options: TransportOptions & { token: string }) => D;
  /** A plan and region that can be ordered for a node. */
  plan: string;
  region: string;
  /** Reads the plain user data out of a recorded create body. */
  userData: (body: Record<string, unknown>) => string;
}

/** Hetzner target. */
export const hetzner: Target<FakeHetzner, HetznerDriver> = {
  id: "hetzner",
  fake: () => new FakeHetzner(),
  driver: (fake, o) => new HetznerDriver({ ...o, fetch: fake.fetch }),
  plan: "cx23",
  region: "fsn1",
  userData: (b) => String(b.user_data),
};

/** DigitalOcean target. */
export const digitalocean: Target<FakeDigitalOcean, DigitalOceanDriver> = {
  id: "digitalocean",
  fake: () => new FakeDigitalOcean(),
  driver: (fake, o) => new DigitalOceanDriver({ ...o, fetch: fake.fetch }),
  plan: "s-2vcpu-4gb",
  region: "nyc3",
  userData: (b) => String(b.user_data),
};

/** Vultr target. */
export const vultr: Target<FakeVultr, VultrDriver> = {
  id: "vultr",
  fake: () => new FakeVultr(),
  driver: (fake, o) => new VultrDriver({ ...o, fetch: fake.fetch }),
  plan: "vc2-2c-4gb",
  region: "ewr",
  userData: (b) => atob(String(b.user_data)),
};

/** Linode target. */
export const linode: Target<FakeLinode, LinodeDriver> = {
  id: "linode",
  fake: () => new FakeLinode(),
  driver: (fake, o) => new LinodeDriver({ ...o, fetch: fake.fetch }),
  plan: "g6-standard-2",
  region: "us-east",
  userData: (b) => atob(String((b.metadata as { user_data: string }).user_data)),
};

/** Every target, for `describe.each`. */
export const TARGETS: Target[] = [hetzner, digitalocean, vultr, linode] as unknown as Target[];

/**
 * Wires a target to a fresh fake and a virtual clock.
 *
 * @param target - The adapter.
 * @param overrides - Client options; `token` defaults to the read/write token.
 * @param fake - An existing fake to reuse.
 * @returns The fake, driver, provider, and clock.
 */
export function setup<F extends FakeApi, D extends ProviderDriver>(
  target: Target<F, D>,
  overrides: Overrides & { onSleep?: (ms: number) => void } = {},
  fake: F = target.fake(),
) {
  const { onSleep, ...rest } = overrides;
  const clock = virtualClock(onSleep);
  const driver = target.driver(fake, { token: "rw-token", ...clock.transport, ...rest });
  return { fake, driver, provider: providerFromDriver(driver), clock };
}
