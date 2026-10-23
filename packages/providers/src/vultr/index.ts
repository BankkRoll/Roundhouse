/**
 * Vultr adapter.
 *
 * - {@link VultrClient}: typed API v2 client on the shared HTTP core.
 * - {@link VultrDriver}: the shared driver primitives.
 * - {@link createVultrProvider}: the shared {@link Provider}.
 *
 * @module
 */
import type { Provider } from "../provider";
import { providerFromDriver } from "../provision";
import type { VultrClientOptions } from "./client";
import { VultrDriver } from "./driver";

export * from "./client";
export * from "./driver";
export * from "./mapping";
export type * as VultrTypes from "./types";

/**
 * Creates the shared provider interface for Vultr.
 *
 * @param options - API key and transport tuning.
 * @returns The provider.
 * @example
 * const vultr = createVultrProvider({ token: apiKey });
 */
export function createVultrProvider(options: VultrClientOptions): Provider {
  return providerFromDriver(new VultrDriver(options));
}
