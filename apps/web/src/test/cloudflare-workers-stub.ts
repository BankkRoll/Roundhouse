/**
 * Stand-in for the `cloudflare:workers` runtime module, so the contract test can import
 * the API's route modules (and read their OpenAPI registries) under Node. Only class
 * identities are needed: nothing here is ever constructed by the test.
 *
 * @module
 */

/** Base class of Durable Objects. */
export class DurableObject {}

/** Base class of Workflows. */
export class WorkflowEntrypoint {}
