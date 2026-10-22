// Package protocol is the Go mirror of the OpenRail control-plane ↔ node-agent
// wire protocol defined by the zod schemas in packages/protocol/src.
//
// The TypeScript schemas are the source of truth. The shared JSON fixtures in
// packages/protocol/fixtures are decoded by both test suites, so a field added,
// renamed or removed on one side without the other fails CI.
//
// The package provides:
//   - structs for every agent → control frame ([Hello], [Heartbeat],
//     [WorkloadStatus], [Logs], [BuildResult]) and the HTTP join handshake
//     ([JoinRequest], [JoinResponse]);
//   - the signed control → agent [Envelope] and its payloads ([Welcome],
//     [DesiredState], [BuildJob]), decoded through the sealed
//     [ControlMessage] interface;
//   - [WorkloadSpec] and [ComputeSpecHash], whose result matches the
//     TypeScript computeSpecHash byte for byte;
//   - [VerifyEnvelope], which authenticates and validates control frames
//     exactly as the TypeScript verifyEnvelope does;
//   - the size limits shared with limits.ts ([MaxLogLineBytes] and friends).
//
// Decoding is strict in the same ways on both sides: required fields must be
// present at every nesting level, keys that differ from a field only by case
// are rejected, and agent → control frames reject unknown fields. Control
// frames ignore unknown fields so the control plane can add optional ones.
package protocol
