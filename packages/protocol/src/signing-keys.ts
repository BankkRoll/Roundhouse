/**
 * Control-plane signing-key rollover (ADR 0014 §13), from
 * `KEY_ROLLOVER_PROTOCOL_VERSION`: successor keys announced inside
 * `welcome.next_keys` and in `key_announce`, both signed by the current key.
 * Mirrored by `go/signingkeys.go`.
 *
 * A compromised key is not rolled over (an attacker could announce their own
 * successor); that takes a re-join. Rollover only moves trust forward from a
 * key the agent already pins.
 *
 * @module
 */
import { z } from "zod";
import { ControlHeader } from "./control";
import { MAX_NEXT_SIGNING_KEYS, SIGNING_KEY_ID_RE } from "./limits";

/** A successor Ed25519 signing key the agent pins next to the current one. */
export const SigningKeyAnnouncementSchema = z.object({
  /** The `Envelope.kid` frames signed by this key will carry. */
  kid: z.string().regex(SIGNING_KEY_ID_RE, "expected a signing key id"),
  /** Raw 32-byte Ed25519 public key, standard base64. */
  public_key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "expected a base64 32-byte key"),
  /** Unix seconds from which the control plane signs with this key. */
  not_before: z.number().int().positive(),
});

/** A successor signing key. */
export type SigningKeyAnnouncement = z.infer<typeof SigningKeyAnnouncementSchema>;

/**
 * Successor keys as sent: at most {@link MAX_NEXT_SIGNING_KEYS}, distinct
 * kids. That none is the envelope's own signing kid is checked by
 * {@link announcesSigningKid}, since the payload can't see its envelope.
 */
export const SigningKeyAnnouncementsSchema = z
  .array(SigningKeyAnnouncementSchema)
  .max(MAX_NEXT_SIGNING_KEYS)
  .refine((keys) => new Set(keys.map((k) => k.kid)).size === keys.length, {
    message: "duplicate kid",
  });

/**
 * Announces successor signing keys to a connected agent, so it need not
 * reconnect to see `welcome.next_keys`. Not credential-bearing.
 */
export const KeyAnnounceSchema = z.object({
  type: z.literal("key_announce"),
  ...ControlHeader,
  keys: SigningKeyAnnouncementsSchema.min(1),
});

/** Announces successor signing keys. */
export type KeyAnnounce = z.infer<typeof KeyAnnounceSchema>;

/**
 * Whether a payload announces the very key that signed it. Such a frame is
 * malformed: a key can't vouch for itself as its own successor. Envelope
 * verification rejects it on both sides.
 *
 * @param envelopeKid - `Envelope.kid` of the frame.
 * @param message - The verified payload.
 * @returns `true` when `next_keys` or `keys` contains `envelopeKid`.
 * @example
 * announcesSigningKid("k1", { type: "key_announce", keys: [{ kid: "k1", … }] }); // true
 */
export function announcesSigningKid(
  envelopeKid: string,
  message: {
    type: string;
    next_keys?: readonly { kid: string }[];
    keys?: readonly { kid: string }[];
  },
): boolean {
  const keys =
    message.type === "welcome"
      ? message.next_keys
      : message.type === "key_announce"
        ? message.keys
        : undefined;
  return !!keys?.some((k) => k.kid === envelopeKid);
}
