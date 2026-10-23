/**
 * Shared test helpers: constants, a virtual clock, and assertion helpers.
 *
 * @module
 */
import { expect } from "vitest";
import { ProvisionError } from "../src/errors";
import type { SleepFn } from "../src/http";

/** A syntactically valid ed25519 public key. */
export const SSH_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb1zQm3n0xS7rL0y0u4Xc9mJ5r2fP8kq1W6dV3tYh7a ops@laptop";

/** A join token in the control plane's format (`njt_` + 43 base64url chars). */
export const JOIN_TOKEN = "njt_Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5";

/** Start of the virtual clock: 2026-10-22T00:00:00Z, the date the fixtures were taken. */
export const T0 = Date.parse("2026-10-22T00:00:00Z");

/** A clock whose `sleep` resolves at once, advances time, and records the delay. */
export interface VirtualClock {
  /** Current virtual unix ms. */
  now: number;
  /** Every delay slept, in order. */
  sleeps: number[];
  /** Transport options to spread into a client. */
  transport: { sleep: SleepFn; now: () => number; random: () => number };
}

/**
 * Builds a virtual clock.
 *
 * @param onSleep - Called before each sleep, e.g. to abort mid-wait.
 * @returns The clock.
 */
export function virtualClock(onSleep?: (ms: number) => void): VirtualClock {
  const clock: VirtualClock = {
    now: T0,
    sleeps: [],
    transport: {
      sleep: async (ms, signal) => {
        onSleep?.(ms);
        signal?.throwIfAborted();
        clock.sleeps.push(ms);
        clock.now += ms;
      },
      now: () => clock.now,
      random: () => 0.5,
    },
  };
  return clock;
}

/**
 * Awaits a promise that must reject with a {@link ProvisionError}.
 *
 * @param p - The promise.
 * @returns The error.
 */
export async function rejection(p: Promise<unknown>): Promise<ProvisionError> {
  const e = await p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ProvisionError);
  return e as ProvisionError;
}
