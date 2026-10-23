/**
 * Hetzner Cloud adapter.
 *
 * - {@link HetznerClient}: typed API client on the shared HTTP core.
 * - {@link HetznerDriver}: the shared driver primitives.
 * - {@link createHetznerProvider}: the shared {@link Provider} for Hetzner.
 *
 * @module
 */
import type { Provider } from "../provider";
import { providerFromDriver } from "../provision";
import type { HetznerClientOptions } from "./client";
import { HetznerDriver } from "./driver";

export * from "./client";
export * from "./driver";
export * from "./mapping";
export type * as HetznerTypes from "./types";

/**
 * Creates the shared provider interface for Hetzner Cloud.
 *
 * @param options - Token and transport tuning.
 * @returns The provider.
 * @example
 * const hetzner = createHetznerProvider({ token });
 * const offers = await hetzner.listOffers({ role: "node" });
 */
export function createHetznerProvider(options: HetznerClientOptions): Provider {
  return providerFromDriver(new HetznerDriver(options));
}
