// Stand-ins for the classes the API extends; never instantiated by the dump.
export class DurableObject {}
export class WorkflowEntrypoint {}
export class WorkerEntrypoint {}
// The worker's bindings; empty because the dump never handles a request.
export const env = {};
