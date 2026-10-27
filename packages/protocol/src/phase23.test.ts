import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentFrameSchema,
  announcesSigningKid,
  BACKUPS_PROTOCOL_VERSION,
  BackupJobSchema,
  BackupResultSchema,
  type BoxPurpose,
  backupPartsAad,
  CERTS_PROTOCOL_VERSION,
  CertStatusSchema,
  CertSyncSchema,
  type ControlMessage,
  ControlMessageSchema,
  CREDENTIAL_FRAME_TTL_MS,
  carriesCredentials,
  certKeyAad,
  computeSpecHash,
  DB_QUERY_PROTOCOL_VERSION,
  DbQuerySchema,
  DesiredStateSchema,
  dbCredentialAad,
  EnvelopeSchema,
  generateSigningKey,
  importSigningKey,
  ipv4InCidr,
  isCidr,
  isHostPort,
  isIPv4,
  isIPv4Cidr,
  isIPv6,
  isRouteHostname,
  isSafeMountPath,
  JOBS_PROTOCOL_VERSION,
  JobStatusSchema,
  jobEnvAad,
  KEY_ROLLOVER_PROTOCOL_VERSION,
  KeyAnnounceSchema,
  MESH_PROTOCOL_VERSION,
  METRICS_PROTOCOL_VERSION,
  MetricsSchema,
  MIN_PROTOCOL_VERSION,
  meshPsksAad,
  openBox,
  PROTOCOL_VERSION,
  registryUpstreamAad,
  restoreSecretsAad,
  SEALED_ENV_PROTOCOL_VERSION,
  SealedBackupPartsSchema,
  type SealedBox,
  SealedCertKeySchema,
  SealedDbCredentialSchema,
  SealedMeshPsksSchema,
  SealedRegistryUpstreamSchema,
  SealedRestoreSecretsSchema,
  SealedWorkloadEnvSchema,
  signEnvelope,
  VOLUMES_PROTOCOL_VERSION,
  verifyEnvelope,
  WelcomeSchema,
  type WorkloadSpec,
  WorkloadSpecSchema,
} from "./index";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, "..", "fixtures", name), "utf8"));

interface SignedFixture {
  public_key: string;
  node_id: string;
  envelope: { payload: string };
}

// biome-ignore lint/suspicious/noExplicitAny: fixture payloads are checked by the schema first.
const payload = (name: string): any => {
  const f = fixture(name) as SignedFixture;
  return ControlMessageSchema.parse(JSON.parse(f.envelope.payload));
};

const IAT = 1_700_000_000_000;
const header = { id: "m1", node_id: "node_a", iat: IAT, exp: IAT + CREDENTIAL_FRAME_TTL_MS };
const longLived = { exp: IAT + CREDENTIAL_FRAME_TTL_MS + 1 };

describe("version gates (ADR 0015)", () => {
  it("puts Phase 2 at 5 and Phase 3 at 6, above sealed env", () => {
    for (const gate of [
      MESH_PROTOCOL_VERSION,
      VOLUMES_PROTOCOL_VERSION,
      BACKUPS_PROTOCOL_VERSION,
      DB_QUERY_PROTOCOL_VERSION,
      KEY_ROLLOVER_PROTOCOL_VERSION,
    ]) {
      expect(gate).toBe(5);
    }
    for (const gate of [JOBS_PROTOCOL_VERSION, METRICS_PROTOCOL_VERSION, CERTS_PROTOCOL_VERSION]) {
      expect(gate).toBe(6);
    }
    expect(SEALED_ENV_PROTOCOL_VERSION).toBe(4);
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(CERTS_PROTOCOL_VERSION);
    expect(MIN_PROTOCOL_VERSION).toBeLessThan(MESH_PROTOCOL_VERSION);
  });
});

describe("format helpers", () => {
  const fns: Record<string, (input: string) => boolean> = {
    isIPv4,
    isIPv6,
    isCidr,
    isIPv4Cidr,
    isHostPort,
    isSafeMountPath,
    isRouteHostname,
    ipv4InCidr: (input) => ipv4InCidr(...(input.split("|") as [string, string])),
  };

  it("reproduces every formats.json case", () => {
    const { cases } = fixture("formats.json") as {
      cases: { fn: string; input: string; want: boolean }[];
    };
    expect(cases.length).toBeGreaterThan(50);
    for (const c of cases) expect(fns[c.fn]!(c.input), `${c.fn}(${c.input})`).toBe(c.want);
  });
});

describe("sealed boxes in the Phase 2–3 fixtures", () => {
  const box = fixture("sealed-box.json") as { node_id: string; node_private_key_hex: string };
  const key = Uint8Array.from(Buffer.from(box.node_private_key_hex, "hex"));
  const open = async (b: SealedBox, purpose: BoxPurpose, aad: string) =>
    JSON.parse(new TextDecoder().decode(await openBox(key, b, purpose, aad)));
  const node = box.node_id;

  it("opens every box with the node key and the documented AAD", async () => {
    const p2 = payload("signed-desired-state-phase2.json");
    SealedMeshPsksSchema.parse(
      await open(p2.mesh.psks_sealed, "mesh-psks", meshPsksAad(node, p2.generation)),
    );
    SealedRegistryUpstreamSchema.parse(
      await open(
        p2.registry.upstream.password_sealed,
        "registry-upstream",
        registryUpstreamAad(node, p2.generation),
      ),
    );
    for (const name of [
      "signed-backup-job.json",
      "signed-backup-parts.json",
      "signed-volume-copy-out.json",
    ]) {
      const m = payload(name);
      SealedBackupPartsSchema.parse(
        await open(m.parts_sealed, "backup-parts", backupPartsAad(node, m.backup_id)),
      );
    }
    const restore = payload("signed-restore-job.json");
    SealedRestoreSecretsSchema.parse(
      await open(restore.secrets_sealed, "restore", restoreSecretsAad(node, restore.restore_id)),
    );
    const copyIn = payload("signed-volume-copy-in.json");
    SealedRestoreSecretsSchema.parse(
      await open(copyIn.secrets_sealed, "restore", restoreSecretsAad(node, copyIn.migration_id)),
    );
    const query = payload("signed-db-query.json");
    SealedDbCredentialSchema.parse(
      await open(query.credential_sealed, "db-credential", dbCredentialAad(node, query.request_id)),
    );
    const run = payload("signed-job-run.json");
    SealedWorkloadEnvSchema.parse(
      await open(run.workload.env_sealed, "job-env", jobEnvAad(node, run.run_id, run.workload.id)),
    );
    const sync = payload("signed-cert-sync.json");
    for (const u of sync.upserts) {
      SealedCertKeySchema.parse(
        await open(u.key_sealed, "cert-key", certKeyAad(node, u.id, u.sha256)),
      );
    }
  });

  it("refuses a box under another purpose's AAD", async () => {
    const run = payload("signed-job-run.json");
    await expect(
      open(run.workload.env_sealed, "workload-env", jobEnvAad(node, run.run_id, run.workload.id)),
    ).rejects.toThrow();
  });

  it("signs workloads whose spec_hash matches their content", async () => {
    const workloads = [
      ...payload("signed-desired-state-phase2.json").workloads,
      payload("signed-job-run.json").workload,
    ];
    for (const raw of workloads) {
      const spec = WorkloadSpecSchema.parse(raw);
      expect(await computeSpecHash(spec)).toBe(spec.spec_hash);
    }
  });
});

describe("WorkloadSpec Phase 2–3 rules", () => {
  const p2 = () => payload("signed-desired-state-phase2.json");
  const db = (): WorkloadSpec => structuredClone(p2().workloads[0]);
  const route = (): WorkloadSpec => structuredClone(p2().workloads[1]);
  const ok = (w: unknown) => WorkloadSpecSchema.safeParse(w).success;

  it("accepts the fixture database and route workloads", () => {
    expect(ok(db())).toBe(true);
    expect(ok(route())).toBe(true);
  });

  it("keeps mounts to service workloads at safe paths", () => {
    expect(
      ok({ ...db(), mounts: [{ volume_id: "vol_1", path: "/proc/x", read_only: false }] }),
    ).toBe(false);
    expect(ok({ ...db(), mounts: [] })).toBe(false);
    expect(ok({ ...route(), mounts: db().mounts })).toBe(false);
  });

  it("requires exec probes to have a command and no port", () => {
    const hc = db().healthcheck!;
    expect(ok({ ...db(), healthcheck: { ...hc, port: 5432 } })).toBe(false);
    expect(ok({ ...db(), healthcheck: { ...hc, command: undefined } })).toBe(false);
    expect(ok({ ...db(), healthcheck: { ...hc, type: "tcp", command: undefined } })).toBe(false);
    expect(
      ok({ ...db(), healthcheck: { ...hc, type: "tcp", command: undefined, port: 5432 } }),
    ).toBe(true);
  });

  it("requires publish_allowed_cidrs exactly with a published port", () => {
    expect(ok({ ...db(), publish_allowed_cidrs: undefined })).toBe(false);
    expect(ok({ ...db(), ports: [{ container_port: 5432, protocol: "tcp" }] })).toBe(false);
    expect(ok({ ...db(), publish_allowed_cidrs: ["not-a-cidr"] })).toBe(false);
    expect(
      ok({
        ...db(),
        ports: [
          { container_port: 5432, protocol: "tcp", publish: { host_port: 80, host_ip: "0.0.0.0" } },
        ],
      }),
    ).toBe(false);
  });

  it("gives route workloads upstreams, routes, and no environment", () => {
    expect(ok({ ...route(), upstreams: undefined })).toBe(false);
    expect(ok({ ...route(), routes: [] })).toBe(false);
    expect(ok({ ...route(), env_sealed: db().env_sealed })).toBe(false);
    expect(ok({ ...db(), upstreams: route().upstreams })).toBe(false);
  });

  it("keeps job workloads portless, probeless and never restarted", () => {
    const job = payload("signed-job-run.json").workload as WorkloadSpec;
    expect(ok(job)).toBe(true);
    expect(ok({ ...job, restart: { policy: "on_failure", max_retries: 1 } })).toBe(false);
    expect(ok({ ...job, ports: [{ container_port: 80, protocol: "http" }] })).toBe(false);
    expect(ok({ ...job, env_sealed: null })).toBe(false);
  });

  it("accepts wildcard routes with HSTS and rejects preload without its prerequisites", () => {
    const base = { ...route(), routes: [{ hostname: "*.apps.example.com", container_port: 3000 }] };
    expect(ok(base)).toBe(true);
    const hsts = (h: object) => ({ ...base, routes: [{ ...base.routes[0], hsts: h }] });
    expect(ok(hsts({ max_age: 31_536_000, include_subdomains: true, preload: true }))).toBe(true);
    expect(ok(hsts({ max_age: 300, include_subdomains: true, preload: true }))).toBe(false);
    expect(ok(hsts({ max_age: 31_536_000, include_subdomains: false, preload: true }))).toBe(false);
  });
});

describe("DesiredState Phase 2–3 rules", () => {
  const p2 = () => payload("signed-desired-state-phase2.json");
  const ok = (m: unknown) => DesiredStateSchema.safeParse(m).success;

  it("accepts both fixtures", () => {
    expect(ok(p2())).toBe(true);
    expect(ok(payload("signed-desired-state-phase3.json"))).toBe(true);
  });

  it("only mounts listed volumes of the workload's own service", () => {
    expect(ok({ ...p2(), volumes: [] })).toBe(false);
    const m = p2();
    m.volumes[0].service_id = "svc_other";
    expect(ok(m)).toBe(false);
    expect(ok({ ...p2(), volumes: [p2().volumes[0], p2().volumes[0]] })).toBe(false);
  });

  it("needs the mesh for route workloads, mesh ips and private dns", () => {
    expect(ok({ ...p2(), mesh: null })).toBe(false);
    expect(ok({ ...p2(), mesh: null, workloads: [] })).toBe(true);
  });

  it("keeps mesh addresses inside the supernet and peers' PSKs sealed", () => {
    const outside = p2();
    outside.mesh.address = "10.201.1.1";
    expect(ok(outside)).toBe(false);
    const noPsk = p2();
    noPsk.mesh.psks_sealed = null;
    expect(ok(noPsk)).toBe(false);
    const dupPeer = p2();
    dupPeer.mesh.peers.push(dupPeer.mesh.peers[0]);
    expect(ok(dupPeer)).toBe(false);
  });

  it("enforces registry modes", () => {
    const proxyOnS3 = p2();
    proxyOnS3.registry.storage = {
      type: "s3",
      endpoint: "https://x.r2.cloudflarestorage.com",
      bucket: "bucket",
      region: "auto",
      access_key_id: "a",
      secret_access_key: "s",
    };
    expect(ok(proxyOnS3)).toBe(false);
    const primaryWithUpstream = p2();
    primaryWithUpstream.registry.mode = "primary";
    expect(ok(primaryWithUpstream)).toBe(false);
  });

  it("needs ingress settings for managed TLS", () => {
    expect(ok({ ...payload("signed-desired-state-phase3.json"), ingress: undefined })).toBe(false);
  });

  it("treats sealed PSKs and a proxy upstream as credentials", () => {
    const m = { ...p2(), workloads: [], volumes: [], registry: null };
    expect(carriesCredentials(m)).toBe(true);
    expect(ok({ ...m, ...longLived })).toBe(false);
    expect(carriesCredentials({ ...m, mesh: null })).toBe(false);
    expect(carriesCredentials({ ...p2(), workloads: [], mesh: null })).toBe(true);
  });
});

describe("Phase 2–3 frames", () => {
  it("validates backup sources", () => {
    const job = payload("signed-backup-job.json");
    const ok = (m: unknown) => BackupJobSchema.safeParse(m).success;
    expect(ok(job)).toBe(true);
    expect(ok({ ...job, engine: undefined })).toBe(false);
    expect(ok({ ...job, method: "snapshot" })).toBe(false);
    expect(ok({ ...job, method: "snapshot", databases: null })).toBe(true);
    expect(ok({ ...job, quiesce: "stop" })).toBe(false);
    expect(ok({ ...job, part_size_bytes: 16 * 1024 * 1024 + 1 })).toBe(false);
    expect(ok({ ...job, part_size_bytes: 1024 * 1024 })).toBe(false);
    expect(ok({ ...job, age_recipient: "age1short" })).toBe(false);
    expect(ok({ ...job, ...longLived })).toBe(false);
  });

  it("gives every sealed frame the credential TTL", () => {
    for (const name of [
      "signed-backup-job.json",
      "signed-backup-parts.json",
      "signed-restore-job.json",
      "signed-volume-copy-out.json",
      "signed-volume-copy-in.json",
      "signed-db-query.json",
      "signed-job-run.json",
      "signed-cert-sync.json",
    ]) {
      const m = payload(name);
      expect(carriesCredentials(m), name).toBe(true);
      expect(ControlMessageSchema.safeParse({ ...m, ...longLived }).success, name).toBe(false);
    }
    for (const name of [
      "signed-key-announce.json",
      "signed-volume-delete.json",
      "signed-job-cancel.json",
      "signed-welcome-next-keys.json",
      "signed-desired-state-phase3.json",
    ]) {
      expect(carriesCredentials(payload(name)), name).toBe(false);
    }
    expect(carriesCredentials({ type: "cert_sync", upserts: [] })).toBe(false);
    expect(
      CertSyncSchema.safeParse({ ...payload("signed-cert-sync.json"), upserts: [], ...longLived })
        .success,
    ).toBe(true);
  });

  it("validates db queries", () => {
    const q = payload("signed-db-query.json");
    const ok = (m: unknown) => DbQuerySchema.safeParse(m).success;
    expect(ok(q)).toBe(true);
    expect(ok({ ...q, op: { type: "raw", statement: "SELECT 1", argv: ["GET", "k"] } })).toBe(
      false,
    );
    expect(ok({ ...q, op: { type: "raw" } })).toBe(false);
    expect(ok({ ...q, op: { type: "raw", argv: ["GET", "k"], params: ["x"] } })).toBe(false);
    expect(ok({ ...q, op: { type: "provision_readonly" } })).toBe(false);
    expect(ok({ ...q, mode: "write", op: { type: "provision_readonly" } })).toBe(true);
    expect(ok({ ...q, mode: "write", op: { type: "set_password", user: "roundhouse_ro" } })).toBe(
      true,
    );
    expect(ok({ ...q, op: { type: "set_password", user: "roundhouse_ro" } })).toBe(false);
    expect(ok({ ...q, mode: "write", op: { type: "set_password" } })).toBe(false);
    expect(ok({ ...q, mode: "write", op: { type: "set_password", user: "x'; --" } })).toBe(false);
    const cred = { username: "postgres", password: "old" };
    expect(SealedDbCredentialSchema.safeParse(cred).success).toBe(true);
    expect(
      SealedDbCredentialSchema.safeParse({ ...cred, new_password: "a".repeat(43) }).success,
    ).toBe(true);
    expect(SealedDbCredentialSchema.safeParse({ ...cred, new_password: "short" }).success).toBe(
      false,
    );
    expect(
      SealedDbCredentialSchema.safeParse({ ...cred, new_password: `${"a".repeat(20)}'--` }).success,
    ).toBe(false);
    expect(ok({ ...q, max_rows: 1001 })).toBe(false);
    expect(ok({ ...q, request_id: "bad id" })).toBe(false);
  });

  it("validates job statuses", () => {
    const s = fixture("job-status.json") as Record<string, unknown>;
    const ok = (m: unknown) => JobStatusSchema.safeParse(m).success;
    expect(ok(s)).toBe(true);
    expect(ok({ ...s, finished_at: undefined })).toBe(false);
    expect(ok({ ...s, state: "running" })).toBe(false);
    expect(ok({ ...s, state: "running", finished_at: undefined })).toBe(true);
    expect(ok({ ...s, state: "succeeded" })).toBe(false);
    expect(ok({ ...s, state: "succeeded", exit_code: 0 })).toBe(true);
  });

  it("validates backup results and cert statuses", () => {
    const okResult = fixture("backup-result-ok.json") as Record<string, unknown>;
    expect(BackupResultSchema.safeParse({ ...okResult, sha256: undefined }).success).toBe(false);
    expect(BackupResultSchema.safeParse({ ...okResult, error: "x" }).success).toBe(false);
    const status = fixture("cert-status.json") as Record<string, unknown>;
    expect(CertStatusSchema.safeParse({ ...status, error: undefined }).success).toBe(false);
    expect(CertStatusSchema.safeParse({ ...status, state: "issued" }).success).toBe(false);
  });

  it("bounds metrics frames", () => {
    const m = fixture("metrics.json") as { samples: unknown[] };
    expect(MetricsSchema.safeParse(m).success).toBe(true);
    expect(MetricsSchema.safeParse({ ...m, samples: [m.samples[0], m.samples[0]] }).success).toBe(
      false,
    );
    expect(MetricsSchema.safeParse({ ...m, samples: [] }).success).toBe(false);
    expect(MetricsSchema.safeParse({ ...m, interval_ms: 500 }).success).toBe(false);
  });

  it("rejects unknown agent frames and keeps job logs out of the Phase 1 union", () => {
    expect(AgentFrameSchema.safeParse({ type: "exec_output" }).success).toBe(false);
    expect(AgentFrameSchema.safeParse(fixture("logs-task.json")).success).toBe(true);
  });
});

describe("signing-key rollover", () => {
  const key = (kid: string) => ({ kid, public_key: `${"Q".repeat(43)}=`, not_before: 1 });

  it("bounds and dedupes announced keys", () => {
    const announce = payload("signed-key-announce.json");
    expect(KeyAnnounceSchema.safeParse({ ...announce, keys: [] }).success).toBe(false);
    expect(KeyAnnounceSchema.safeParse({ ...announce, keys: [key("a"), key("a")] }).success).toBe(
      false,
    );
    expect(
      KeyAnnounceSchema.safeParse({ ...announce, keys: [key("a"), key("b"), key("c")] }).success,
    ).toBe(false);
    expect(
      KeyAnnounceSchema.safeParse({ ...announce, keys: [{ ...key("a"), not_before: 0 }] }).success,
    ).toBe(false);
    expect(
      KeyAnnounceSchema.safeParse({ ...announce, keys: [{ ...key("a"), public_key: "AAAA" }] })
        .success,
    ).toBe(false);
    expect(KeyAnnounceSchema.safeParse({ ...announce, keys: [key("bad kid")] }).success).toBe(
      false,
    );
    const welcome = payload("signed-welcome-next-keys.json");
    expect(WelcomeSchema.safeParse({ ...welcome, next_keys: [key("a"), key("a")] }).success).toBe(
      false,
    );
  });

  it("rejects a frame announcing its own signing kid", async () => {
    const keys = await generateSigningKey();
    const signer = await importSigningKey(keys.privateKey);
    const announce: ControlMessage = { type: "key_announce", ...header, keys: [key("k1")] };
    expect(announcesSigningKid("k1", announce)).toBe(true);
    expect(announcesSigningKid("k0", announce)).toBe(false);
    const self = await signEnvelope(announce, signer, "k1");
    expect(await verifyEnvelope(EnvelopeSchema.parse(self), keys.publicKey, "node_a", IAT)).toEqual(
      {
        ok: false,
        reason: "malformed",
      },
    );
    const welcome: ControlMessage = {
      type: "welcome",
      ...header,
      heartbeat_interval_ms: 1000,
      next_keys: [key("k1")],
    };
    const selfWelcome = await signEnvelope(welcome, signer, "k1");
    expect((await verifyEnvelope(selfWelcome, keys.publicKey, "node_a", IAT)).ok).toBe(false);
    const fine = await signEnvelope(announce, signer, "k0");
    expect((await verifyEnvelope(fine, keys.publicKey, "node_a", IAT)).ok).toBe(true);
  });
});
