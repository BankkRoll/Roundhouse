/**
 * Wire protocol between the control plane and node agents.
 *
 * - `messages` — zod schemas for every frame. These are the source of truth;
 *   the JSON Schemas in `/schema` and the Go types in `/go` must match them,
 *   which the shared fixtures in `/fixtures` enforce from both sides.
 * - `signing` — Ed25519 envelopes that authenticate control → agent frames.
 * - `join` — the HTTP handshake a node performs before opening its socket.
 *
 * Bump {@link PROTOCOL_VERSION} on any breaking change; the control plane
 * must keep accepting N-1.
 *
 * @module
 */
export * from "./join";
export * from "./messages";
export * from "./signing";
