/**
 * Web shell frames (ADR 0012 "Web shell", bound by ADR 0014 §15), from
 * `EXEC_PROTOCOL_VERSION`. The control plane's node Durable Object relays a
 * browser or CLI terminal to one exec process the agent starts inside one of
 * its own workload containers. Mirrored by `go/exec.go`.
 *
 * - Control → agent: `exec_open`, `exec_input`, `exec_resize`,
 *   `exec_close`. Every one is short-lived (`CREDENTIAL_FRAME_TTL_MS`), and
 *   input travels sealed to the node (`exec-input` boxes), since keystrokes
 *   include passwords typed at prompts.
 * - Agent → control: `exec_opened`, `exec_output`, `exec_exit`.
 *
 * SECURITY (ADR 0014 §15):
 * - `command` is an argv array, never a shell string: neither side joins it.
 *   The default wrapper is the fixed {@link DEFAULT_EXEC_COMMAND}.
 * - There is no user override: the process runs as the container's own
 *   configured user, never privileged and with no added capabilities.
 * - The agent execs only into containers carrying its own namespace label
 *   and the frame's `workload_id`, never into system containers.
 * - Terminal input and output are never logged or audited.
 *
 * @module
 */
import { z } from "zod";
import { SealedBoxSchema } from "./box";
import { ControlHeader, isShortLived, SHORT_LIVED_ISSUE } from "./control";
import {
  base64Bytes,
  boundedString,
  IdString,
  MAX_EXEC_ARGS,
  MAX_EXEC_COLS,
  MAX_EXEC_COMMAND_BYTES,
  MAX_EXEC_ENV_VALUE_BYTES,
  MAX_EXEC_ENV_VARS,
  MAX_EXEC_IDLE_TIMEOUT_S,
  MAX_EXEC_MAX_DURATION_S,
  MAX_EXEC_OUTPUT_BYTES,
  MAX_EXEC_ROWS,
  MAX_MESSAGE_BYTES,
  MIN_EXEC_IDLE_TIMEOUT_S,
  MIN_EXEC_MAX_DURATION_S,
  utf8ByteLength,
} from "./limits";

/**
 * The command a session runs when the caller names none: a login bash when
 * the image has one, else a login sh. A fixed constant, so no user text is
 * ever interpreted by a shell the control plane or agent builds.
 */
export const DEFAULT_EXEC_COMMAND = [
  "/bin/sh",
  "-c",
  "command -v bash >/dev/null && exec bash -l || exec sh -l",
] as const;

/** Idle timeout when the caller names none, in seconds (ADR 0012). */
export const DEFAULT_EXEC_IDLE_TIMEOUT_S = 900;

/** Total duration when the caller names none, in seconds (ADR 0012). */
export const DEFAULT_EXEC_MAX_DURATION_S = 28_800;

/**
 * Environment variables an `exec_open` may set. Only terminal settings: a
 * session must not change how the container's own programs load
 * (`LD_PRELOAD`, `PATH`), even though its user could do so by hand.
 */
export const EXEC_ENV_KEYS = ["TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE"] as const;

/**
 * Whether an argv array is within the exec limits: 1 to `MAX_EXEC_ARGS`
 * entries, no NUL bytes, at most `MAX_EXEC_COMMAND_BYTES` in total, and a
 * non-empty program.
 *
 * @param argv - The command.
 * @returns `true` when the agent would accept it.
 * @example
 * isValidExecCommand(["/bin/sh", "-c", "ls"]); // true
 * isValidExecCommand(["rm -rf /"]); // true: one argv entry, run as a program name
 */
export function isValidExecCommand(argv: readonly string[]): boolean {
  if (argv.length < 1 || argv.length > MAX_EXEC_ARGS || !argv[0]) return false;
  let total = 0;
  for (const a of argv) {
    if (a.includes("\0")) return false;
    total += utf8ByteLength(a);
  }
  return total <= MAX_EXEC_COMMAND_BYTES;
}

/** Terminal columns. */
const Cols = z.number().int().min(1).max(MAX_EXEC_COLS);

/** Terminal rows. */
const Rows = z.number().int().min(1).max(MAX_EXEC_ROWS);

/**
 * Starts one interactive process in a workload's container, answered by
 * `exec_opened` or an `exec_exit` with reason `error`.
 */
export const ExecOpenSchema = z
  .object({
    type: z.literal("exec_open"),
    ...ControlHeader,
    /** `shl_…`, unique per session; a repeated ID is refused. */
    session_id: IdString,
    /** A service workload this node runs. */
    workload_id: IdString,
    /** argv; see {@link isValidExecCommand}. */
    command: z.array(z.string()).refine(isValidExecCommand, {
      message: `command must be 1 to ${MAX_EXEC_ARGS} arguments of at most ${MAX_EXEC_COMMAND_BYTES} bytes in total, without NUL`,
    }),
    /** Always a TTY: the relay speaks to terminals only. */
    tty: z.literal(true),
    cols: Cols,
    rows: Rows,
    env: z
      .partialRecord(z.enum(EXEC_ENV_KEYS), boundedString(MAX_EXEC_ENV_VALUE_BYTES))
      .refine((e) => Object.keys(e).length <= MAX_EXEC_ENV_VARS, {
        message: `at most ${MAX_EXEC_ENV_VARS} variables`,
      }),
    /** Seconds without input before the agent closes the session. */
    idle_timeout_s: z.number().int().min(MIN_EXEC_IDLE_TIMEOUT_S).max(MAX_EXEC_IDLE_TIMEOUT_S),
    /** Seconds after open before the agent closes the session. */
    max_duration_s: z.number().int().min(MIN_EXEC_MAX_DURATION_S).max(MAX_EXEC_MAX_DURATION_S),
  })
  .refine(isShortLived, SHORT_LIVED_ISSUE);

/** Starts one interactive process in a workload's container. */
export type ExecOpen = z.infer<typeof ExecOpenSchema>;

/**
 * One batch of terminal input. The agent applies batches in `seq` order
 * (0, 1, 2, …) and drops duplicates and anything after a gap, closing the
 * session with reason `error`: a lost keystroke must not be skipped over.
 */
export const ExecInputSchema = z
  .object({
    type: z.literal("exec_input"),
    ...ControlHeader,
    session_id: IdString,
    seq: z.number().int().nonnegative(),
    /** `SealedExecInputSchema` under `execInputAad(node, session, seq)`. */
    data_sealed: SealedBoxSchema,
  })
  .refine(isShortLived, SHORT_LIVED_ISSUE);

/** One batch of terminal input. */
export type ExecInput = z.infer<typeof ExecInputSchema>;

/** Resizes a session's terminal. */
export const ExecResizeSchema = z
  .object({
    type: z.literal("exec_resize"),
    ...ControlHeader,
    session_id: IdString,
    cols: Cols,
    rows: Rows,
  })
  .refine(isShortLived, SHORT_LIVED_ISSUE);

/** Resizes a session's terminal. */
export type ExecResize = z.infer<typeof ExecResizeSchema>;

/**
 * Why the control plane closes a session: the person closed it (or their
 * browser left for 30 s), it sat idle, access was revoked, the control plane
 * is shutting the relay down, or it reached its maximum duration.
 */
export const EXEC_CLOSE_REASONS = ["user", "idle", "revoked", "shutdown", "max_duration"] as const;

/** Why the control plane closes a session; see {@link EXEC_CLOSE_REASONS}. */
export type ExecCloseReason = (typeof EXEC_CLOSE_REASONS)[number];

/**
 * Ends a session. The agent sends SIGHUP to the exec process, SIGKILL after
 * 5 s, and answers with `exec_exit` (reason `closed`). A close for an
 * unknown session is ignored.
 */
export const ExecCloseSchema = z
  .object({
    type: z.literal("exec_close"),
    ...ControlHeader,
    session_id: IdString,
    reason: z.enum(EXEC_CLOSE_REASONS),
  })
  .refine(isShortLived, SHORT_LIVED_ISSUE);

/** Ends a session. */
export type ExecClose = z.infer<typeof ExecCloseSchema>;

/** The process started; output follows. */
export const ExecOpenedSchema = z.object({
  type: z.literal("exec_opened"),
  session_id: IdString,
  /** The user the process runs as (the container's configured user, `root` when unset). */
  user: boundedString(256, 1),
});

/** The process started. */
export type ExecOpened = z.infer<typeof ExecOpenedSchema>;

/**
 * Terminal output, coalesced every 20 ms. `seq` starts at 0 and rises by
 * one per frame, so the relay can tell a dropped frame.
 */
export const ExecOutputSchema = z.object({
  type: z.literal("exec_output"),
  session_id: IdString,
  seq: z.number().int().nonnegative(),
  data: base64Bytes(MAX_EXEC_OUTPUT_BYTES),
});

/** Terminal output. */
export type ExecOutput = z.infer<typeof ExecOutputSchema>;

/**
 * Why a session ended, from the agent's side:
 * - `exited`: the process exited by itself (`exit_code` set);
 * - `closed`: an `exec_close` ended it;
 * - `idle_timeout`, `max_duration`: the agent's own timers;
 * - `error`: it could not start, or broke (`message` says why), including
 *   refusals: an unknown or system workload, a full node, a gap in input.
 */
export const EXEC_EXIT_REASONS = [
  "exited",
  "closed",
  "idle_timeout",
  "max_duration",
  "error",
] as const;

/** Why a session ended; see {@link EXEC_EXIT_REASONS}. */
export type ExecExitReason = (typeof EXEC_EXIT_REASONS)[number];

/** A session ended. Sent once per session; later frames for it are ignored. */
export const ExecExitSchema = z
  .object({
    type: z.literal("exec_exit"),
    session_id: IdString,
    /** The process's exit code, when it exited and it is known. */
    exit_code: z.number().int().min(-1).max(255).nullable(),
    reason: z.enum(EXEC_EXIT_REASONS),
    message: boundedString(MAX_MESSAGE_BYTES).optional(),
  })
  .refine((m) => m.reason !== "exited" || m.exit_code !== null, {
    message: "an exited session has an exit code",
    path: ["exit_code"],
  });

/** A session ended. */
export type ExecExit = z.infer<typeof ExecExitSchema>;
