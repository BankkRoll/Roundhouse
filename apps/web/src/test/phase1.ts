/**
 * Paths and helpers for Phase 1 page tests (projects, services, logs, variables).
 *
 * @module
 */
import { act } from "@testing-library/react";
import type { RealtimeServerMessage } from "../lib/api/deploy-types";
import { WORKSPACE_ID } from "../mocks/db";
import { SEED } from "../mocks/deploy-db";
import { broadcastRealtime, realtimeSubscriptions } from "../mocks/deploy-handlers";

/** The seeded storefront project's page. */
export const PROJECT_PATH = `/w/${WORKSPACE_ID}/p/${SEED.project}`;

/**
 * A page of a seeded service.
 *
 * @param serviceId - Service id, e.g. `SEED.web`.
 * @param tab - Tab path, e.g. `logs`.
 * @returns The URL.
 */
export function servicePath(serviceId: string, tab = "deployments"): string {
  return `${PROJECT_PATH}/s/${serviceId}/${tab}`;
}

/**
 * Pushes a message down the seeded project's mock realtime socket.
 *
 * @param message - Server message.
 */
export function pushRealtime(message: RealtimeServerMessage): void {
  act(() => broadcastRealtime(SEED.project, message));
}

/**
 * Log topics the open project's socket has subscribed to.
 *
 * @returns Topic keys.
 */
export function subscriptions(): string[] {
  return realtimeSubscriptions(SEED.project);
}

export { SEED };
