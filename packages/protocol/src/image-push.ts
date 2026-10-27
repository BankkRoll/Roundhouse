/**
 * Image push (ADR 0011 "Registry path"), from `IMAGE_PUSH_PROTOCOL_VERSION`:
 * a builder copies a built image from its local registry to another
 * registry, registry to registry, without unpacking it. The Cloudflare
 * Containers provider uses it to put git builds into
 * `registry.cloudflare.com`. Mirrored by `go/imagepush.go`.
 *
 * Departure from ADR 0011: the target's temporary username and password
 * travel sealed to the builder (`image-push` boxes) rather than in plain
 * fields, as every credential added after ADR 0014 does (ADR 0015).
 *
 * @module
 */
import { z } from "zod";
import { SealedBoxSchema } from "./box";
import { ControlHeader, isShortLived, SHORT_LIVED_ISSUE } from "./control";
import {
  boundedString,
  DIGEST_RE,
  IdString,
  IMAGE_REFERENCE_RE,
  MAX_IMAGE_PUSH_TIMEOUT_S,
  MAX_MESSAGE_BYTES,
  MIN_IMAGE_PUSH_TIMEOUT_S,
} from "./limits";
import { REGISTRY_LISTEN } from "./workload";

/** Platforms a push may select from a multi-platform source. */
export const IMAGE_PUSH_PLATFORMS = ["linux/amd64"] as const;

/** Longest image reference, as for workload images. */
const MAX_REFERENCE = 512;

/** `127.0.0.1:5000/<repo>@sha256:…`: an image in the builder's own registry, pinned. */
const LocalPinnedReference = z
  .string()
  .max(MAX_REFERENCE)
  .regex(IMAGE_REFERENCE_RE, "expected an image reference")
  .refine((r) => r.startsWith(`${REGISTRY_LISTEN}/`) && /@sha256:[a-f0-9]{64}$/.test(r), {
    message: `must be pinned by digest in the local registry at ${REGISTRY_LISTEN}`,
  });

/** `<registry host>/<repo>:<tag>`: where the copy goes. */
const RemoteTaggedReference = z
  .string()
  .max(MAX_REFERENCE)
  .regex(IMAGE_REFERENCE_RE, "expected an image reference")
  .refine((r) => /^[^/]+[.:][^/]*\//.test(r) && !r.includes("@") && /:[^/:]+$/.test(r), {
    message: "must name a registry host and a tag, without a digest",
  })
  .refine((r) => !r.startsWith(`${REGISTRY_LISTEN}/`), {
    message: "must not be the local registry",
  });

/**
 * Copies one image. Answered by `image_push_result`. Always
 * credential-bearing: the target registry's login is sealed under
 * `imagePushAad(node, push_id)`.
 */
export const ImagePushSchema = z
  .object({
    type: z.literal("image_push"),
    ...ControlHeader,
    /** `psh_…`; a repeated ID is answered from the first push's result. */
    push_id: IdString,
    source: LocalPinnedReference,
    target: RemoteTaggedReference,
    platform: z.enum(IMAGE_PUSH_PLATFORMS),
    /** `SealedImagePushCredentialSchema`. */
    credential_sealed: SealedBoxSchema,
    /** The builder gives up after this many seconds. */
    timeout_s: z.number().int().min(MIN_IMAGE_PUSH_TIMEOUT_S).max(MAX_IMAGE_PUSH_TIMEOUT_S),
  })
  .refine(isShortLived, SHORT_LIVED_ISSUE);

/** Copies one image. */
export type ImagePush = z.infer<typeof ImagePushSchema>;

/**
 * The outcome of a push. `ok` carries the pushed manifest's digest (for
 * the selected platform) and the bytes uploaded; a failure carries `error`,
 * never the credential.
 */
export const ImagePushResultSchema = z
  .object({
    type: z.literal("image_push_result"),
    push_id: IdString,
    ok: z.boolean(),
    digest: z.string().regex(DIGEST_RE, "expected a sha256 digest").optional(),
    bytes: z.number().int().nonnegative().optional(),
    error: boundedString(MAX_MESSAGE_BYTES, 1).optional(),
  })
  .refine((r) => (r.ok ? r.digest !== undefined && r.error === undefined : r.error !== undefined), {
    message: "a successful push has a digest and no error; a failed one has an error",
    path: ["ok"],
  });

/** The outcome of a push. */
export type ImagePushResult = z.infer<typeof ImagePushResultSchema>;
