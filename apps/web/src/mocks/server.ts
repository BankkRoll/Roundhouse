import { setupServer } from "msw/node";
import { handlers } from "./handlers";

/** MSW server for Vitest, preloaded with the contract handlers. */
export const server = setupServer(...handlers);
