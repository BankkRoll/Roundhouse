import { setupServer } from "msw/node";
import { deployWebSocketHandlers } from "./deploy-handlers";
import { handlers } from "./handlers";
import { shellWebSocketHandlers } from "./shell-handlers";

/** MSW server for Vitest, preloaded with the contract handlers and the sockets. */
export const server = setupServer(
  ...handlers,
  ...deployWebSocketHandlers,
  ...shellWebSocketHandlers,
);
