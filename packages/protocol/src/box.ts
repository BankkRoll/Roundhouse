/**
 * Sealed boxes: public-key encryption from the control plane to one node,
 * so variable values and build secrets never cross the wire (or sit in a
 * Durable Object's outbox) in plaintext. Mirrored by `go/box.go`; both sides
 * decrypt `fixtures/sealed-box.json`. See ADR 0014, "Node sealing".
 *
 * Scheme (HPKE-style, base mode, single shot):
 * 1. The sender generates an ephemeral X25519 keypair `(esk, epk)`.
 * 2. `shared = X25519(esk, recipient_pk)`; an all-zero result is rejected.
 * 3. `okm = HKDF-SHA256(ikm = shared, salt = epk ‖ recipient_pk,
 *    info = "roundhouse-box:v1:" + purpose, length = 44)`.
 * 4. `key = okm[0..32]`, `nonce = okm[32..44]`. The key is single-use (fresh
 *    ephemeral key per box), so a derived nonce is safe.
 * 5. `ct = AES-256-GCM(key, nonce, plaintext, aad)`, tag appended.
 *
 * The AAD binds a box to where it may be opened (node, workload,
 * generation), so a box can't be replayed into another frame field.
 *
 * @module
 */
import { z } from "zod";
import { fromBase64, toBase64 } from "./encoding";
import {
  AGE_IDENTITY_RE,
  base64Bytes,
  boundedString,
  DB_PASSWORD_RE,
  ENV_KEY_RE,
  MAX_BACKUP_PARTS,
  MAX_BACKUP_PARTS_PER_FRAME,
  MAX_BUILD_SECRET_VALUE_BYTES,
  MAX_BUILD_SECRETS,
  MAX_CERT_KEY_PEM_BYTES,
  MAX_ENV_KEY_BYTES,
  MAX_ENV_TOTAL_BYTES,
  MAX_ENV_VALUE_BYTES,
  MAX_ENV_VARS,
  MAX_EXEC_INPUT_BYTES,
  MAX_MESH_PEERS,
  MAX_PRESIGNED_URL_BYTES,
  MAX_SEALED_BOX_CT_CHARS,
  NODE_ENCRYPTION_KEY_ID_RE,
  NODE_ID_RE,
  PRESIGNED_URL_RE,
  utf8ByteLength,
} from "./limits";

const encoder = new TextEncoder();

/** Box format version. */
export const BOX_VERSION = 1;

/**
 * What a box is for; part of the key derivation, so a box opens for one
 * purpose only. Every credential a Phase 2–3 frame carries has its own
 * purpose (ADR 0014 §6, ADR 0015).
 */
export const BOX_PURPOSES = [
  "workload-env",
  "build-secrets",
  "job-env",
  "mesh-psks",
  "registry-upstream",
  "backup-parts",
  "restore",
  "db-credential",
  "cert-key",
  "exec-input",
  "image-push",
  "wal-upload",
  "wal-fetch",
] as const;

/** A box purpose; see {@link BOX_PURPOSES}. */
export type BoxPurpose = (typeof BOX_PURPOSES)[number];

/**
 * HKDF `info` (and AAD prefix) for a purpose.
 *
 * @param purpose - What the box is for.
 * @returns E.g. `roundhouse-box:v1:workload-env`.
 */
export function boxInfo(purpose: BoxPurpose): string {
  return `roundhouse-box:v${BOX_VERSION}:${purpose}`;
}

/**
 * AAD of a workload's sealed environment.
 *
 * @param nodeId - Node the box is sealed to.
 * @param workloadId - The workload (`wl_…`).
 * @param generation - `desired_state.generation` of the frame carrying it.
 * @returns E.g. `roundhouse-box:v1:workload-env:node_1:wl_1:42`.
 */
export function workloadEnvAad(nodeId: string, workloadId: string, generation: number): string {
  return `${boxInfo("workload-env")}:${nodeId}:${workloadId}:${generation}`;
}

/**
 * AAD of a build job's sealed secrets.
 *
 * @param nodeId - Builder node the box is sealed to.
 * @param buildId - The build (`bld_…`).
 * @returns E.g. `roundhouse-box:v1:build-secrets:node_1:bld_1`.
 */
export function buildSecretsAad(nodeId: string, buildId: string): string {
  return `${boxInfo("build-secrets")}:${nodeId}:${buildId}`;
}

/**
 * AAD of a job run's sealed environment (`job_run.workload.env_sealed`).
 *
 * @param nodeId - Node the box is sealed to.
 * @param runId - The run (`crn_…`).
 * @param workloadId - The job container's workload ID (`wl_…`).
 * @returns E.g. `roundhouse-box:v1:job-env:node_1:crn_1:wl_1`.
 */
export function jobEnvAad(nodeId: string, runId: string, workloadId: string): string {
  return `${boxInfo("job-env")}:${nodeId}:${runId}:${workloadId}`;
}

/**
 * AAD of a node's sealed WireGuard preshared keys (`desired_state.mesh.psks_sealed`).
 *
 * @param nodeId - Node the box is sealed to.
 * @param generation - `desired_state.generation` of the frame carrying it.
 * @returns E.g. `roundhouse-box:v1:mesh-psks:node_1:42`.
 */
export function meshPsksAad(nodeId: string, generation: number): string {
  return `${boxInfo("mesh-psks")}:${nodeId}:${generation}`;
}

/**
 * AAD of a proxy registry's sealed upstream password
 * (`desired_state.registry.upstream.password_sealed`).
 *
 * @param nodeId - Node the box is sealed to.
 * @param generation - `desired_state.generation` of the frame carrying it.
 * @returns E.g. `roundhouse-box:v1:registry-upstream:node_1:42`.
 */
export function registryUpstreamAad(nodeId: string, generation: number): string {
  return `${boxInfo("registry-upstream")}:${nodeId}:${generation}`;
}

/**
 * AAD of presigned part URLs (`parts_sealed` of `backup_job`,
 * `backup_parts` and `volume_copy_out`).
 *
 * @param nodeId - Node the box is sealed to.
 * @param backupId - The backup the parts belong to (`bak_…`).
 * @returns E.g. `roundhouse-box:v1:backup-parts:node_1:bak_1`.
 */
export function backupPartsAad(nodeId: string, backupId: string): string {
  return `${boxInfo("backup-parts")}:${nodeId}:${backupId}`;
}

/**
 * AAD of a restore's download URL and age identity (`secrets_sealed` of
 * `restore_job` and `volume_copy_in`).
 *
 * @param nodeId - Node the box is sealed to.
 * @param restoreId - `restore_job.restore_id`, or `volume_copy_in.migration_id`.
 * @returns E.g. `roundhouse-box:v1:restore:node_1:rst_1`.
 */
export function restoreSecretsAad(nodeId: string, restoreId: string): string {
  return `${boxInfo("restore")}:${nodeId}:${restoreId}`;
}

/**
 * AAD of a query's database credential (`db_query.credential_sealed`).
 *
 * @param nodeId - Node the box is sealed to.
 * @param requestId - `db_query.request_id`.
 * @returns E.g. `roundhouse-box:v1:db-credential:node_1:q_1`.
 */
export function dbCredentialAad(nodeId: string, requestId: string): string {
  return `${boxInfo("db-credential")}:${nodeId}:${requestId}`;
}

/**
 * AAD of a certificate's private key (`cert_sync.upserts[].key_sealed`).
 * Binding the chain's digest stops a key being paired with another chain.
 *
 * @param nodeId - Node the box is sealed to.
 * @param certId - The certificate (`cer_…`).
 * @param sha256 - `upserts[].sha256`, hex SHA-256 of `cert_pem`.
 * @returns E.g. `roundhouse-box:v1:cert-key:node_1:cer_1:ab…`.
 */
export function certKeyAad(nodeId: string, certId: string, sha256: string): string {
  return `${boxInfo("cert-key")}:${nodeId}:${certId}:${sha256}`;
}

/**
 * AAD of one batch of terminal input (`exec_input.data_sealed`). Binding the
 * sequence number stops a captured batch being replayed at another position.
 *
 * @param nodeId - Node the box is sealed to.
 * @param sessionId - `exec_input.session_id` (`shl_…`).
 * @param seq - `exec_input.seq`.
 * @returns E.g. `roundhouse-box:v1:exec-input:node_1:shl_1:0`.
 */
export function execInputAad(nodeId: string, sessionId: string, seq: number): string {
  return `${boxInfo("exec-input")}:${nodeId}:${sessionId}:${seq}`;
}

/**
 * AAD of an image push's registry credential (`image_push.credential_sealed`).
 *
 * @param nodeId - Node the box is sealed to.
 * @param pushId - `image_push.push_id` (`psh_…`).
 * @returns E.g. `roundhouse-box:v1:image-push:node_1:psh_1`.
 */
export function imagePushAad(nodeId: string, pushId: string): string {
  return `${boxInfo("image-push")}:${nodeId}:${pushId}`;
}

const Base64Key32 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "expected a base64 32-byte key");

/** A node's X25519 public key: standard base64 of the raw 32 bytes. */
export const EncryptionPublicKeyString = Base64Key32;

/** A sealed box on the wire. */
export const SealedBoxSchema = z.object({
  v: z.literal(BOX_VERSION),
  /** {@link nodeEncryptionKeyId} of the recipient key, so a node can tell a stale box. */
  kid: z.string().regex(NODE_ENCRYPTION_KEY_ID_RE, "expected a key id"),
  /** Ephemeral X25519 public key, base64 (raw 32 bytes). */
  epk: Base64Key32,
  /** AES-256-GCM ciphertext with the 16-byte tag appended, base64. */
  ct: z
    .string()
    .max(MAX_SEALED_BOX_CT_CHARS)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, "expected base64"),
});

/** A sealed box on the wire. */
export type SealedBox = z.infer<typeof SealedBoxSchema>;

const NO_NUL = (s: string) => !s.includes("\0");
const EnvKey = z.string().max(MAX_ENV_KEY_BYTES).regex(ENV_KEY_RE, "expected a variable name");
const EnvValue = boundedString(MAX_ENV_VALUE_BYTES).refine(NO_NUL, {
  message: "must not contain NUL",
});
const totalBytes = (m: Record<string, string>) =>
  Object.entries(m).reduce((n, [k, v]) => n + k.length + utf8ByteLength(v), 0);

/**
 * Plaintext of `WorkloadSpec.env_sealed`: environment variables, and values
 * the agent writes to `/run/secrets/<KEY>` instead (variables with
 * `mount_as_file`). A key appears in at most one of the two.
 */
export const SealedWorkloadEnvSchema = z
  .object({
    env: z.record(EnvKey, EnvValue),
    files: z.record(EnvKey, EnvValue),
  })
  .superRefine((p, ctx) => {
    const count = Object.keys(p.env).length + Object.keys(p.files).length;
    if (count > MAX_ENV_VARS) {
      ctx.addIssue({ code: "custom", message: `at most ${MAX_ENV_VARS} variables` });
    }
    if (totalBytes(p.env) + totalBytes(p.files) > MAX_ENV_TOTAL_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `at most ${MAX_ENV_TOTAL_BYTES} bytes of variables`,
      });
    }
    for (const k of Object.keys(p.files)) {
      if (Object.hasOwn(p.env, k)) {
        ctx.addIssue({ code: "custom", message: `${k} is both an env var and a file` });
      }
    }
  });

/** Plaintext of `WorkloadSpec.env_sealed`. */
export type SealedWorkloadEnv = z.infer<typeof SealedWorkloadEnvSchema>;

/** Plaintext of `BuildJob.build_secrets_sealed`: BuildKit secrets by id. */
export const SealedBuildSecretsSchema = z.object({
  secrets: z
    .record(
      EnvKey,
      boundedString(MAX_BUILD_SECRET_VALUE_BYTES).refine(NO_NUL, {
        message: "must not contain NUL",
      }),
    )
    .refine((s) => Object.keys(s).length <= MAX_BUILD_SECRETS, {
      message: `at most ${MAX_BUILD_SECRETS} build secrets`,
    }),
});

/** Plaintext of `BuildJob.build_secrets_sealed`. */
export type SealedBuildSecrets = z.infer<typeof SealedBuildSecretsSchema>;

/** Plaintext of `desired_state.mesh.psks_sealed`: one 32-byte preshared key per peer node. */
export const SealedMeshPsksSchema = z.object({
  psks: z
    .record(z.string().regex(NODE_ID_RE, "expected a node id"), Base64Key32)
    .refine((m) => Object.keys(m).length <= MAX_MESH_PEERS, {
      message: `at most ${MAX_MESH_PEERS} preshared keys`,
    }),
});

/** Plaintext of `desired_state.mesh.psks_sealed`. */
export type SealedMeshPsks = z.infer<typeof SealedMeshPsksSchema>;

/** Plaintext of `desired_state.registry.upstream.password_sealed`. */
export const SealedRegistryUpstreamSchema = z.object({ password: boundedString(4096, 1) });

/** Plaintext of `desired_state.registry.upstream.password_sealed`. */
export type SealedRegistryUpstream = z.infer<typeof SealedRegistryUpstreamSchema>;

/** Presigned object-storage URL. Only ever inside a sealed box. */
export const PresignedUrlString = z
  .string()
  .max(MAX_PRESIGNED_URL_BYTES)
  .regex(PRESIGNED_URL_RE, "expected an http(s) URL");

/** One presigned `UploadPart` URL. */
export const BackupPartUrlSchema = z.object({
  part_number: z.number().int().min(1).max(MAX_BACKUP_PARTS),
  url: PresignedUrlString,
});

/** One presigned `UploadPart` URL. */
export type BackupPartUrl = z.infer<typeof BackupPartUrlSchema>;

/**
 * Plaintext of `parts_sealed` (`backup_job`, `backup_parts`,
 * `volume_copy_out`): consecutive presigned part URLs, ascending.
 */
export const SealedBackupPartsSchema = z.object({
  parts: z
    .array(BackupPartUrlSchema)
    .min(1)
    .max(MAX_BACKUP_PARTS_PER_FRAME)
    .refine((ps) => ps.every((p, i) => i === 0 || p.part_number === ps[i - 1]!.part_number + 1), {
      message: "part numbers must be consecutive and ascending",
    }),
});

/** Plaintext of `parts_sealed`. */
export type SealedBackupParts = z.infer<typeof SealedBackupPartsSchema>;

/** Plaintext of `secrets_sealed` (`restore_job`, `volume_copy_in`). */
export const SealedRestoreSecretsSchema = z.object({
  /** Presigned `GET` of the encrypted backup object. */
  download_url: PresignedUrlString,
  /** The project's age identity that decrypts it. */
  age_identity: z.string().regex(AGE_IDENTITY_RE, "expected an age identity"),
});

/** Plaintext of `secrets_sealed`. */
export type SealedRestoreSecrets = z.infer<typeof SealedRestoreSecretsSchema>;

/** Plaintext of `db_query.credential_sealed`: the principal the agent connects as. */
export const SealedDbCredentialSchema = z.object({
  username: boundedString(256, 1),
  password: boundedString(4096, 1),
  /** `set_password` only: the password the op sets. */
  new_password: z.string().regex(DB_PASSWORD_RE, "expected a generated password").optional(),
});

/** Plaintext of `db_query.credential_sealed`. */
export type SealedDbCredential = z.infer<typeof SealedDbCredentialSchema>;

/** Plaintext of `cert_sync.upserts[].key_sealed`: the PEM private key. */
export const SealedCertKeySchema = z.object({
  key_pem: boundedString(MAX_CERT_KEY_PEM_BYTES, 1).refine((k) => k.startsWith("-----BEGIN "), {
    message: "expected a PEM private key",
  }),
});

/** Plaintext of `cert_sync.upserts[].key_sealed`. */
export type SealedCertKey = z.infer<typeof SealedCertKeySchema>;

/**
 * Plaintext of `exec_input.data_sealed`: keystrokes, which may include
 * passwords typed at a prompt, as standard base64 of at most
 * `MAX_EXEC_INPUT_BYTES` raw bytes.
 */
export const SealedExecInputSchema = z.object({
  data: base64Bytes(MAX_EXEC_INPUT_BYTES),
});

/** Plaintext of `exec_input.data_sealed`. */
export type SealedExecInput = z.infer<typeof SealedExecInputSchema>;

/** Plaintext of `image_push.credential_sealed`: the target registry's temporary login. */
export const SealedImagePushCredentialSchema = z.object({
  username: boundedString(256, 1),
  password: boundedString(4096, 1),
});

/** Plaintext of `image_push.credential_sealed`. */
export type SealedImagePushCredential = z.infer<typeof SealedImagePushCredentialSchema>;

// -----------------------------------------------------------------------------
// Keys
// -----------------------------------------------------------------------------

const X25519 = { name: "X25519" } as const;
// NOTE: WebCrypto can't import a raw X25519 private key, only PKCS#8; the
// wrapping is a fixed 16-byte DER prefix (RFC 8410).
const PKCS8_X25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return [...(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Key ID of a node encryption key: the first 16 hex characters of SHA-256 of
 * the raw public key. Carried in every box so a node holding a newer key
 * reports a stale box instead of a decryption failure.
 *
 * @param publicKey - Base64 raw public key.
 * @returns 16 lowercase hex characters.
 */
export async function nodeEncryptionKeyId(publicKey: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", fromBase64(publicKey))).slice(0, 16);
}

/**
 * Bytes a node signs with its Ed25519 identity key to register an
 * encryption key after joining (`hello.encryption_key.sig`).
 *
 * @param nodeId - The node.
 * @param publicKey - Base64 raw X25519 public key.
 * @returns UTF-8 of `roundhouse-node-encryption-key:v1:<node_id>:<public_key>`.
 */
export function encryptionKeySignaturePayload(nodeId: string, publicKey: string): Uint8Array {
  return encoder.encode(`roundhouse-node-encryption-key:v1:${nodeId}:${publicKey}`);
}

/**
 * Checks a node's signed encryption key (`hello.encryption_key`) against its
 * identity key, and that `kid` matches the key.
 *
 * @param identityPublicKey - Base64 Ed25519 key stored at join (`nodes.identity_public_key`).
 * @param nodeId - The node.
 * @param key - The key as received.
 * @returns `true` when the signature and key ID are valid.
 */
export async function verifyNodeEncryptionKey(
  identityPublicKey: string,
  nodeId: string,
  key: { public_key: string; kid: string; sig: string },
): Promise<boolean> {
  try {
    if (key.kid !== (await nodeEncryptionKeyId(key.public_key))) return false;
    const identity = await crypto.subtle.importKey(
      "raw",
      fromBase64(identityPublicKey),
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      identity,
      fromBase64(key.sig),
      encryptionKeySignaturePayload(nodeId, key.public_key) as Uint8Array<ArrayBuffer>,
    );
  } catch {
    return false;
  }
}

function importPrivate(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.byteLength !== 32) throw new Error("X25519 private keys are 32 bytes");
  const pkcs8 = new Uint8Array(PKCS8_X25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_X25519_PREFIX);
  pkcs8.set(raw, PKCS8_X25519_PREFIX.length);
  return crypto.subtle.importKey("pkcs8", pkcs8, X25519, true, ["deriveBits"]);
}

async function publicOf(privateKey: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const jwk = (await crypto.subtle.exportKey("jwk", privateKey)) as JsonWebKey;
  return fromBase64(jwk.x!.replace(/-/g, "+").replace(/_/g, "/").padEnd(44, "="));
}

/**
 * Derives the public key of a raw X25519 private key.
 *
 * @param privateKey - Raw 32-byte private key.
 * @returns Base64 raw public key.
 */
export async function x25519PublicKey(privateKey: Uint8Array): Promise<string> {
  return toBase64(await publicOf(await importPrivate(privateKey)));
}

function x25519(publicKey: CryptoKey, privateKey: CryptoKey): Promise<ArrayBuffer> {
  // COMPAT: lib.dom names the peer key `public`; @cloudflare/workers-types
  // spells the same runtime field `$public`. The runtime field is `public`
  // in both, so the parameter is built untyped.
  const params = { name: "X25519", public: publicKey } as unknown as Parameters<
    SubtleCrypto["deriveBits"]
  >[0];
  return crypto.subtle.deriveBits(params, privateKey, 256);
}

async function deriveBoxKey(
  sharedSecret: ArrayBuffer,
  epk: Uint8Array,
  recipient: Uint8Array,
  purpose: BoxPurpose,
): Promise<{ key: CryptoKey; nonce: Uint8Array<ArrayBuffer> }> {
  if (new Uint8Array(sharedSecret).every((b) => b === 0)) {
    throw new Error("X25519 produced an all-zero shared secret");
  }
  const salt = new Uint8Array(64);
  salt.set(epk);
  salt.set(recipient, 32);
  const ikm = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits"]);
  const okm = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(boxInfo(purpose)) },
      ikm,
      44 * 8,
    ),
  );
  const key = await crypto.subtle.importKey("raw", okm.slice(0, 32), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
  return { key, nonce: okm.slice(32, 44) };
}

/** Options of {@link sealBox}. */
export interface SealOptions {
  /**
   * Fixed ephemeral private key (raw 32 bytes). Only for test vectors: reusing
   * one breaks the scheme's security.
   */
  ephemeralPrivateKey?: Uint8Array;
}

/**
 * Seals bytes to a node's encryption key.
 *
 * @param recipientPublicKey - Base64 raw X25519 public key of the node.
 * @param plaintext - Bytes, or a string encoded as UTF-8.
 * @param purpose - What the box is for.
 * @param aad - Context the box is bound to, e.g. {@link workloadEnvAad}.
 * @param options - Test-only overrides.
 * @returns The box.
 * @example
 * const box = await sealBox(node.encryptionPublicKey, JSON.stringify({ env, files: {} }),
 *   "workload-env", workloadEnvAad(node.id, workload.id, generation));
 */
export async function sealBox(
  recipientPublicKey: string,
  plaintext: Uint8Array | string,
  purpose: BoxPurpose,
  aad: string,
  options: SealOptions = {},
): Promise<SealedBox> {
  const recipient = fromBase64(recipientPublicKey);
  if (recipient.byteLength !== 32) throw new Error("X25519 public keys are 32 bytes");
  const recipientKey = await crypto.subtle.importKey("raw", recipient, X25519, true, []);
  let esk: CryptoKey;
  let epk: Uint8Array<ArrayBuffer>;
  if (options.ephemeralPrivateKey) {
    esk = await importPrivate(options.ephemeralPrivateKey);
    epk = await publicOf(esk);
  } else {
    const pair = (await crypto.subtle.generateKey(X25519, true, ["deriveBits"])) as CryptoKeyPair;
    esk = pair.privateKey;
    epk = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  }
  const shared = await x25519(recipientKey, esk);
  const { key, nonce } = await deriveBoxKey(shared, epk, recipient, purpose);
  const data = typeof plaintext === "string" ? encoder.encode(plaintext) : plaintext;
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(aad) },
    key,
    data as Uint8Array<ArrayBuffer>,
  );
  return {
    v: BOX_VERSION,
    kid: await nodeEncryptionKeyId(recipientPublicKey),
    epk: toBase64(epk),
    ct: toBase64(ct),
  };
}

/**
 * Opens a box. The control plane never needs this; it exists for tests and
 * tooling that play the node.
 *
 * @param recipientPrivateKey - Raw 32-byte X25519 private key.
 * @param box - The box.
 * @param purpose - Must match the purpose it was sealed for.
 * @param aad - Must equal the AAD it was sealed with.
 * @returns The plaintext bytes.
 * @throws When the key, purpose, AAD or ciphertext doesn't match.
 */
export async function openBox(
  recipientPrivateKey: Uint8Array,
  box: SealedBox,
  purpose: BoxPurpose,
  aad: string,
): Promise<Uint8Array> {
  const parsed = SealedBoxSchema.parse(box);
  const sk = await importPrivate(recipientPrivateKey);
  const recipient = await publicOf(sk);
  const epk = fromBase64(parsed.epk);
  const epkKey = await crypto.subtle.importKey("raw", epk, X25519, true, []);
  const shared = await x25519(epkKey, sk);
  const { key, nonce } = await deriveBoxKey(shared, epk, recipient, purpose);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(aad) },
      key,
      fromBase64(parsed.ct),
    ),
  );
}
