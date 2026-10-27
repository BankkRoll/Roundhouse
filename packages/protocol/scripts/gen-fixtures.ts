/**
 * Writes the generated fixtures both test suites check:
 *
 * - `signed-envelope.json`: a minimal `desired_state` that never expires;
 * - `signed-desired-state.json`: a builder node's `desired_state` with a full
 *   workload, registry credentials and S3 registry storage;
 * - `signed-build-job.json`: a `build_job` carrying a git token, a secret
 *   build arg and sealed build secrets;
 * - `signed-build-cancel.json`: a `build_cancel`;
 * - `sealed-box.json` and `encryption-key.json`: cross-language vectors for
 *   sealed boxes and a node's signed encryption key;
 * - `spec-hash.json`: workload specs with their canonical text and hash;
 * - `network-names.json`: environment network names, readable and hashed;
 * - Phase 2–3 (ADR 0015): `signed-desired-state-phase2.json` (mesh,
 *   volumes, a database workload, a route workload, a proxy registry) and
 *   `-phase3.json` (managed TLS), `signed-welcome-next-keys.json`,
 *   `signed-key-announce.json`, and one signed fixture per new control
 *   frame, every secret in a real sealed box;
 * - `formats.json`: expected results of the hand-written format helpers.
 *
 * The signing key comes from a fixed seed and Ed25519 signatures are
 * deterministic, so regenerating produces identical output unless a message
 * or the scheme changes. Signatures prove TS and Go agree on the envelope
 * byte-for-byte; the hashes prove they agree on canonical JSON.
 *
 * Run with `pnpm --filter @roundhouse/protocol gen:fixtures`.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// The protocol package does not depend on shared; only this generator reads it.
import { redact, redactionNeedles } from "../../shared/src/redaction";
import {
  type BoxPurpose,
  backupPartsAad,
  buildCacheKey,
  buildSecretsAad,
  type ControlMessage,
  ControlMessageSchema,
  CREDENTIAL_FRAME_TTL_MS,
  certKeyAad,
  computeSpecHash,
  dbCredentialAad,
  encryptionKeySignaturePayload,
  environmentNetworkName,
  importSigningKey,
  ipv4InCidr,
  isCidr,
  isHostPort,
  isIPv4,
  isIPv4Cidr,
  isIPv6,
  isRouteHostname,
  isSafeMountPath,
  jobEnvAad,
  localImageRepository,
  meshPsksAad,
  nodeEncryptionKeyId,
  registryUpstreamAad,
  restoreSecretsAad,
  type SealedBox,
  sealBox,
  signEnvelope,
  specHashInput,
  toBase64,
  type WorkloadSpec,
  WorkloadSpecSchema,
  workloadEnvAad,
  x25519PublicKey,
} from "../src/index";

// NOTE: PKCS#8 wrapping for a raw Ed25519 seed is a fixed 16-byte DER prefix.
const PKCS8_ED25519_PREFIX = "302e020100300506032b657004220420";
// RFC 8032 section 7.1 test vector 1: public and test-only.
const SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

const pkcs8 = Uint8Array.from(Buffer.from(PKCS8_ED25519_PREFIX + SEED_HEX, "hex"));
const key = await importSigningKey(toBase64(pkcs8));

const exportable = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, [
  "sign",
]);
const jwk = await crypto.subtle.exportKey("jwk", exportable);
const publicKey = Buffer.from(jwk.x!, "base64url").toString("base64");

const NODE_ID = "node_fixture";
const IAT = 1_700_000_000_000;
// Year 2100, so fixtures without credentials never expire during tests.
const FAR_FUTURE = 4_102_444_800_000;

function write(name: string, value: unknown): void {
  writeFileSync(join(fixturesDir, name), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote fixtures/${name}`);
}

async function writeSigned(name: string, message: ControlMessage): Promise<void> {
  ControlMessageSchema.parse(message);
  const envelope = await signEnvelope(message, key, "fixture");
  write(name, { public_key: publicKey, node_id: message.node_id, envelope });
}

async function withHash(spec: Omit<WorkloadSpec, "spec_hash">): Promise<WorkloadSpec> {
  return WorkloadSpecSchema.parse({ ...spec, spec_hash: await computeSpecHash(spec) });
}

const PROJECT = "prj_01JAAAAAAAAAAAAAAAAAAAAAAA";
const SERVICE = "svc_01JAAAAAAAAAAAAAAAAAAAAAAA";
const ENVIRONMENT = "env_01JAAAAAAAAAAAAAAAAAAAAAAA";
const NETWORK = await environmentNetworkName(PROJECT, ENVIRONMENT);

// RFC 7748 section 6.1 keys: public and test-only. Bob plays the node,
// Alice the sender's ephemeral key, so the X25519 output is the RFC's.
const NODE_PRIVATE_KEY_HEX = "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb";
const EPHEMERAL_PRIVATE_KEY_HEX =
  "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a";
const RFC7748_SHARED_HEX = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";
const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const nodePublicKey = await x25519PublicKey(hexBytes(NODE_PRIVATE_KEY_HEX));

function seal(plaintext: string, purpose: BoxPurpose, aad: string): Promise<SealedBox> {
  return sealBox(nodePublicKey, plaintext, purpose, aad, {
    ephemeralPrivateKey: hexBytes(EPHEMERAL_PRIVATE_KEY_HEX),
  });
}

/** A workload's sealed env for a frame of `generation` to {@link NODE_ID}. */
function envBox(
  workloadId: string,
  generation: number,
  env: Record<string, string>,
  files: Record<string, string> = {},
): Promise<SealedBox> {
  return seal(
    JSON.stringify({ env, files }),
    "workload-env",
    workloadEnvAad(NODE_ID, workloadId, generation),
  );
}

const DESIRED_GENERATION = 8;
const BUILD_ID = "bld_01JAAAAAAAAAAAAAAAAAAAAAAA";

const fullWorkload = await withHash({
  id: "wl_01JAAAAAAAAAAAAAAAAAAAAAAA",
  kind: "service",
  project_id: PROJECT,
  environment_id: ENVIRONMENT,
  service_id: SERVICE,
  deployment_id: "dep_01JAAAAAAAAAAAAAAAAAAAAAAA",
  replica: 0,
  image: `${localImageRepository(PROJECT, SERVICE)}@sha256:${"ab".repeat(32)}`,
  registry_auth: { server: "127.0.0.1:5000", username: "roundhouse", password: "registry-secret" },
  command: ["node", "server.js"],
  entrypoint: ["/sbin/tini", "--"],
  env_sealed: await envBox(
    "wl_01JAAAAAAAAAAAAAAAAAAAAAAA",
    DESIRED_GENERATION,
    { PORT: "3000", DATABASE_URL: "postgres://db:5432/app", GREETING: "héllo 🚀" },
    { STRIPE_KEY: "fixture-stripe-key" },
  ),
  ports: [
    { container_port: 3000, protocol: "http" },
    { container_port: 9229, protocol: "tcp" },
  ],
  routes: [
    { hostname: "api-production-x7k2.127.0.0.1.nip.io", container_port: 3000 },
    { hostname: "api.example.com", container_port: 3000, path_prefix: "/v1" },
  ],
  healthcheck: {
    type: "http",
    path: "/healthz",
    port: 3000,
    interval_s: 10,
    timeout_s: 3,
    retries: 3,
    start_period_s: 15,
  },
  resources: { cpu_millis: 500, memory_mb: 512, pids: 512 },
  restart: { policy: "on_failure", max_retries: 5 },
  network: NETWORK,
  labels: { "roundhouse.service_name": "api", "com.example.team": "platform" },
  drain_s: 30,
});

const minimalWorkload = await withHash({
  id: "wl_01JBBBBBBBBBBBBBBBBBBBBBBB",
  kind: "service",
  project_id: PROJECT,
  environment_id: ENVIRONMENT,
  service_id: "svc_01JBBBBBBBBBBBBBBBBBBBBBBB",
  deployment_id: "dep_01JBBBBBBBBBBBBBBBBBBBBBBB",
  replica: 2,
  image: "nginx:1.27",
  env_sealed: await envBox("wl_01JBBBBBBBBBBBBBBBBBBBBBBB", DESIRED_GENERATION, {}),
  ports: [],
  routes: [],
  healthcheck: null,
  resources: { cpu_millis: 10, memory_mb: 16, pids: 16 },
  restart: { policy: "always", max_retries: 0 },
  network: NETWORK,
  labels: {},
  drain_s: 0,
});

const escapingWorkload = await withHash({
  ...minimalWorkload,
  id: "wl_01JCCCCCCCCCCCCCCCCCCCCCCC",
  labels: {
    QUOTES: 'say "hi" \\ bye',
    CONTROL: "tab\there\nnew\u0001line\u001f",
    HTML: "<script>&amp;</script>",
    SEPARATORS: "line para end",
    UNICODE: "日本語 ñ 🚀  ",
    DEL: "\u007f",
    a_lower: "sorted after uppercase",
    Z_UPPER: "sorted before lowercase",
    "x.unicode": "café",
    "a.empty": "",
  },
  healthcheck: {
    type: "tcp",
    port: 5432,
    interval_s: 1,
    timeout_s: 1,
    retries: 0,
    start_period_s: 0,
  },
});

const systemWorkload = await withHash({
  id: "sys_registry",
  kind: "system",
  project_id: null,
  environment_id: null,
  service_id: null,
  deployment_id: null,
  replica: 0,
  image: "registry:3",
  env_sealed: null,
  ports: [{ container_port: 5000, protocol: "tcp" }],
  routes: [],
  healthcheck: {
    type: "none",
    port: 5000,
    interval_s: 30,
    timeout_s: 5,
    retries: 3,
    start_period_s: 0,
  },
  resources: { cpu_millis: 1000, memory_mb: 256, pids: 256 },
  restart: { policy: "always", max_retries: 0 },
  network: "roundhouse-system",
  labels: {},
  drain_s: 0,
});

await writeSigned("signed-envelope.json", {
  type: "desired_state",
  id: "msg_fixture",
  node_id: NODE_ID,
  iat: IAT,
  exp: FAR_FUTURE,
  generation: 7,
  workloads: [],
  tls_mode: "off",
  apps_domain: null,
  registry: null,
});

await writeSigned("signed-desired-state.json", {
  type: "desired_state",
  id: "msg_fixture_desired",
  node_id: NODE_ID,
  iat: IAT,
  exp: IAT + CREDENTIAL_FRAME_TTL_MS,
  generation: 8,
  workloads: [fullWorkload, minimalWorkload],
  tls_mode: "acme",
  apps_domain: "127.0.0.1.nip.io",
  registry: {
    listen: "127.0.0.1:5000",
    storage: {
      type: "s3",
      endpoint: "https://0123456789abcdef.r2.cloudflarestorage.com",
      bucket: "roundhouse-registry",
      region: "auto",
      access_key_id: "AKIAFIXTURE",
      secret_access_key: "fixture-secret-access-key",
    },
  },
});

await writeSigned("signed-build-job.json", {
  type: "build_job",
  id: "msg_fixture_build",
  node_id: NODE_ID,
  iat: IAT,
  exp: IAT + CREDENTIAL_FRAME_TTL_MS,
  build_id: BUILD_ID,
  deployment_id: "dep_01JAAAAAAAAAAAAAAAAAAAAAAA",
  project_id: PROJECT,
  service_id: SERVICE,
  source: {
    type: "git",
    url: "https://github.com/acme/api.git",
    commit_sha: "0123456789abcdef0123456789abcdef01234567",
    ref: "refs/heads/main",
    token: "ghs_fixtureInstallationToken",
  },
  builder: "dockerfile",
  dockerfile_path: "docker/Dockerfile",
  context_dir: ".",
  build_args: { NODE_ENV: "production", NPM_TOKEN: "npm_fixtureSecretValue" },
  secret_build_args: ["NPM_TOKEN"],
  build_secrets_sealed: await seal(
    JSON.stringify({ secrets: { NPM_TOKEN: "fixture-npm-token" } }),
    "build-secrets",
    buildSecretsAad(NODE_ID, BUILD_ID),
  ),
  image_repository: localImageRepository(PROJECT, SERVICE),
  cache_key: buildCacheKey(PROJECT, SERVICE),
  timeout_s: 1800,
});

await writeSigned("signed-build-cancel.json", {
  type: "build_cancel",
  id: "msg_fixture_cancel",
  node_id: NODE_ID,
  iat: IAT,
  exp: FAR_FUTURE,
  build_id: "bld_01JAAAAAAAAAAAAAAAAAAAAAAA",
});

// Cross-language vectors for the sealed box: both suites open each box with
// the node key, and re-seal with the fixed ephemeral key to the same bytes.
const boxCases = [
  {
    name: "workload-env",
    purpose: "workload-env" as const,
    aad: workloadEnvAad(NODE_ID, "wl_01JAAAAAAAAAAAAAAAAAAAAAAA", 42),
    plaintext: JSON.stringify({
      env: { PORT: "3000", GREETING: "héllo 🚀" },
      files: { TLS_KEY: "-----BEGIN TEST KEY-----\nAAAA\n-----END TEST KEY-----\n" },
    }),
  },
  {
    name: "build-secrets",
    purpose: "build-secrets" as const,
    aad: buildSecretsAad(NODE_ID, BUILD_ID),
    plaintext: JSON.stringify({ secrets: { NPM_TOKEN: "fixture-npm-token" } }),
  },
  {
    name: "empty-env",
    purpose: "workload-env" as const,
    aad: workloadEnvAad(NODE_ID, "wl_01JBBBBBBBBBBBBBBBBBBBBBBB", 0),
    plaintext: JSON.stringify({ env: {}, files: {} }),
  },
];
write("sealed-box.json", {
  node_id: NODE_ID,
  node_private_key_hex: NODE_PRIVATE_KEY_HEX,
  node_public_key: nodePublicKey,
  node_kid: await nodeEncryptionKeyId(nodePublicKey),
  ephemeral_private_key_hex: EPHEMERAL_PRIVATE_KEY_HEX,
  x25519_shared_hex: RFC7748_SHARED_HEX,
  cases: await Promise.all(
    boxCases.map(async (c) => ({ ...c, box: await seal(c.plaintext, c.purpose, c.aad) })),
  ),
});

// A node's encryption key signed by its identity key (the RFC 8032 key above).
const identity = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, [
  "sign",
]);
write("encryption-key.json", {
  node_id: NODE_ID,
  identity_public_key: publicKey,
  encryption_key: {
    public_key: nodePublicKey,
    kid: await nodeEncryptionKeyId(nodePublicKey),
    sig: toBase64(
      await crypto.subtle.sign(
        "Ed25519",
        identity,
        encryptionKeySignaturePayload(NODE_ID, nodePublicKey) as Uint8Array<ArrayBuffer>,
      ),
    ),
  },
});

// Readable names, the longest readable one, and IDs too long for it.
const networkCases: [string, string][] = [
  [PROJECT, ENVIRONMENT],
  ["prj_1", "env_2"],
  [`prj_${"a".repeat(55)}`, `env_${"b".repeat(55)}`],
  [`prj_${"a".repeat(64)}`, `env_${"b".repeat(64)}`],
  [`prj_${"a".repeat(56)}`, `env_${"b".repeat(55)}`],
];
write("network-names.json", {
  cases: await Promise.all(
    networkCases.map(async ([project_id, environment_id]) => ({
      project_id,
      environment_id,
      network: await environmentNetworkName(project_id, environment_id),
    })),
  ),
});

// -----------------------------------------------------------------------------
// Phase 2–3 (protocols 5 and 6, ADR 0015)
// -----------------------------------------------------------------------------

const DB_SERVICE = "svc_01JDDDDDDDDDDDDDDDDDDDDDDD";
const DB_WORKLOAD = "wl_01JDDDDDDDDDDDDDDDDDDDDDDD";
const VOLUME = "vol_01JDDDDDDDDDDDDDDDDDDDDDDD";
const PHASE2_GENERATION = 21;

const dbWorkload = await withHash({
  id: DB_WORKLOAD,
  kind: "service",
  project_id: PROJECT,
  environment_id: ENVIRONMENT,
  service_id: DB_SERVICE,
  deployment_id: "dep_01JDDDDDDDDDDDDDDDDDDDDDDD",
  replica: 0,
  image: `postgres@sha256:${"cd".repeat(32)}`,
  env_sealed: await envBox(DB_WORKLOAD, PHASE2_GENERATION, {
    POSTGRES_USER: "postgres",
    POSTGRES_DB: "app",
    POSTGRES_PASSWORD: "fixture-postgres-password",
  }),
  ports: [
    {
      container_port: 5432,
      protocol: "tcp",
      publish: { host_port: 20_001, host_ip: "0.0.0.0" },
    },
  ],
  routes: [],
  healthcheck: {
    type: "exec",
    command: ["sh", "-c", 'pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'],
    interval_s: 5,
    timeout_s: 5,
    retries: 6,
    start_period_s: 30,
  },
  resources: { cpu_millis: 1000, memory_mb: 1024, pids: 512 },
  restart: { policy: "always", max_retries: 0 },
  network: NETWORK,
  labels: {},
  drain_s: 0,
  mounts: [{ volume_id: VOLUME, path: "/var/lib/postgresql", read_only: false }],
  rollout: "stop_first",
  stop_grace_s: 60,
  publish_allowed_cidrs: ["203.0.113.7/32", "2001:db8::/48"],
  mesh_ip: "10.200.1.10",
  private_dns: true,
});

const routeWorkload = await withHash({
  id: "wl_01JEEEEEEEEEEEEEEEEEEEEEEE",
  kind: "route",
  project_id: PROJECT,
  environment_id: ENVIRONMENT,
  service_id: SERVICE,
  deployment_id: "dep_01JAAAAAAAAAAAAAAAAAAAAAAA",
  replica: 0,
  image: `${localImageRepository(PROJECT, SERVICE)}@sha256:${"ab".repeat(32)}`,
  env_sealed: null,
  ports: [{ container_port: 3000, protocol: "http" }],
  routes: [{ hostname: "api-production-x7k2.127.0.0.1.nip.io", container_port: 3000 }],
  healthcheck: null,
  resources: { cpu_millis: 10, memory_mb: 16, pids: 16 },
  restart: { policy: "always", max_retries: 0 },
  network: NETWORK,
  labels: {},
  drain_s: 0,
  upstreams: [
    { ip: "10.200.2.10", port: 3000 },
    { ip: "10.200.2.11", port: 3000 },
  ],
});

const RUN_ID = "crn_01JFFFFFFFFFFFFFFFFFFFFFFF";
const JOB_WORKLOAD = "wl_01JFFFFFFFFFFFFFFFFFFFFFFF";
const jobWorkload = await withHash({
  id: JOB_WORKLOAD,
  kind: "job",
  project_id: PROJECT,
  environment_id: ENVIRONMENT,
  service_id: "svc_01JFFFFFFFFFFFFFFFFFFFFFFF",
  deployment_id: "dep_01JFFFFFFFFFFFFFFFFFFFFFFF",
  replica: 0,
  image: "busybox:1.37",
  command: ["sh", "-c", 'echo "$GREETING"'],
  env_sealed: await seal(
    JSON.stringify({ env: { GREETING: "hello from cron" }, files: {} }),
    "job-env",
    jobEnvAad(NODE_ID, RUN_ID, JOB_WORKLOAD),
  ),
  ports: [],
  routes: [],
  healthcheck: null,
  resources: { cpu_millis: 250, memory_mb: 128, pids: 64 },
  restart: { policy: "never", max_retries: 0 },
  network: NETWORK,
  labels: {},
  drain_s: 0,
  mesh_ip: "10.200.1.11",
  private_dns: true,
});

const PEER_A = "node_peer_a";
const PEER_B = "node_peer_b";
// Deterministic, test-only 32-byte values; never real keys.
const key32 = (byte: number) => toBase64(new Uint8Array(32).fill(byte));

await writeSigned("signed-desired-state-phase2.json", {
  type: "desired_state",
  id: "msg_fixture_phase2",
  node_id: NODE_ID,
  iat: IAT,
  exp: IAT + CREDENTIAL_FRAME_TTL_MS,
  generation: PHASE2_GENERATION,
  workloads: [dbWorkload, routeWorkload],
  tls_mode: "acme",
  apps_domain: "127.0.0.1.nip.io",
  registry: {
    listen: "127.0.0.1:5000",
    storage: { type: "filesystem" },
    mode: "proxy",
    upstream: {
      url: "http://10.200.2.1:5000",
      username: "node_fixture",
      password_sealed: await seal(
        JSON.stringify({ password: "fixture-pull-password" }),
        "registry-upstream",
        registryUpstreamAad(NODE_ID, PHASE2_GENERATION),
      ),
    },
  },
  volumes: [
    {
      id: VOLUME,
      size_mb: 5120,
      project_id: PROJECT,
      environment_id: ENVIRONMENT,
      service_id: DB_SERVICE,
      owner: null,
    },
  ],
  mesh: {
    supernet: "10.200.0.0/16",
    node_index: 1,
    address: "10.200.1.1",
    dns_address: "10.200.1.2",
    listen_port: 51820,
    mtu: 1420,
    accept_fwmark: 0x2000000,
    rotate_key: false,
    activate_epoch: null,
    peers: [
      {
        node_id: PEER_A,
        public_key: key32(0xa1),
        endpoint: "203.0.113.20:51820",
        allowed_ips: ["10.200.2.0/24"],
        keepalive_s: 25,
      },
      {
        node_id: PEER_B,
        public_key: key32(0xb2),
        endpoint: null,
        allowed_ips: ["10.200.3.0/24", "10.200.4.0/24"],
        keepalive_s: 0,
      },
    ],
    psks_sealed: await seal(
      JSON.stringify({ psks: { [PEER_A]: key32(0x11), [PEER_B]: key32(0x22) } }),
      "mesh-psks",
      meshPsksAad(NODE_ID, PHASE2_GENERATION),
    ),
    forward_pairs: [["10.200.3.0/24", "10.200.4.0/24"]],
    node_addresses: ["10.200.1.1", "10.200.2.1", "10.200.3.1"],
    addresses: [
      { ip: "10.200.1.10", env_tag: 7, node_id: NODE_ID, routed_ports: [] },
      {
        ip: "10.200.2.10",
        env_tag: 7,
        node_id: PEER_A,
        routed_ports: [3000],
        private_domain: "api.production.shop.internal",
        healthy: true,
      },
      {
        ip: "10.200.2.11",
        env_tag: 7,
        node_id: PEER_A,
        routed_ports: [3000],
        private_domain: "api.production.shop.internal",
        healthy: false,
      },
    ],
  },
});

await writeSigned("signed-key-announce.json", {
  type: "key_announce",
  id: "msg_fixture_key_announce",
  node_id: NODE_ID,
  iat: IAT,
  exp: FAR_FUTURE,
  keys: [{ kid: "k2", public_key: key32(0x42), not_before: 1_700_086_400 }],
});

await writeSigned("signed-welcome-next-keys.json", {
  type: "welcome",
  id: "msg_fixture_welcome",
  node_id: NODE_ID,
  iat: IAT,
  exp: FAR_FUTURE,
  heartbeat_interval_ms: 10_000,
  next_keys: [
    { kid: "k2", public_key: key32(0x42), not_before: 1_700_086_400 },
    { kid: "k3", public_key: key32(0x43), not_before: 1_702_678_400 },
  ],
  metrics_interval_ms: 15_000,
});

await writeSigned("signed-volume-delete.json", {
  type: "volume_delete",
  id: "msg_fixture_volume_delete",
  node_id: NODE_ID,
  iat: IAT,
  exp: FAR_FUTURE,
  volume_id: VOLUME,
});

const BACKUP_ID = "bak_01JGGGGGGGGGGGGGGGGGGGGGGG";
const AGE_RECIPIENT = `age1${"q".repeat(58)}`;
const AGE_IDENTITY = `AGE-SECRET-KEY-1${"Q".repeat(58)}`;
const partUrl = (n: number) =>
  `https://0123456789abcdef.r2.cloudflarestorage.com/roundhouse-backups/backups/${BACKUP_ID}.rhbk.zst.age?partNumber=${n}&uploadId=fixture&X-Amz-Signature=${"0".repeat(64)}`;
const partsBox = (from: number, count: number) =>
  seal(
    JSON.stringify({
      parts: Array.from({ length: count }, (_, i) => ({
        part_number: from + i,
        url: partUrl(from + i),
      })),
    }),
    "backup-parts",
    backupPartsAad(NODE_ID, BACKUP_ID),
  );

await writeSigned("signed-backup-job.json", {
  type: "backup_job",
  id: "msg_fixture_backup_job",
  node_id: NODE_ID,
  iat: IAT,
  exp: IAT + CREDENTIAL_FRAME_TTL_MS,
  backup_id: BACKUP_ID,
  method: "dump",
  engine: "postgres",
  workload_id: DB_WORKLOAD,
  volume_id: VOLUME,
  quiesce: "none",
  databases: ["app"],
  age_recipient: AGE_RECIPIENT,
  part_size_bytes: 16 * 1024 * 1024,
  parts_sealed: await partsBox(1, 2),
  timeout_s: 3600,
});

await writeSigned("signed-backup-parts.json", {
  type: "backup_parts",
  id: "msg_fixture_backup_parts",
  node_id: NODE_ID,
  iat: IAT,
  exp: IAT + CREDENTIAL_FRAME_TTL_MS,
  backup_id: BACKUP_ID,
  parts_sealed: await partsBox(3, 2),
});

const RESTORE_ID = "rst_01JHHHHHHHHHHHHHHHHHHHHHHH";
const MIGRATION_ID = "mig_01JHHHHHHHHHHHHHHHHHHHHHHH";
const restoreBox = (id: string) =>
  seal(
    JSON.stringify({
      download_url: `https://0123456789abcdef.r2.cloudflarestorage.com/roundhouse-backups/backups/${BACKUP_ID}.rhbk.zst.age?X-Amz-Signature=${"1".repeat(64)}`,
      age_identity: AGE_IDENTITY,
    }),
    "restore",
    restoreSecretsAad(NODE_ID, id),
  );

await writeSigned("signed-restore-job.json", {
  type: "restore_job",
  id: "msg_fixture_restore_job",
  node_id: NODE_ID,
  iat: IAT,
  exp: IAT + CREDENTIAL_FRAME_TTL_MS,
  restore_id: RESTORE_ID,
  method: "dump",
  engine: "postgres",
  workload_id: DB_WORKLOAD,
  volume_id: VOLUME,
  backup_id: BACKUP_ID,
  sha256: "ef".repeat(32),
  size_bytes: 33_554_432,
  secrets_sealed: await restoreBox(RESTORE_ID),
  timeout_s: 3600,
});

await writeSigned("signed-volume-copy-out.json", {
  type: "volume_copy_out",
  id: "msg_fixture_copy_out",
  node_id: NODE_ID,
  iat: IAT,
  exp: IAT + CREDENTIAL_FRAME_TTL_MS,
  migration_id: MIGRATION_ID,
  backup_id: BACKUP_ID,
  volume_id: VOLUME,
  workload_id: DB_WORKLOAD,
  age_recipient: AGE_RECIPIENT,
  part_size_bytes: 16 * 1024 * 1024,
  parts_sealed: await partsBox(1, 1),
  timeout_s: 7200,
});

await writeSigned("signed-volume-copy-in.json", {
  type: "volume_copy_in",
  id: "msg_fixture_copy_in",
  node_id: NODE_ID,
  iat: IAT,
  exp: IAT + CREDENTIAL_FRAME_TTL_MS,
  migration_id: MIGRATION_ID,
  volume_id: VOLUME,
  backup_id: BACKUP_ID,
  sha256: "ef".repeat(32),
  size_bytes: 33_554_432,
  secrets_sealed: await restoreBox(MIGRATION_ID),
  timeout_s: 7200,
});

const REQUEST_ID = "q_01JIIIIIIIIIIIIIIIIIIIIIII";
await writeSigned("signed-db-query.json", {
  type: "db_query",
  id: "msg_fixture_db_query",
  node_id: NODE_ID,
  iat: IAT,
  exp: IAT + CREDENTIAL_FRAME_TTL_MS,
  request_id: REQUEST_ID,
  workload_id: DB_WORKLOAD,
  engine: "postgres",
  credential_sealed: await seal(
    JSON.stringify({ username: "roundhouse_ro", password: "fixture-ro-password" }),
    "db-credential",
    dbCredentialAad(NODE_ID, REQUEST_ID),
  ),
  mode: "read",
  op: {
    type: "raw",
    statement: "SELECT id, name, avatar FROM users WHERE id = $1 OR name = $2",
    params: ["1", null],
  },
  max_rows: 100,
  max_bytes: 458_752,
  timeout_ms: 30_000,
});

await writeSigned("signed-job-run.json", {
  type: "job_run",
  id: "msg_fixture_job_run",
  node_id: NODE_ID,
  iat: IAT,
  exp: IAT + CREDENTIAL_FRAME_TTL_MS,
  run_id: RUN_ID,
  workload: jobWorkload,
  timeout_s: 3600,
  kill_grace_s: 10,
});

await writeSigned("signed-job-cancel.json", {
  type: "job_cancel",
  id: "msg_fixture_job_cancel",
  node_id: NODE_ID,
  iat: IAT,
  exp: FAR_FUTURE,
  run_id: RUN_ID,
  reason: "replaced by crn_01JFFFFFFFFFFFFFFFFFFFFFFG",
});

const CERT_ID = "cer_01JJJJJJJJJJJJJJJJJJJJJJJJ";
const CERT_PEM =
  "-----BEGIN CERTIFICATE-----\nMIIBfixtureLEAF\n-----END CERTIFICATE-----\n-----BEGIN CERTIFICATE-----\nMIIBfixtureINTERMEDIATE\n-----END CERTIFICATE-----\n";
const CERT_SHA256 = Buffer.from(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(CERT_PEM)),
).toString("hex");
const CERT_NOT_AFTER = 1_707_776_000_000;

await writeSigned("signed-desired-state-phase3.json", {
  type: "desired_state",
  id: "msg_fixture_phase3",
  node_id: NODE_ID,
  iat: IAT,
  exp: FAR_FUTURE,
  generation: 31,
  workloads: [],
  tls_mode: "managed",
  apps_domain: "apps.example.com",
  registry: null,
  ingress: {
    acme_challenge_upstream: {
      url: "https://control.example.com/v1/acme/http-01",
      host: "control.example.com",
    },
    allowed_sources: ["173.245.48.0/20", "2400:cb00::/32"],
    managed_hosts: ["*.apps.example.com", "shop.example.org"],
  },
  certificates: [{ id: CERT_ID, sha256: CERT_SHA256, not_after: CERT_NOT_AFTER }],
});

await writeSigned("signed-cert-sync.json", {
  type: "cert_sync",
  id: "msg_fixture_cert_sync",
  node_id: NODE_ID,
  iat: IAT,
  exp: IAT + CREDENTIAL_FRAME_TTL_MS,
  upserts: [
    {
      id: CERT_ID,
      hostnames: ["*.apps.example.com", "apps.example.com"],
      cert_pem: CERT_PEM,
      sha256: CERT_SHA256,
      key_sealed: await seal(
        JSON.stringify({
          key_pem: "-----BEGIN EC PRIVATE KEY-----\nMHcfixture\n-----END EC PRIVATE KEY-----\n",
        }),
        "cert-key",
        certKeyAad(NODE_ID, CERT_ID, CERT_SHA256),
      ),
      not_after: CERT_NOT_AFTER,
    },
  ],
  removes: ["cer_01JJJJJJJJJJJJJJJJJJJJJJJK"],
});

// A workload with every Phase 3 route field, for the spec-hash cases.
const wildcardWorkload = await withHash({
  ...minimalWorkload,
  id: "wl_01JKKKKKKKKKKKKKKKKKKKKKKK",
  ports: [{ container_port: 8080, protocol: "http" }],
  routes: [
    {
      hostname: "*.apps.example.com",
      container_port: 8080,
      hsts: { max_age: 31_536_000, include_subdomains: true, preload: false },
    },
  ],
});

// Format helpers written by hand on both sides (no lookahead in Go RE2, no
// netip in Workers), pinned to each other here.
const formatFns = {
  isIPv4,
  isIPv6,
  isCidr,
  isIPv4Cidr,
  isHostPort,
  isSafeMountPath,
  isRouteHostname,
  ipv4InCidr: (input: string) => ipv4InCidr(...(input.split("|") as [string, string])),
};
const formatCases: [keyof typeof formatFns, string][] = [
  ["isIPv4", "10.200.1.1"],
  ["isIPv4", "256.1.1.1"],
  ["isIPv4", "01.2.3.4"],
  ["isIPv4", "1.2.3"],
  ["isIPv4", "10a200b1c1"],
  ["isIPv4", ""],
  ["isIPv6", "::"],
  ["isIPv6", "2001:db8::1"],
  ["isIPv6", "::ffff:10.0.0.1"],
  ["isIPv6", "1:2:3:4:5:6:7:8"],
  ["isIPv6", "1:2:3:4:5:6:7::"],
  ["isIPv6", "1:2:3:4:5:6:7:8:9"],
  ["isIPv6", "::1:2:3:4:5:6:7:8"],
  ["isIPv6", "1::2::3"],
  ["isIPv6", "1.2.3.4::"],
  ["isIPv6", ":1"],
  ["isIPv6", "fe80::1%eth0"],
  ["isIPv6", "12345::"],
  ["isCidr", "10.0.0.0/8"],
  ["isCidr", "10.0.0.0/33"],
  ["isCidr", "10.0.0.0/08"],
  ["isCidr", "10.0.0.0"],
  ["isCidr", "2606:4700::/32"],
  ["isCidr", "::/0"],
  ["isCidr", "2606:4700::/129"],
  ["isIPv4Cidr", "10.200.0.0/16"],
  ["isIPv4Cidr", "2606:4700::/32"],
  ["ipv4InCidr", "10.200.3.1|10.200.0.0/16"],
  ["ipv4InCidr", "10.201.0.1|10.200.0.0/16"],
  ["ipv4InCidr", "10.0.0.1|0.0.0.0/0"],
  ["ipv4InCidr", "10.0.0.1|10.0.0.1/32"],
  ["ipv4InCidr", "10.0.0.2|10.0.0.1/32"],
  ["isHostPort", "203.0.113.7:51820"],
  ["isHostPort", "[2001:db8::1]:51820"],
  ["isHostPort", "node-a.example.com:51820"],
  ["isHostPort", "localhost:1"],
  ["isHostPort", "host:0"],
  ["isHostPort", "host:65536"],
  ["isHostPort", "host:080"],
  ["isHostPort", "2001:db8::1:51820"],
  ["isHostPort", ":51820"],
  ["isHostPort", "Host.Example:1"],
  ["isSafeMountPath", "/var/lib/postgresql"],
  ["isSafeMountPath", "/"],
  ["isSafeMountPath", "/data/"],
  ["isSafeMountPath", "/a/../b"],
  ["isSafeMountPath", "/a/./b"],
  ["isSafeMountPath", "/a//b"],
  ["isSafeMountPath", "/proc"],
  ["isSafeMountPath", "/proc/self"],
  ["isSafeMountPath", "/process"],
  ["isSafeMountPath", "/run/secrets"],
  ["isSafeMountPath", "/run/secrets2"],
  ["isSafeMountPath", "relative"],
  ["isRouteHostname", "*.apps.example.com"],
  ["isRouteHostname", "apps.example.com"],
  ["isRouteHostname", "*.com"],
  ["isRouteHostname", "a.*.example.com"],
  ["isRouteHostname", "*.*.example.com"],
  ["isRouteHostname", "*example.com"],
  ["isRouteHostname", "Example.com"],
];
write("formats.json", {
  cases: formatCases.map(([fn, input]) => ({ fn, input, want: formatFns[fn](input) })),
});

write("spec-hash.json", {
  cases: [
    ["full", fullWorkload],
    ["minimal", minimalWorkload],
    ["escaping", escapingWorkload],
    ["system", systemWorkload],
    ["volume-mesh", dbWorkload],
    ["route", routeWorkload],
    ["job", jobWorkload],
    ["wildcard-hsts", wildcardWorkload],
  ].map(([name, spec]) => ({
    name,
    spec,
    canonical: specHashInput(spec as WorkloadSpec),
    spec_hash: (spec as WorkloadSpec).spec_hash,
  })),
});

// Redaction parity: the agent (Go) and the control plane (TS) must redact the
// same strings for the same secrets.
const redactionCases = [
  { secrets: ["hunter22"], line: "pw=hunter22 b64=aHVudGVyMjI= hex=68756e7465723232" },
  { secrets: ['p@ss/w+rd "é"\n\b'], line: 'json="p@ss/w+rd \\"é\\"\\n\\b"' },
  { secrets: ["~~~~~~~~", "short", "🚀🚀🚀🚀🚀🚀"], line: "fn5-fn5-fn4 and 🚀🚀🚀🚀🚀🚀" },
  { secrets: ["<script>&amp; x"], line: "<script>&amp; x" },
];
write("redaction.json", {
  cases: redactionCases.map((c) => {
    const needles = redactionNeedles(c.secrets);
    return { ...c, needles, redacted: redact(c.line, needles) };
  }),
});
