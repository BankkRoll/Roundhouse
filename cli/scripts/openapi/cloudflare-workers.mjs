// Stand-ins for the classes the API extends; never instantiated by the dump.
export class DurableObject {}
export class WorkflowEntrypoint {}
export class WorkerEntrypoint {}

// Module-level bindings; empty, since the dump never handles a request.
export const env = {};
