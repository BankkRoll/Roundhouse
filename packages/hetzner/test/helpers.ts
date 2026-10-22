/**
 * Builds a client wired to a fake API with a virtual clock: `sleep` resolves
 * at once, advances the clock, and records the delay.
 *
 * @module
 */
import { HetznerClient, type HetznerClientOptions } from "../src/client";
import { FakeHetzner } from "./fake-hetzner";

/** A client, its fake API, and the recorded sleeps. */
export interface Harness {
  fake: FakeHetzner;
  client: HetznerClient;
  sleeps: number[];
  clock: { now: number };
}

/**
 * @param options - Client overrides; `token` defaults to the read/write token.
 * @param fake - Existing fake to reuse.
 * @returns The harness.
 */
export function harness(
  options: Partial<HetznerClientOptions> = {},
  fake = new FakeHetzner(),
): Harness {
  const sleeps: number[] = [];
  const clock = { now: 1_700_000_000_000 };
  const client = new HetznerClient({
    token: "rw-token",
    fetch: fake.fetch,
    random: () => 0.5,
    now: () => clock.now,
    sleep: async (ms, signal) => {
      signal?.throwIfAborted();
      sleeps.push(ms);
      clock.now += ms;
    },
    ...options,
  });
  return { fake, client, sleeps, clock };
}
