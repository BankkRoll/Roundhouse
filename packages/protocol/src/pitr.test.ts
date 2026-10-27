import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentFrameSchema,
  BackupJobSchema,
  BackupResultSchema,
  ControlMessageSchema,
  CREDENTIAL_FRAME_TTL_MS,
  carriesCredentials,
  DesiredStateSchema,
  nextWalSegment,
  openBox,
  PITR_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  postgresArchiveArgs,
  RestoreJobSchema,
  SealedWalFilesSchema,
  SealedWalUploadsSchema,
  WAL_FILE_RE,
  WalArchiveSchema,
  WalFetchRequestSchema,
  walFetchAad,
  walTimeline,
  walUploadAad,
} from "./index";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, "..", "fixtures", name), "utf8"));

// biome-ignore lint/suspicious/noExplicitAny: fixture payloads are checked by the schema first.
const payload = (name: string): any => {
  const f = fixture(name) as { envelope: { payload: string } };
  return ControlMessageSchema.parse(JSON.parse(f.envelope.payload));
};

const IAT = 1_700_000_000_000;

const nodeKey = () => {
  const box = fixture("sealed-box.json") as { node_id: string; node_private_key_hex: string };
  return { node: box.node_id, key: Uint8Array.from(Buffer.from(box.node_private_key_hex, "hex")) };
};

const decode = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

describe("point-in-time recovery frames (protocol 8)", () => {
  it("puts them at 8", () => {
    expect(PITR_PROTOCOL_VERSION).toBe(8);
    expect(PROTOCOL_VERSION).toBe(8);
  });

  it("accepts every file archive_command archives and no path", () => {
    for (const ok of [
      "000000010000000000000002",
      "000000010000000000000002.partial",
      "000000010000000000000002.00000028.backup",
      "00000002.history",
    ]) {
      expect(WAL_FILE_RE.test(ok)).toBe(true);
    }
    for (const bad of [
      "../000000010000000000000002",
      "000000010000000000000002/x",
      "00000001000000000000000g",
      "archive_status",
      "000000010000000000000002.tmp",
      "",
    ]) {
      expect(WAL_FILE_RE.test(bad)).toBe(false);
    }
  });

  it("counts segments across a log boundary", () => {
    expect(nextWalSegment("000000010000000000000002")).toBe("000000010000000000000003");
    expect(nextWalSegment("0000000100000000000000FF")).toBe("000000010000000100000000");
    expect(walTimeline("00000002000000000000000A")).toBe("00000002");
    expect(() => nextWalSegment("00000002.history")).toThrow();
  });

  it("gives the ack and the fetch the credential TTL and opens their boxes", async () => {
    const { node, key } = nodeKey();
    const ack = payload("signed-wal-archive-ack.json");
    const fetch = payload("signed-wal-fetch.json");
    for (const m of [ack, fetch]) {
      expect(carriesCredentials(m)).toBe(true);
      expect(
        ControlMessageSchema.safeParse({ ...m, exp: IAT + CREDENTIAL_FRAME_TTL_MS + 1 }).success,
      ).toBe(false);
    }
    const uploads = SealedWalUploadsSchema.parse(
      decode(
        await openBox(key, ack.uploads_sealed, "wal-upload", walUploadAad(node, ack.stream_id)),
      ),
    );
    expect(uploads.uploads.map((u) => u.name)).toEqual([
      "000000010000000000000003",
      "00000002.history",
    ]);
    await expect(
      openBox(key, ack.uploads_sealed, "wal-upload", walUploadAad(node, "wal_other")),
    ).rejects.toThrow();
    const files = SealedWalFilesSchema.parse(
      decode(
        await openBox(key, fetch.files_sealed, "wal-fetch", walFetchAad(node, fetch.restore_id)),
      ),
    );
    expect(files.files.map((f) => f.index)).toEqual([1, 2]);
    await expect(
      openBox(key, fetch.files_sealed, "wal-upload", walFetchAad(node, fetch.restore_id)),
    ).rejects.toThrow();
  });

  it("ties base backups to Postgres and pitr to base restores", () => {
    const job = payload("signed-backup-job-base.json");
    expect(BackupJobSchema.safeParse(job).success).toBe(true);
    expect(BackupJobSchema.safeParse({ ...job, engine: "mysql" }).success).toBe(false);
    expect(BackupJobSchema.safeParse({ ...job, databases: ["app"] }).success).toBe(false);
    expect(BackupJobSchema.safeParse({ ...job, quiesce: "stop" }).success).toBe(false);

    const restore = payload("signed-restore-job-base.json");
    expect(RestoreJobSchema.safeParse(restore).success).toBe(true);
    const { pitr: _pitr, ...withoutPitr } = restore;
    expect(RestoreJobSchema.safeParse(withoutPitr).success).toBe(false);
    expect(RestoreJobSchema.safeParse({ ...restore, method: "dump" }).success).toBe(false);
    for (const pitr of [
      { target_time: null, wal_files: 3, wal_end: null },
      { target_time: IAT, wal_files: 0, wal_end: null },
      { target_time: null, wal_files: 1, wal_end: "00000002.history" },
    ]) {
      expect(RestoreJobSchema.safeParse({ ...restore, pitr }).success).toBe(false);
    }
    expect(
      RestoreJobSchema.safeParse({
        ...restore,
        pitr: { target_time: null, wal_files: 0, wal_end: null },
      }).success,
    ).toBe(true);
  });

  it("validates the agent's reports", () => {
    expect(AgentFrameSchema.parse(fixture("wal-archive.json")).type).toBe("wal_archive");
    expect(AgentFrameSchema.parse(fixture("wal-fetch-request.json")).type).toBe(
      "wal_fetch_request",
    );
    const archive = fixture("wal-archive.json") as Record<string, unknown> & {
      archived: { name: string }[];
    };
    expect(
      WalArchiveSchema.safeParse({ ...archive, pending: [archive.archived[0]!.name] }).success,
    ).toBe(false);
    expect(WalArchiveSchema.safeParse({ ...archive, pending: ["../etc/passwd"] }).success).toBe(
      false,
    );
    expect(
      WalFetchRequestSchema.safeParse({
        ...(fixture("wal-fetch-request.json") as object),
        count: 33,
      }).success,
    ).toBe(false);
    const base = fixture("backup-result-base.json") as Record<string, unknown>;
    expect(BackupResultSchema.safeParse(base).success).toBe(true);
    expect(
      BackupResultSchema.safeParse({
        ...(fixture("backup-result-failed.json") as object),
        wal_start: base.wal_start,
      }).success,
    ).toBe(false);
  });

  it("lists a stream on its volume", () => {
    const m = DesiredStateSchema.parse(payload("signed-desired-state-pitr.json"));
    expect(m.volumes?.[0]?.wal_archive?.stream_id).toMatch(/^wal_/);
  });
});

describe("postgresArchiveArgs", () => {
  it("builds the command go/pitr_test.go pins", () => {
    const d = "/var/lib/postgresql/roundhouse-wal";
    expect(postgresArchiveArgs("/var/lib/postgresql/")).toEqual([
      "-c",
      "archive_mode=on",
      "-c",
      `archive_command=[ -f "${d}/%f" ] || [ -f "${d}/%f.done" ] || { cp "%p" "${d}/.%f.tmp" && sync "${d}/.%f.tmp" && mv "${d}/.%f.tmp" "${d}/%f" && sync "${d}"; }`,
      "-c",
      "archive_timeout=60",
    ]);
  });
});
