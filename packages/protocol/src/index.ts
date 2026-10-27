/**
 * Wire protocol between the control plane and node agents.
 *
 * - `versions` — protocol versions and per-feature gates.
 * - `messages` — zod schemas for every frame. These are the source of truth;
 *   the JSON Schemas in `/schema` and the Go types in `/go` must match them,
 *   which the shared fixtures in `/fixtures` enforce from both sides.
 * - `workload` — the workload spec, ingress, registry and volume settings
 *   carried by `desired_state`.
 * - `data`, `mesh`, `jobs`, `metrics`, `certs`, `signing-keys` — the frames
 *   of each Phase 2–3 feature (ADR 0015); `exec` and `image-push` — Phase 4's
 *   web shell and image copy (ADRs 0011, 0012); `pitr` — WAL archiving
 *   and point-in-time restores (ADR 0004, protocol 8).
 * - `spec-hash` — canonical JSON and the spec hash the agent diffs on.
 * - `limits` — size limits and string formats, mirrored in Go.
 * - `signing` — Ed25519 envelopes that authenticate control → agent frames.
 * - `join` — the HTTP handshake a node performs before opening its socket.
 * - `box` — X25519 sealed boxes carrying every secret to one node.
 *
 * See {@link PROTOCOL_VERSION} for when to bump the version; the control
 * plane must keep accepting {@link MIN_PROTOCOL_VERSION}.
 *
 * @module
 */
export * from "./box";
export * from "./certs";
export * from "./control";
export * from "./data";
export * from "./exec";
export * from "./image-push";
export * from "./jobs";
export * from "./join";
export * from "./limits";
export * from "./mesh";
export * from "./messages";
export * from "./metrics";
export * from "./pitr";
export * from "./signing";
export * from "./signing-keys";
export * from "./spec-hash";
export * from "./versions";
export * from "./workload";
