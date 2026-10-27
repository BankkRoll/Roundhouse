/**
 * Web shell recording (ADR 0012 "Recording"): with `shell_recording = full`
 * a session's output, input and resizes become an asciicast that leaves the
 * node's Durable Object only gzipped and age-encrypted to the project's
 * recipient, in parts; its plaintext chunks live in Durable Object storage
 * until then and are deleted after. `metadata` records nothing. Playback
 * needs `audit:read`, `shell:open` and a fresh browser session, and is
 * audited without terminal data.
 */
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { createDb } from "@roundhouse/db";
import { type Asciicast, parseAsciicast } from "@roundhouse/shared";
import { describe, expect, it } from "vitest";
import type { RecordingLimits } from "../src/durable/node/recording";
import type { NodeConnection } from "../src/durable/node-connection";
import { ageDecrypt } from "../src/lib/age-file";
import { loadBackupIdentity } from "../src/lib/backups/keys";
import { addMember, eventually, ORIGIN } from "./helpers";
import {
  auditOf,
  createToken,
  isExec,
  nodeStub,
  openedShell,
  type ShellStage,
  sessionRow,
  shellStage,
} from "./shell-helpers";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const encoder = new TextEncoder();

/** Changes the recorder's limits in the node's Durable Object. */
async function setLimits(s: ShellStage, limits: Partial<RecordingLimits>) {
  await runInDurableObject(nodeStub(s.nodeId), async (instance: NodeConnection) => {
    const relay = (instance as unknown as { shell: { recorder: { limits: RecordingLimits } } })
      .shell;
    Object.assign(relay.recorder.limits, limits);
  });
}

/** The node Durable Object's storage keys with a prefix. */
async function storageKeys(s: ShellStage, prefix: string): Promise<string[]> {
  return runInDurableObject(nodeStub(s.nodeId), async (_instance, state) => [
    ...(await state.storage.list({ prefix })).keys(),
  ]);
}

async function recordingObjects(projectId: string) {
  return (await env.LOGS.list({ prefix: `shell/${projectId}/` })).objects;
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/** Decrypts one stored part with the project's age identity, as `age -d` would. */
async function decryptPart(projectId: string, key: string): Promise<string> {
  const identity = await loadBackupIdentity(createDb(env.DB), env, projectId);
  if (!identity) throw new Error("no identity");
  const object = await env.LOGS.get(key);
  if (!object) throw new Error(`no object ${key}`);
  return gunzip(await ageDecrypt(identity, new Uint8Array(await object.arrayBuffer())));
}

async function waitForRecording(sessionId: string, state = "stored") {
  return eventually(async () => {
    const row = await sessionRow(sessionId);
    return row?.recording === state ? row : undefined;
  }, 8000);
}

function output(s: ShellStage, sessionId: string, bytes: Uint8Array | string) {
  const data = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  s.agent.send({
    type: "exec_output",
    session_id: sessionId,
    seq: 0,
    data: btoa(String.fromCharCode(...data)),
  });
}

function exit(s: ShellStage, sessionId: string) {
  s.agent.send({ type: "exec_exit", session_id: sessionId, exit_code: 0, reason: "exited" });
}

function textOf(cast: Asciicast, kind: "o" | "i" | "r"): string[] {
  return cast.events.filter(([, k]) => k === kind).map(([, , text]) => text);
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// -----------------------------------------------------------------------------
// Recording
// -----------------------------------------------------------------------------

describe("shell recording", () => {
  it("stores an encrypted asciicast of input, output and resizes, and keeps it out of logs", async () => {
    const s = await shellStage();
    await setLimits(s, { flushMs: 20 });
    const { term, sessionId } = await openedShell(s, s.owner, "?cols=120&rows=40&term=xterm");
    expect(term.texts.find((m) => m.type === "opened")).toMatchObject({ recorded: true });
    expect((await sessionRow(sessionId))?.recording).toBe("recording");
    expect(await storageKeys(s, `recmeta:${sessionId}`)).toHaveLength(1);

    term.ws.send(encoder.encode("typed-secret-1"));
    await s.agent.waitFor(isExec("exec_input", sessionId));
    term.ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    await s.agent.waitFor(isExec("exec_resize", sessionId));
    output(s, sessionId, "printed-output-secret ");
    // "é" split across two frames still decodes as one character.
    output(s, sessionId, Uint8Array.of(0xc3));
    output(s, sessionId, Uint8Array.of(0xa9));
    await eventually(async () => (term.output.length >= 3 ? true : undefined));

    // Mid-session the plaintext is in Durable Object storage, not only in memory.
    const chunks = await eventually(async () => {
      const keys = await storageKeys(s, `rec:${sessionId}:`);
      return keys.length ? keys : undefined;
    });
    expect(chunks[0]).toMatch(new RegExp(`^rec:${sessionId}:0001:`));
    expect(await recordingObjects(s.projectId)).toEqual([]);

    exit(s, sessionId);
    await term.closed;
    const row = await waitForRecording(sessionId);
    expect(row).toMatchObject({ recording: "stored", recording_parts: 1 });

    const objects = await recordingObjects(s.projectId);
    expect(objects).toHaveLength(1);
    const at = new Date(row.started_at as number);
    const month = String(at.getUTCMonth() + 1).padStart(2, "0");
    expect(objects[0]!.key).toBe(
      `shell/${s.projectId}/${at.getUTCFullYear()}/${month}/${sessionId}.1.cast.gz.age`,
    );
    expect(row.recording_bytes).toBe(objects[0]!.size);

    const stored = new Uint8Array(await (await env.LOGS.get(objects[0]!.key))!.arrayBuffer());
    expect(new TextDecoder().decode(stored.subarray(0, 21))).toBe("age-encryption.org/v1");
    expect(new TextDecoder().decode(stored)).not.toContain("printed-output-secret");

    const cast = parseAsciicast(await decryptPart(s.projectId, objects[0]!.key));
    expect(cast.header).toMatchObject({
      version: 2,
      width: 120,
      height: 40,
      env: { TERM: "xterm" },
    });
    expect(Math.abs(cast.header.timestamp! * 1000 - (row.started_at as number))).toBeLessThan(5000);
    expect(textOf(cast, "i").join("")).toBe("typed-secret-1");
    expect(textOf(cast, "r")).toEqual(["100x30"]);
    expect(textOf(cast, "o").join("")).toBe("printed-output-secret é");
    const times = cast.events.map(([t]) => t);
    expect(times).toEqual([...times].sort((a, b) => a - b));

    // Plaintext and meta are gone from the Durable Object.
    expect(await storageKeys(s, `rec:${sessionId}:`)).toEqual([]);
    expect(await storageKeys(s, `recmeta:${sessionId}`)).toEqual([]);

    const everything = JSON.stringify(
      (await env.DB.prepare("SELECT * FROM audit_logs").all()).results,
    );
    for (const secret of ["typed-secret", "printed-output-secret"]) {
      expect(everything).not.toContain(secret);
    }
    const opened = JSON.parse((await auditOf("shell.opened"))[0]!.metadata!);
    expect(opened.recorded).toBe(true);
  });

  it("cuts parts at the part size and stores each one", async () => {
    const s = await shellStage();
    await setLimits(s, { partBytes: 300, flushBytes: 100, flushMs: 20 });
    const { term, sessionId } = await openedShell(s, s.owner);
    const lines = Array.from(
      { length: 12 },
      (_, i) => `line-${String(i).padStart(2, "0")}-${"x".repeat(40)}\r\n`,
    );
    for (const line of lines) {
      output(s, sessionId, line);
      await pause(5);
    }
    await eventually(async () => (term.output.length >= lines.length ? true : undefined));
    // Earlier parts are stored while the session is still open.
    await eventually(async () => ((await recordingObjects(s.projectId)).length ? true : undefined));
    exit(s, sessionId);
    const row = await waitForRecording(sessionId);
    const parts = row.recording_parts as number;
    expect(parts).toBeGreaterThanOrEqual(2);
    const keys = (await recordingObjects(s.projectId)).map((o) => o.key).sort();
    expect(keys).toHaveLength(parts);
    let joined = "";
    for (let part = 1; part <= parts; part++) {
      const key = keys.find((k) => k.endsWith(`/${sessionId}.${part}.cast.gz.age`));
      expect(key, `part ${part}`).toBeDefined();
      const cast = parseAsciicast(await decryptPart(s.projectId, key!));
      joined += textOf(cast, "o").join("");
    }
    expect(joined).toBe(lines.join(""));
    expect(await storageKeys(s, `rec:${sessionId}:`)).toEqual([]);

    // Playback joins the parts under one header.
    const res = await s.owner.request(`/v1/shell-sessions/${sessionId}/recording`);
    expect(res.status).toBe(200);
    const text = new TextDecoder().decode(await res.arrayBuffer());
    expect(text.split("\n").filter((l) => l.startsWith('{"version":2'))).toHaveLength(1);
    expect(textOf(parseAsciicast(text), "o").join("")).toBe(lines.join(""));
  });

  it("records nothing in metadata mode", async () => {
    const s = await shellStage();
    const patch = await s.owner.request("/v1/instance/settings", {
      method: "PATCH",
      json: { shell_recording: "metadata" },
    });
    expect(patch.status).toBe(200);
    const { term, sessionId } = await openedShell(s, s.owner);
    expect(term.texts.find((m) => m.type === "opened")).toMatchObject({ recorded: false });
    term.ws.send(encoder.encode("typed-secret"));
    output(s, sessionId, "printed-output-secret");
    await eventually(async () => (term.output.length ? true : undefined));
    exit(s, sessionId);
    await term.closed;
    const row = await eventually(async () => {
      const r = await sessionRow(sessionId);
      return r?.ended_at ? r : undefined;
    });
    expect(row).toMatchObject({ recording: "none", recording_parts: 0 });
    expect(await recordingObjects(s.projectId)).toEqual([]);
    expect(await storageKeys(s, "rec")).toEqual([]);
    expect((await s.owner.request(`/v1/shell-sessions/${sessionId}/recording`)).status).toBe(404);
  });

  it("opens unrecorded when the project has no key", async () => {
    const s = await shellStage();
    await env.DB.prepare("DELETE FROM project_keys WHERE project_id = ?").bind(s.projectId).run();
    const { term, sessionId } = await openedShell(s, s.owner);
    expect(term.texts.find((m) => m.type === "opened")).toMatchObject({ recorded: false });
    expect((await sessionRow(sessionId))?.recording).toBe("none");
    term.ws.close();
  });
});

// -----------------------------------------------------------------------------
// Playback
// -----------------------------------------------------------------------------

describe("shell recording playback", () => {
  it("needs audit:read, shell:open and a fresh browser session, and is audited", async () => {
    const s = await shellStage();
    const { term, sessionId } = await openedShell(s, s.owner);
    term.ws.send(encoder.encode("typed-secret"));
    await s.agent.waitFor(isExec("exec_input", sessionId));
    output(s, sessionId, "printed-output-secret");
    await eventually(async () => (term.output.length ? true : undefined));
    exit(s, sessionId);
    await waitForRecording(sessionId);
    const path = `/v1/shell-sessions/${sessionId}/recording`;

    const list = await s.owner.json<{ sessions: Record<string, unknown>[] }>(
      `/v1/workspaces/${s.workspaceId}/shell-sessions`,
    );
    expect(list.body.sessions[0]).toMatchObject({
      id: sessionId,
      recording: "stored",
      recording_parts: 1,
    });

    const member = await addMember(s.owner, s.workspaceId, "dev@example.com", "member");
    const forbidden = await member.request(path);
    expect(forbidden.status).toBe(403);
    expect(((await forbidden.json()) as { error: { code: string } }).error.code).toBe("forbidden");

    const admin = await addMember(s.owner, s.workspaceId, "admin@example.com", "admin");
    const adminUser = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
      .bind("admin@example.com")
      .first<{ id: string }>();
    await env.DB.prepare(
      "UPDATE sessions SET created_at = ?, reauthenticated_at = NULL WHERE user_id = ?",
    )
      .bind(Date.now() - 11 * 60 * 1000, adminUser!.id)
      .run();
    const stale = await admin.request(path);
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({
      error: { code: "reauth_required", details: [{ code: "session_stale" }] },
    });

    const token = await createToken(s.owner, s.workspaceId, ["audit:read", "shell:open"]);
    const viaToken = await SELF.fetch(`${ORIGIN}${path}`, {
      headers: { authorization: `Bearer ${token.bearer}` },
    });
    expect(viaToken.status).toBe(403);
    expect(await viaToken.json()).toMatchObject({
      error: { code: "reauth_required", details: [{ code: "api_token" }] },
    });
    expect(await auditOf("shell.recording_viewed")).toEqual([]);

    await env.DB.prepare("UPDATE sessions SET created_at = ? WHERE user_id = ?")
      .bind(Date.now(), adminUser!.id)
      .run();
    const res = await admin.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/x-asciicast/);
    expect(res.headers.get("cache-control")).toMatch(/^no-store(,|$)/);
    const cast = parseAsciicast(new TextDecoder().decode(await res.arrayBuffer()));
    expect(textOf(cast, "i").join("")).toBe("typed-secret");
    expect(textOf(cast, "o").join("")).toBe("printed-output-secret");

    const viewed = await auditOf("shell.recording_viewed");
    expect(viewed).toHaveLength(1);
    expect(viewed[0]!.target_id).toBe(sessionId);
    expect(JSON.parse(viewed[0]!.metadata!)).toEqual({
      project_id: s.projectId,
      environment_id: s.envId,
      service_id: s.serviceId,
      user_id: s.installed.userId,
    });
    const everything = JSON.stringify(
      (await env.DB.prepare("SELECT * FROM audit_logs").all()).results,
    );
    expect(everything).not.toContain("typed-secret");
    expect(everything).not.toContain("printed-output-secret");

    expect((await s.owner.request("/v1/shell-sessions/shl_missing/recording")).status).toBe(404);
  });

  it("is a 404 while a session is still being recorded", async () => {
    const s = await shellStage();
    const { term, sessionId } = await openedShell(s, s.owner);
    expect((await s.owner.request(`/v1/shell-sessions/${sessionId}/recording`)).status).toBe(404);
    term.ws.close();
  });
});

// -----------------------------------------------------------------------------
// Lost sessions
// -----------------------------------------------------------------------------

describe("shell recording after an eviction", () => {
  it("stores what reached storage for a session whose socket is gone", async () => {
    const s = await shellStage();
    // A session made the project's recipient; a lost one left chunks behind.
    const { term } = await openedShell(s, s.owner);
    term.ws.close();
    const sessionId = "shl_lost";
    const started = Date.now() - 60_000;
    await env.DB.prepare(
      "INSERT INTO shell_sessions (id, workspace_id, project_id, environment_id, service_id, workload_id, replica, command, started_at, ended_at, recording, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 'sh', ?, ?, 'recording', ?, ?)",
    )
      .bind(
        sessionId,
        s.workspaceId,
        s.projectId,
        s.envId,
        s.serviceId,
        s.workloadId,
        started,
        started + 1000,
        started,
        started,
      )
      .run();
    const key = (await env.DB.prepare(
      "SELECT backup_recipient AS r FROM project_keys WHERE project_id = ?",
    )
      .bind(s.projectId)
      .first<{ r: string }>())!.r;
    const swept = await runInDurableObject(
      nodeStub(s.nodeId),
      async (instance: NodeConnection, state) => {
        await state.storage.put({
          [`recmeta:${sessionId}`]: {
            session_id: sessionId,
            project_id: s.projectId,
            recipient: key,
            started_at: started,
            header: JSON.stringify({ version: 2, width: 80, height: 24 }),
          },
          [`rec:${sessionId}:0001:00000000`]: encoder.encode(
            `${JSON.stringify([0.1, "o", "lost-output"])}\n`,
          ),
        });
        const relay = (
          instance as unknown as {
            shell: { recorder: { sweep(live: ReadonlySet<string>): Promise<number> } };
          }
        ).shell;
        return relay.recorder.sweep(new Set());
      },
    );
    expect(swept).toBe(1);
    const row = await sessionRow(sessionId);
    expect(row).toMatchObject({ recording: "stored", recording_parts: 1 });
    const objects = (await recordingObjects(s.projectId)).filter((o) => o.key.includes(sessionId));
    expect(objects).toHaveLength(1);
    const cast = parseAsciicast(await decryptPart(s.projectId, objects[0]!.key));
    expect(textOf(cast, "o")).toEqual(["lost-output"]);
    expect(await storageKeys(s, `rec:${sessionId}:`)).toEqual([]);
    expect(await storageKeys(s, `recmeta:${sessionId}`)).toEqual([]);
  });
});
