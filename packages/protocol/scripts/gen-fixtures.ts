/**
 * Writes the generated fixtures both test suites check:
 *
 * - `signed-envelope.json`: a minimal `desired_state` that never expires;
 * - `signed-desired-state.json`: a builder node's `desired_state` with a full
 *   workload, registry credentials and S3 registry storage;
 * - `signed-build-job.json`: a `build_job` carrying a git token and a secret
 *   build arg;
 * - `signed-build-cancel.json`: a `build_cancel`;
 * - `spec-hash.json`: workload specs with their canonical text and hash;
 * - `network-names.json`: environment network names, readable and hashed.
 *
 * The signing key comes from a fixed seed and Ed25519 signatures are
 * deterministic, so regenerating produces identical output unless a message
 * or the scheme changes. Signatures prove TS and Go agree on the envelope
 * byte-for-byte; the hashes prove they agree on canonical JSON.
 *
 * Run with `pnpm --filter @openrail/protocol gen:fixtures`.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ControlMessage,
  ControlMessageSchema,
  CREDENTIAL_FRAME_TTL_MS,
  computeSpecHash,
  environmentNetworkName,
  importSigningKey,
  localImageRepository,
  signEnvelope,
  specHashInput,
  toBase64,
  type WorkloadSpec,
  WorkloadSpecSchema,
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

const fullWorkload = await withHash({
  id: "wl_01JAAAAAAAAAAAAAAAAAAAAAAA",
  kind: "service",
  project_id: PROJECT,
  environment_id: ENVIRONMENT,
  service_id: SERVICE,
  deployment_id: "dep_01JAAAAAAAAAAAAAAAAAAAAAAA",
  replica: 0,
  image: `${localImageRepository(PROJECT, SERVICE)}@sha256:${"ab".repeat(32)}`,
  registry_auth: { server: "127.0.0.1:5000", username: "openrail", password: "registry-secret" },
  command: ["node", "server.js"],
  entrypoint: ["/sbin/tini", "--"],
  env: { PORT: "3000", DATABASE_URL: "postgres://db:5432/app", GREETING: "héllo 🚀" },
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
  labels: { "openrail.service_name": "api", "com.example.team": "platform" },
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
  env: {},
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
  env: {
    QUOTES: 'say "hi" \\ bye',
    CONTROL: "tab\there\nnew\u0001line\u001f",
    HTML: "<script>&amp;</script>",
    SEPARATORS: "line para end",
    UNICODE: "日本語 ñ 🚀  ",
    DEL: "\u007f",
    a_lower: "sorted after uppercase",
    Z_UPPER: "sorted before lowercase",
  },
  labels: { "x.unicode": "café", "a.empty": "" },
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
  env: { REGISTRY_HTTP_ADDR: "0.0.0.0:5000" },
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
  network: "openrail-system",
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
      bucket: "openrail-registry",
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
  build_id: "bld_01JAAAAAAAAAAAAAAAAAAAAAAA",
  deployment_id: "dep_01JAAAAAAAAAAAAAAAAAAAAAAA",
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
  image_repository: localImageRepository(PROJECT, SERVICE),
  cache_key: "svc_01JAAAAAAAAAAAAAAAAAAAAAAA.production",
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

write("spec-hash.json", {
  cases: [
    ["full", fullWorkload],
    ["minimal", minimalWorkload],
    ["escaping", escapingWorkload],
    ["system", systemWorkload],
  ].map(([name, spec]) => ({
    name,
    spec,
    canonical: specHashInput(spec as WorkloadSpec),
    spec_hash: (spec as WorkloadSpec).spec_hash,
  })),
});
