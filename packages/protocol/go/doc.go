// Package protocol is the Go mirror of the OpenRail control-plane ↔ node-agent
// wire protocol defined by the zod schemas in packages/protocol/src.
//
// The TypeScript schemas are the source of truth. The shared JSON fixtures in
// packages/protocol/fixtures are decoded by both test suites, so a field added,
// renamed or removed on one side without the other fails CI.
//
// The package provides:
//   - structs for every agent → control frame ([Hello], [Heartbeat]) and the
//     HTTP join handshake ([JoinRequest], [JoinResponse]);
//   - the signed control → agent [Envelope] and its payloads ([Welcome],
//     [DesiredState]), decoded through the sealed [ControlMessage] interface;
//   - [VerifyEnvelope], which authenticates and validates control frames
//     exactly as the TypeScript verifyEnvelope does.
package protocol
