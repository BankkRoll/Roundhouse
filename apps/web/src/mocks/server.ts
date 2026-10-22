import { setupServer } from "msw/node";
import { deployWebSocketHandlers } from "./deploy-handlers";
import { handlers } from "./handlers";

/** MSW server for Vitest, preloaded with the contract handlers and the realtime socket. */
export const server = setupServer(...handlers, ...deployWebSocketHandlers);
