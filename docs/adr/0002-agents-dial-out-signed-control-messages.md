# 2. Agents dial out; control messages are signed envelopes

- Status: Accepted
- Date: 2026-10-22

## Context

Each Roundhouse install has one control plane (a Cloudflare Worker with Durable
Objects) and any number of Linux nodes running `roundhouse-agent`. The control
plane must push desired state to nodes with low latency, and nodes must report
heartbeats and facts back.

Constraints:
- Nodes are often behind NAT or firewalls, and operators should not have to open
  an inbound management port on every server.
- A Worker cannot hold long-lived outbound connections to arbitrary hosts, but a
  Durable Object can accept and hold a WebSocket.
- A control message can start arbitrary containers on a node, so its
  authenticity matters more than anything else on the wire. TLS protects the
  connection, but we want message authenticity that does not depend solely on
  TLS termination at Cloudflare or on the integrity of the WebSocket hop.
- The control plane is TypeScript and the agent is Go. Any scheme that requires
  both to produce identical canonical JSON is a source of subtle bugs.

## Decision

### Transport

Agents dial out to the control plane over WSS. Each node's socket terminates in
its own Durable Object (one per node), which is the only place that sends to
that node. Nodes expose no inbound control port.

### Join

1. An admin creates a **join token** in the dashboard. It is single-use and
   expires after 15 minutes.
2. The agent calls `POST /v1/nodes/join` with the token, its facts, and its own
   Ed25519 identity public key.
3. The control plane consumes the token and returns the `node_id`, a **node
   credential**, the control plane's Ed25519 public key, and the `connect_url`.
4. The node credential is a random bearer secret returned exactly once. The
   control plane stores only a hash of it. The agent stores it in a 0600 file,
   separate from its config.

The agent pins the control plane public key received at join.

### Control to agent messages

Every control-to-agent frame is a signed envelope:

```json
{ "v": 1, "kid": "<key id>", "payload": "<JSON string>", "sig": "<base64 Ed25519 signature>" }
```

- `payload` is the control message serialized as a JSON **string**. The
  signature covers the exact UTF-8 bytes of that string.
- The agent verifies `sig` over the bytes it received, using the pinned control
  plane key, and only then parses `payload`. No canonicalization is needed on
  either side.
- The payload carries `node_id`, `iat`, and `exp`. The agent rejects messages
  addressed to another node or past `exp`. Desired-state messages carry a
  monotonically increasing `generation`, and the agent ignores generations
  older than the last one it applied, which also defeats replay of stale state.
- `kid` identifies the signing key so the control plane can rotate it. Phase 0
  agents pin a single key.

Agent-to-control frames are authenticated by the connection: the agent presents
its node credential when opening the WebSocket.

### Shared definitions

The zod schemas in `packages/protocol` are the source of truth. A signed fixture
generated in TypeScript is verified by the Go tests, so both sides prove they
agree on the scheme byte-for-byte.

## Consequences

- Nodes work behind NAT without port forwarding, and the attack surface on a
  node does not include a listening management API.
- Connection state lives in one Durable Object per node, which serializes sends
  and gives a natural place for presence and heartbeat tracking.
- A party who can inject frames into the WebSocket (for example, through a
  compromised edge or a bug in connection routing) still cannot forge control
  messages without the signing key.
- Signing the raw payload string costs a second JSON encoding per message,
  which is negligible at expected message rates.
- A leaked node credential lets an attacker impersonate that node to the control
  plane, but not send it commands. Credentials are revocable per node, and
  storing only hashes means a database leak does not expose them.
- A leaked control plane signing key is critical. Key rotation via `kid` must be
  implemented before 1.0, and the key must be stored encrypted at rest.
- Protocol changes must stay compatible with agents one minor version behind;
  changes to the envelope or signing scheme require a new ADR.
