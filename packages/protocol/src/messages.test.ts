import { describe, expect, it } from "vitest";
import {
  AgentMessageSchema,
  BUILD_CANCEL_PROTOCOL_VERSION,
  BuildCancelSchema,
  BuildJobSchema,
  BuildResultSchema,
  ControlMessageSchema,
  CREDENTIAL_FRAME_TTL_MS,
  carriesCredentials,
  DesiredStateSchema,
  HelloSchema,
  LogsSchema,
  MAX_LOG_FRAME_TEXT_BYTES,
  MAX_LOG_LINE_BYTES,
  MAX_LOG_LINES_PER_FRAME,
  MAX_WORKLOADS_PER_NODE,
  MIN_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SEALED_ENV_PROTOCOL_VERSION,
  SECRET_BUILD_ARGS_PROTOCOL_VERSION,
  type SealedBox,
  WORKLOADS_PROTOCOL_VERSION,
  type WorkloadSpec,
  WorkloadSpecSchema,
  WorkloadStatusSchema,
} from "./index";

const HASH = "0".repeat(64);

/** Shape-valid box; these tests never open it. */
const BOX: SealedBox = {
  v: 1,
  kid: "0123456789abcdef",
  epk: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=",
  ct: "AAAAAAAAAAAAAAAAAAAAAA==",
};

function workload(overrides: Partial<WorkloadSpec> = {}): WorkloadSpec {
  return {
    id: "wl_1",
    kind: "service",
    project_id: "prj_1",
    environment_id: "env_1",
    service_id: "svc_1",
    deployment_id: "dep_1",
    replica: 0,
    image: "nginx:1.27",
    env_sealed: BOX,
    ports: [{ container_port: 8080, protocol: "http" }],
    routes: [{ hostname: "web.example.com", container_port: 8080 }],
    healthcheck: null,
    resources: { cpu_millis: 250, memory_mb: 256, pids: 128 },
    restart: { policy: "always", max_retries: 0 },
    network: "roundhouse-prj_1-env_1",
    labels: {},
    drain_s: 10,
    spec_hash: HASH,
    ...overrides,
  };
}

const header = { id: "m1", node_id: "node_a", iat: 1000, exp: 1000 + CREDENTIAL_FRAME_TTL_MS };

function desired(overrides: Record<string, unknown> = {}) {
  return {
    type: "desired_state",
    ...header,
    generation: 1,
    workloads: [workload()],
    tls_mode: "internal",
    apps_domain: "127.0.0.1.nip.io",
    registry: null,
    ...overrides,
  };
}

function buildJob(overrides: Record<string, unknown> = {}) {
  return {
    type: "build_job",
    ...header,
    build_id: "bld_1",
    deployment_id: "dep_1",
    project_id: "prj_1",
    service_id: "svc_1",
    source: {
      type: "git",
      url: "https://github.com/acme/api.git",
      commit_sha: "a".repeat(40),
    },
    builder: "railpack",
    context_dir: ".",
    build_args: {},
    image_repository: "127.0.0.1:5000/prj_1/svc_1",
    cache_key: "prj_1.svc_1",
    timeout_s: 600,
    ...overrides,
  };
}

describe("protocol version", () => {
  it("follows ADR 0015: Phase 3 is version 6, still accepting version 3", () => {
    expect(PROTOCOL_VERSION).toBe(6);
    expect(MIN_PROTOCOL_VERSION).toBe(3);
  });

  it("keeps the Phase 1 hardening gates inside the accepted range", () => {
    for (const v of [BUILD_CANCEL_PROTOCOL_VERSION, SECRET_BUILD_ARGS_PROTOCOL_VERSION]) {
      expect(v).toBe(3);
      expect(v).toBeGreaterThanOrEqual(MIN_PROTOCOL_VERSION);
      expect(v).toBeLessThanOrEqual(PROTOCOL_VERSION);
    }
  });

  it("gates sealing at the current version and keeps the Phase 1 gate", () => {
    expect(SEALED_ENV_PROTOCOL_VERSION).toBe(4);
    expect(SEALED_ENV_PROTOCOL_VERSION).toBeGreaterThan(MIN_PROTOCOL_VERSION);
    expect(SEALED_ENV_PROTOCOL_VERSION).toBeLessThanOrEqual(PROTOCOL_VERSION);
    expect(WORKLOADS_PROTOCOL_VERSION).toBe(2);
  });
});

describe("WorkloadSpecSchema", () => {
  it("accepts a valid spec", () => {
    expect(WorkloadSpecSchema.safeParse(workload()).success).toBe(true);
  });

  it.each([
    ["its environment network", "roundhouse-prj_1-env_1"],
    ["its own project's legacy network, while it migrates", "roundhouse-prj_1"],
  ])("lets a service join %s", (_name, network) => {
    expect(WorkloadSpecSchema.safeParse(workload({ network })).success).toBe(true);
  });

  it("accepts the hashed environment network of long ids and nothing near it", () => {
    const project_id = `prj_${"a".repeat(64)}`;
    const environment_id = `env_${"b".repeat(64)}`;
    // Pinned by fixtures/network-names.json.
    const hashed =
      "roundhouse-env-de76313f46ca78e88fae6164b20495d30a7eb49069316d1fb8c3248492e9fb3b";
    const spec = (network: string) => workload({ project_id, environment_id, network });
    expect(WorkloadSpecSchema.safeParse(spec(hashed)).success).toBe(true);
    expect(WorkloadSpecSchema.safeParse(spec(`${hashed.slice(0, -1)}c`)).success).toBe(false);
  });

  it.each<[string, Partial<WorkloadSpec>]>([
    ["a service without ownership ids", { project_id: null }],
    ["a system workload with ownership ids", { kind: "system" }],
    ["an invalid image", { image: "Nginx:latest" }],
    ["an image with whitespace", { image: "nginx 1.27" }],
    ["an empty command", { command: [] }],
    ["a NUL in an argument", { command: ["a\0b"] }],
    ["a service without env_sealed", { env_sealed: null }],
    ["a box with a bad kid", { env_sealed: { ...BOX, kid: "nope" } }],
    ["a box with a short epk", { env_sealed: { ...BOX, epk: "AAAA" } }],
    ["a box of another version", { env_sealed: { ...BOX, v: 2 as 1 } }],
    ["another environment's network", { network: "roundhouse-prj_1-env_2" }],
    ["another project's network", { network: "roundhouse-prj_2-env_1" }],
    ["another project's legacy network", { network: "roundhouse-prj_2" }],
    ["the host network", { network: "host" }],
    ["the bridge network", { network: "bridge" }],
    ["no network", { network: "none" }],
    ["the system network", { network: "roundhouse-system" }],
    ["the build network", { network: "roundhouse-build" }],
    ["a local image of another service", { image: `127.0.0.1:5000/prj_1/svc_2@sha256:${HASH}` }],
    ["a local image by tag", { image: "127.0.0.1:5000/prj_1/svc_1:latest" }],
    ["port 0", { ports: [{ container_port: 0, protocol: "http" }], routes: [] }],
    ["port 65536", { ports: [{ container_port: 65536, protocol: "tcp" }], routes: [] }],
    [
      "duplicate ports",
      {
        ports: [
          { container_port: 8080, protocol: "http" },
          { container_port: 8080, protocol: "tcp" },
        ],
      },
    ],
    [
      "a route to an undeclared port",
      { routes: [{ hostname: "a.example.com", container_port: 9 }] },
    ],
    [
      "a route to a tcp port",
      {
        ports: [{ container_port: 8080, protocol: "tcp" }],
      },
    ],
    [
      "duplicate routes",
      {
        routes: [
          { hostname: "a.example.com", container_port: 8080 },
          { hostname: "a.example.com", container_port: 8080, path_prefix: "/" },
        ],
      },
    ],
    ["an uppercase hostname", { routes: [{ hostname: "A.example.com", container_port: 8080 }] }],
    ["a single-label hostname", { routes: [{ hostname: "localhost", container_port: 8080 }] }],
    [
      "a 64-character label",
      { routes: [{ hostname: `${"a".repeat(64)}.example.com`, container_port: 8080 }] },
    ],
    [
      "a path prefix without a slash",
      { routes: [{ hostname: "a.example.com", container_port: 8080, path_prefix: "v1" }] },
    ],
    [
      "an http probe without a path",
      {
        healthcheck: {
          type: "http",
          port: 8080,
          interval_s: 5,
          timeout_s: 2,
          retries: 3,
          start_period_s: 0,
        },
      },
    ],
    [
      "a tcp probe with a path",
      {
        healthcheck: {
          type: "tcp",
          path: "/x",
          port: 8080,
          interval_s: 5,
          timeout_s: 2,
          retries: 3,
          start_period_s: 0,
        },
      },
    ],
    ["too little memory", { resources: { cpu_millis: 250, memory_mb: 8, pids: 128 } }],
    ["a bad network", { network: "-bad" }],
    ["a bad label key", { labels: { "-x": "y" } }],
    ["a bad spec hash", { spec_hash: "ABC" }],
    ["a negative drain", { drain_s: -1 }],
  ])("rejects %s", (_name, overrides) => {
    expect(WorkloadSpecSchema.safeParse(workload(overrides)).success).toBe(false);
  });

  it.each([
    "nginx",
    "nginx:1.27",
    "library/nginx:1.27-alpine",
    "ghcr.io/acme/api:v1.2.3",
    "registry.example.com:5000/a/b/c",
    `127.0.0.1:5000/prj_1/svc_1@sha256:${"f".repeat(64)}`,
    `ghcr.io/acme/api:v1@sha256:${"0".repeat(64)}`,
  ])("accepts image %s", (image) => {
    expect(WorkloadSpecSchema.safeParse(workload({ image })).success).toBe(true);
  });

  it("accepts a system workload without ownership ids", () => {
    const spec = workload({
      id: "sys_registry",
      kind: "system",
      project_id: null,
      environment_id: null,
      service_id: null,
      deployment_id: null,
      env_sealed: null,
      routes: [],
    });
    expect(WorkloadSpecSchema.safeParse(spec).success).toBe(true);
  });
});

describe("DesiredStateSchema", () => {
  it("accepts a full desired state", () => {
    expect(DesiredStateSchema.safeParse(desired()).success).toBe(true);
  });

  it("rejects system workloads, duplicates, and too many workloads", () => {
    const sys = workload({
      id: "sys_x",
      kind: "system",
      project_id: null,
      environment_id: null,
      service_id: null,
      deployment_id: null,
      env_sealed: null,
      routes: [],
    });
    expect(DesiredStateSchema.safeParse(desired({ workloads: [sys] })).success).toBe(false);
    expect(
      DesiredStateSchema.safeParse(desired({ workloads: [workload(), workload()] })).success,
    ).toBe(false);
    const many = Array.from({ length: MAX_WORKLOADS_PER_NODE + 1 }, (_, i) =>
      workload({ id: `wl_${i}` }),
    );
    expect(DesiredStateSchema.safeParse(desired({ workloads: many })).success).toBe(false);
  });

  it("requires the registry to listen on the fixed address", () => {
    const registry = { listen: "0.0.0.0:5000", storage: { type: "filesystem" } };
    expect(DesiredStateSchema.safeParse(desired({ registry })).success).toBe(false);
  });

  it("caps the lifetime of frames that carry credentials", () => {
    const auth = { server: "ghcr.io", username: "u", password: "p" };
    const withAuth = { workloads: [workload({ registry_auth: auth })] };
    expect(DesiredStateSchema.safeParse(desired(withAuth)).success).toBe(true);
    expect(
      DesiredStateSchema.safeParse(desired({ ...withAuth, exp: header.exp + 1 })).success,
    ).toBe(false);
    // Every service workload carries a sealed env, so it counts as a credential.
    expect(DesiredStateSchema.safeParse(desired({ exp: header.exp + 1 })).success).toBe(false);
    // Without workloads or credentials, a longer lifetime is fine.
    expect(
      DesiredStateSchema.safeParse(desired({ workloads: [], exp: header.exp + 60_000 })).success,
    ).toBe(true);

    const s3 = {
      listen: "127.0.0.1:5000",
      storage: {
        type: "s3",
        endpoint: "https://x.r2.cloudflarestorage.com",
        bucket: "reg",
        region: "auto",
        access_key_id: "a",
        secret_access_key: "b",
      },
    };
    expect(
      DesiredStateSchema.safeParse(desired({ registry: s3, exp: header.exp + 1 })).success,
    ).toBe(false);
  });
});

describe("BuildJobSchema", () => {
  it("accepts a valid job", () => {
    expect(BuildJobSchema.safeParse(buildJob()).success).toBe(true);
    expect(ControlMessageSchema.safeParse(buildJob()).success).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    [
      "a clone URL with credentials",
      { source: { type: "git", url: "https://x:y@github.com/a/b", commit_sha: "a".repeat(40) } },
    ],
    [
      "a plain-http clone URL",
      { source: { type: "git", url: "http://github.com/a/b", commit_sha: "a".repeat(40) } },
    ],
    [
      "a short commit sha",
      { source: { type: "git", url: "https://github.com/a/b", commit_sha: "abc123" } },
    ],
    ["a context outside the repository", { context_dir: "../x" }],
    ["an absolute context", { context_dir: "/etc" }],
    ["a dockerfile path with the railpack builder", { dockerfile_path: "Dockerfile" }],
    ["a repository outside the local registry", { image_repository: "ghcr.io/acme/api" }],
    ["a repository with a tag", { image_repository: "127.0.0.1:5000/a/b:latest" }],
    ["a bad build arg name", { build_args: { "a-b": "1" } }],
    ["a short timeout", { timeout_s: 5 }],
    ["a secret build arg that is not a build arg", { secret_build_args: ["NPM_TOKEN"] }],
    [
      "a secret build arg listed twice",
      { build_args: { NPM_TOKEN: "x" }, secret_build_args: ["NPM_TOKEN", "NPM_TOKEN"] },
    ],
    ["a bad secret build arg name", { build_args: { "a-b": "1" }, secret_build_args: ["a-b"] }],
    ["another service's repository", { image_repository: "127.0.0.1:5000/prj_1/svc_2" }],
    ["another project's cache", { cache_key: "prj_2.svc_1" }],
    ["a missing project id", { project_id: undefined }],
    [
      "a ref that reads as an option",
      {
        source: {
          type: "git",
          url: "https://github.com/a/b",
          commit_sha: "a".repeat(40),
          ref: "--upload-pack=touch /tmp/x",
        },
      },
    ],
    [
      "a ref with ..",
      {
        source: {
          type: "git",
          url: "https://github.com/a/b",
          commit_sha: "a".repeat(40),
          ref: "a..b",
        },
      },
    ],
    ["a malformed secrets box", { build_secrets_sealed: { ...BOX, ct: "not base64!" } }],
  ])("rejects %s", (_name, overrides) => {
    expect(BuildJobSchema.safeParse(buildJob(overrides)).success).toBe(false);
  });

  it("marks build args as secret by name", () => {
    const job = buildJob({
      build_args: { NODE_ENV: "production", NPM_TOKEN: "npm_x" },
      secret_build_args: ["NPM_TOKEN"],
    });
    expect(BuildJobSchema.parse(job).secret_build_args).toEqual(["NPM_TOKEN"]);
    expect(BuildJobSchema.safeParse(buildJob({ secret_build_args: [] })).success).toBe(true);
  });

  it("caps the lifetime of jobs carrying a git token", () => {
    const source = {
      type: "git",
      url: "https://github.com/a/b",
      commit_sha: "a".repeat(40),
      token: "ghs_x",
    };
    expect(BuildJobSchema.safeParse(buildJob({ source })).success).toBe(true);
    expect(BuildJobSchema.safeParse(buildJob({ source, exp: header.exp + 1 })).success).toBe(false);
  });

  it("caps the lifetime of jobs carrying sealed secrets", () => {
    const job = { build_secrets_sealed: BOX };
    expect(BuildJobSchema.safeParse(buildJob(job)).success).toBe(true);
    expect(BuildJobSchema.safeParse(buildJob({ ...job, exp: header.exp + 1 })).success).toBe(false);
  });

  it("accepts safe refs", () => {
    for (const ref of ["main", "refs/heads/feature/login", "release-1.2", "v1.0.0"]) {
      const source = {
        type: "git",
        url: "https://github.com/a/b",
        commit_sha: "a".repeat(40),
        ref,
      };
      expect(BuildJobSchema.safeParse(buildJob({ source })).success, ref).toBe(true);
    }
  });
});

describe("BuildCancelSchema", () => {
  const cancel = { type: "build_cancel", ...header, build_id: "bld_1" };

  it("accepts a cancel and never treats it as carrying credentials", () => {
    expect(ControlMessageSchema.parse(cancel)).toEqual(cancel);
    expect(carriesCredentials({ type: "build_cancel" })).toBe(false);
  });

  it("needs a build id", () => {
    expect(BuildCancelSchema.safeParse({ ...cancel, build_id: "nope" }).success).toBe(false);
    expect(BuildCancelSchema.safeParse({ ...cancel, build_id: undefined }).success).toBe(false);
  });
});

describe("carriesCredentials", () => {
  it("detects every credential the protocol carries", () => {
    expect(carriesCredentials({ type: "welcome" })).toBe(false);
    expect(carriesCredentials({ type: "desired_state", workloads: [{}], registry: null })).toBe(
      false,
    );
    expect(
      carriesCredentials({
        type: "desired_state",
        workloads: [{ registry_auth: { server: "a", username: "b", password: "c" } }],
        registry: null,
      }),
    ).toBe(true);
    expect(
      carriesCredentials({
        type: "desired_state",
        workloads: [],
        registry: { storage: { type: "s3" } },
      }),
    ).toBe(true);
    expect(carriesCredentials({ type: "build_job", source: {} })).toBe(false);
    expect(carriesCredentials({ type: "build_job", source: { token: "t" } })).toBe(true);
    expect(
      carriesCredentials({
        type: "desired_state",
        workloads: [{ env_sealed: BOX }],
        registry: null,
      }),
    ).toBe(true);
    expect(carriesCredentials({ type: "build_job", source: {}, build_secrets_sealed: BOX })).toBe(
      true,
    );
  });
});

describe("agent messages", () => {
  const status = {
    type: "workload_status",
    workload_id: "wl_1",
    deployment_id: "dep_1",
    state: "healthy",
    restarts: 0,
    ts: 1,
  };

  it("accepts a v1 hello without statuses", () => {
    const hello = {
      type: "hello",
      protocol_version: 1,
      node_id: "node_a",
      agent_version: "0.1.0",
      os: "linux",
      arch: "amd64",
      kernel: "6",
      docker_version: null,
      hardware: { cpu_cores: 1, mem_bytes: 1, disk_bytes: 1 },
      capabilities: { docker: true, gvisor: false, builder: false },
      observed_generation: 0,
    };
    expect(HelloSchema.safeParse(hello).success).toBe(true);
  });

  it("validates workload statuses", () => {
    expect(WorkloadStatusSchema.safeParse(status).success).toBe(true);
    expect(WorkloadStatusSchema.safeParse({ ...status, state: "dead" }).success).toBe(false);
    expect(WorkloadStatusSchema.safeParse({ ...status, container_id: "XYZ" }).success).toBe(false);
    expect(WorkloadStatusSchema.safeParse({ ...status, exit_code: 256 }).success).toBe(false);
  });

  const logs = (lines: unknown[]) => ({
    type: "logs",
    source: { type: "build", build_id: "bld_1" },
    lines,
  });
  const line = (text: string) => ({ ts: 1, stream: "stdout", text });

  it("enforces log frame limits", () => {
    expect(LogsSchema.safeParse(logs([line("ok")])).success).toBe(true);
    expect(LogsSchema.safeParse(logs([])).success).toBe(false);
    expect(
      LogsSchema.safeParse(
        logs(Array.from({ length: MAX_LOG_LINES_PER_FRAME + 1 }, () => line(""))),
      ).success,
    ).toBe(false);
    // 2-byte characters: the limit counts UTF-8 bytes, not UTF-16 units.
    expect(LogsSchema.safeParse(logs([line("é".repeat(MAX_LOG_LINE_BYTES / 2))])).success).toBe(
      true,
    );
    expect(LogsSchema.safeParse(logs([line("é".repeat(MAX_LOG_LINE_BYTES / 2 + 1))])).success).toBe(
      false,
    );
    const full = Array.from({ length: MAX_LOG_FRAME_TEXT_BYTES / MAX_LOG_LINE_BYTES }, () =>
      line("x".repeat(MAX_LOG_LINE_BYTES)),
    );
    expect(LogsSchema.safeParse(logs(full)).success).toBe(true);
    expect(LogsSchema.safeParse(logs([...full, line("x")])).success).toBe(false);
  });

  it("requires a runtime log source to name its deployment", () => {
    const source = { type: "runtime", workload_id: "wl_1" };
    expect(AgentMessageSchema.safeParse({ ...logs([line("x")]), source }).success).toBe(false);
  });

  it("requires build results to be either an image or an error", () => {
    const base = { type: "build_result", build_id: "bld_1", duration_ms: 1 };
    const image = { repository: "127.0.0.1:5000/a/b", digest: `sha256:${"a".repeat(64)}` };
    expect(BuildResultSchema.safeParse({ ...base, ok: true, image }).success).toBe(true);
    expect(BuildResultSchema.safeParse({ ...base, ok: false, error: "boom" }).success).toBe(true);
    expect(BuildResultSchema.safeParse({ ...base, ok: true }).success).toBe(false);
    expect(BuildResultSchema.safeParse({ ...base, ok: false }).success).toBe(false);
    expect(BuildResultSchema.safeParse({ ...base, ok: true, image, error: "boom" }).success).toBe(
      false,
    );
    expect(BuildResultSchema.safeParse({ ...base, ok: false, image, error: "x" }).success).toBe(
      false,
    );
  });

  it("marks only failed build results as cancelled", () => {
    const base = { type: "build_result", build_id: "bld_1", duration_ms: 1 };
    const image = { repository: "127.0.0.1:5000/a/b", digest: `sha256:${"a".repeat(64)}` };
    expect(
      BuildResultSchema.safeParse({ ...base, ok: false, error: "x", cancelled: true }).success,
    ).toBe(true);
    expect(BuildResultSchema.safeParse({ ...base, ok: true, image, cancelled: true }).success).toBe(
      false,
    );
  });
});
