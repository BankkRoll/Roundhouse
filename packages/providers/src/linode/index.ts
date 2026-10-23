/**
 * Linode (Akamai Cloud) adapter.
 *
 * - {@link LinodeClient}: typed API v4 client on the shared HTTP core.
 * - {@link LinodeDriver}: the shared driver primitives.
 * - {@link createLinodeProvider}: the shared {@link Provider}.
 *
 * @module
 */
import type { Provider } from "../provider";
import { providerFromDriver } from "../provision";
import type { LinodeClientOptions } from "./client";
import { LinodeDriver } from "./driver";

export * from "./client";
export * from "./driver";
export * from "./mapping";
export type * as LinodeTypes from "./types";

/**
 * Creates the shared provider interface for Linode.
 *
 * @param options - Token and transport tuning.
 * @returns The provider.
 * @example
 * const linode = createLinodeProvider({ token });
 */
export function createLinodeProvider(options: LinodeClientOptions): Provider {
  return providerFromDriver(new LinodeDriver(options));
}
