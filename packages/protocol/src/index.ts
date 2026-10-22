/**
 * Wire protocol between the control plane and node agents.
 *
 * - `messages` — zod schemas for every frame. These are the source of truth;
 *   the JSON Schemas in `/schema` and the Go types in `/go` must match them,
 *   which the shared fixtures in `/fixtures` enforce from both sides.
 * - `workload` — the workload spec, ingress and registry settings carried by
 *   `desired_state`.
 * - `spec-hash` — canonical JSON and the spec hash the agent diffs on.
 * - `limits` — size limits and string formats, mirrored in Go.
 * - `signing` — Ed25519 envelopes that authenticate control → agent frames.
 * - `join` — the HTTP handshake a node performs before opening its socket.
 *
 * See {@link PROTOCOL_VERSION} for when to bump the version; the control
 * plane must keep accepting {@link MIN_PROTOCOL_VERSION}.
 *
 * @module
 */
export * from "./join";
export * from "./limits";
export * from "./messages";
export * from "./signing";
export * from "./spec-hash";
export * from "./workload";
