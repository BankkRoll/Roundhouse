/**
 * DigitalOcean adapter.
 *
 * - {@link DigitalOceanClient}: typed API v2 client on the shared HTTP core.
 * - {@link DigitalOceanDriver}: the shared driver primitives.
 * - {@link createDigitalOceanProvider}: the shared {@link Provider}.
 *
 * @module
 */
import type { Provider } from "../provider";
import { providerFromDriver } from "../provision";
import type { DigitalOceanClientOptions } from "./client";
import { DigitalOceanDriver } from "./driver";

export * from "./client";
export * from "./driver";
export * from "./mapping";
export type * as DigitalOceanTypes from "./types";

/**
 * Creates the shared provider interface for DigitalOcean.
 *
 * @param options - Token and transport tuning.
 * @returns The provider.
 * @example
 * const digitalocean = createDigitalOceanProvider({ token });
 */
export function createDigitalOceanProvider(options: DigitalOceanClientOptions): Provider {
  return providerFromDriver(new DigitalOceanDriver(options));
}
