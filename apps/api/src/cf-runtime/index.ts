/**
 * The runtime Worker as the control plane uploads it (ADR 0011), plus the
 * shared contract in `./warm.ts`.
 *
 * `runtime.worker.js` is bundled as text (the `**\/*.worker.js` rule in
 * `wrangler.jsonc`), never executed by the control plane.
 *
 * @module
 */

/** Source of the runtime Worker's main module, to upload as {@link RUNTIME_MAIN_MODULE}. */
export { default as RUNTIME_WORKER_SOURCE } from "./runtime.worker.js";
export * from "./warm";
