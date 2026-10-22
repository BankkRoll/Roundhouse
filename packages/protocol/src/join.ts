/**
 * Schemas for the HTTP join handshake (`POST /v1/nodes/join`) a node performs
 * once, before it opens its WebSocket.
 *
 * @module
 */
import { z } from "zod";
import { CapabilitiesSchema, HardwareSchema, ShortText } from "./messages";

/** Raw 32-byte Ed25519 public key, standard base64 (44 chars, one pad). */
const Ed25519PublicKey = z
  .string()
  .regex(/^[A-Za-z0-9+/]{43}=$/, "expected a base64 Ed25519 public key");

/** Body of `POST /v1/nodes/join`. */
export const JoinRequestSchema = z.object({
  /** Single-use join token shown in the dashboard. */
  token: z.string().min(1).max(200),
  /** Display name; the agent defaults it to the hostname. */
  name: z.string().min(1).max(63),
  hostname: ShortText,
  agent_version: ShortText,
  os: ShortText,
  arch: z.enum(["amd64", "arm64"]),
  /** Agent's Ed25519 identity public key, base64 (raw 32 bytes). */
  public_key: Ed25519PublicKey,
  /** Self-reported; never trust it for routing or access control. */
  public_ip: z.union([z.ipv4(), z.ipv6()]).nullable(),
  hardware: HardwareSchema,
  capabilities: CapabilitiesSchema,
});

/** Body of `POST /v1/nodes/join`. */
export type JoinRequest = z.infer<typeof JoinRequestSchema>;

/** Response of `POST /v1/nodes/join`. */
export const JoinResponseSchema = z.object({
  node_id: z.string(),
  /** Long-lived bearer credential for the connect endpoint. Returned exactly once. */
  credential: z.string(),
  /** Control plane Ed25519 public key, base64 (raw 32 bytes). Pins message signatures. */
  control_public_key: z.string(),
  /** Absolute `wss://` URL to dial. */
  connect_url: z.string(),
});

/** Response of `POST /v1/nodes/join`. */
export type JoinResponse = z.infer<typeof JoinResponseSchema>;
