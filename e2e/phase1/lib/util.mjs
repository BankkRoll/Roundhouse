/**
 * Small helpers shared by the Phase 1 harness: logging, deadline polling and
 * process execution. Nothing here sleeps for a fixed time to "let things
 * settle"; every wait is a poll for an observable condition with a deadline.
 *
 * @module
 */
import { execFile, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Repository root. */
export const ROOT = resolve(import.meta.dirname, "..", "..", "..");

/** Where logs, evidence and diagnostics of a run are written. */
export const ARTIFACTS = join(ROOT, "e2e", "phase1", ".artifacts");

/** Whether the host is Windows (Docker Desktop, `.cmd` shims). */
export const isWindows = process.platform === "win32";

const started = Date.now();

/**
 * Prints a progress line prefixed with the elapsed run time.
 *
 * @param {string} scope - Short tag, e.g. `stack` or `step 4`.
 * @param {string} msg - What is happening.
 */
export function log(scope, msg) {
  const t = ((Date.now() - started) / 1000).toFixed(1).padStart(6);
  console.log(`[${t}s] [${scope}] ${msg}`);
}

/**
 * Resolves after `ms`. Only for poll intervals, never as a synchronisation
 * mechanism.
 *
 * @param {number} ms - Milliseconds.
 * @returns {Promise<void>}
 */
export function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Polls `fn` until it returns a truthy value or the deadline passes.
 *
 * @template T
 * @param {string} what - Description used in the timeout error.
 * @param {() => Promise<T | undefined | null | false> | T | undefined | null | false} fn - Probe;
 *   thrown errors count as "not yet" and the last one is reported on timeout.
 * @param {{ timeoutMs: number, intervalMs?: number, explain?: () => Promise<string> | string }} opts
 *   - `explain` adds context (e.g. the current status) to the timeout error.
 * @returns {Promise<T>} The first truthy value.
 * @throws When the deadline passes.
 */
export async function waitFor(what, fn, { timeoutMs, intervalMs = 500, explain }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  let lastValue;
  for (;;) {
    try {
      lastValue = await fn();
      if (lastValue) return lastValue;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) {
      let context = "";
      try {
        context = explain ? ` (${await explain()})` : "";
      } catch {
        // Context is best effort.
      }
      const last = lastError ? `; last error: ${lastError.message}` : "";
      throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}${context}${last}`);
    }
    await delay(intervalMs);
  }
}

/**
 * Runs a command to completion and captures its output.
 *
 * @param {string} cmd - Executable.
 * @param {string[]} args - Arguments (no shell parsing).
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, input?: string, allowFail?: boolean,
 *   timeoutMs?: number, shell?: boolean }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 * @throws When the command exits non-zero, unless `allowFail`.
 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        maxBuffer: 64 * 1024 * 1024,
        timeout: opts.timeoutMs ?? 0,
        shell: opts.shell ?? false,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        const result = { code, stdout: String(stdout), stderr: String(stderr) };
        if (code !== 0 && !opts.allowFail) {
          const detail = (result.stderr || result.stdout).trim().split("\n").slice(-15).join("\n");
          reject(new Error(`${cmd} ${args.join(" ")} exited ${code}:\n${detail}`));
        } else resolvePromise(result);
      },
    );
    if (opts.input !== undefined) child.stdin.end(opts.input);
  });
}

/**
 * Runs a command with its output streamed to this process, for long builds
 * whose progress is worth seeing.
 *
 * @param {string} cmd - Executable.
 * @param {string[]} args - Arguments.
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, shell?: boolean }} [opts]
 * @returns {Promise<void>}
 * @throws When the command exits non-zero.
 */
export function runInherit(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: "inherit",
      shell: opts.shell ?? false,
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`)),
    );
  });
}

/**
 * Writes a file under {@link ARTIFACTS}.
 *
 * @param {string} name - File name.
 * @param {string | object} content - Text, or a value to write as JSON.
 * @returns {string} The file's path.
 */
export function writeArtifact(name, content) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const path = join(ARTIFACTS, name);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return path;
}

/**
 * A random lowercase alphanumeric string.
 *
 * @param {number} n - Length.
 * @returns {string}
 */
export function randomId(n = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < n; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
