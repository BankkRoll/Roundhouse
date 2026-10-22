/**
 * cloud-init user data that joins a fresh server to the control plane at
 * first boot.
 *
 * The generated `#cloud-config`:
 * 1. writes the join token to {@link TOKEN_PATH} (root, 0600, on tmpfs);
 * 2. writes a join script with no secrets in it, and runs it from `runcmd`;
 * 3. the script removes cloud-init's on-disk copies of the user data, so
 *    the token file is the only copy on the machine;
 * 4. downloads `<controlPlaneUrl>/install.sh` with
 *    `curl --proto '=https' --tlsv1.2`;
 * 5. runs it with `--token-file`, `--name`, and `--builder` when requested;
 * 6. shreds the token file on exit, whether the join worked or not.
 *
 * SECURITY: Hetzner serves user data to the server itself at
 * `http://169.254.169.254/hetzner/v1/userdata` for the server's lifetime, so
 * any process on the machine can read the token there until it is used. This
 * is acceptable because the token is single-use and expires 15 minutes after
 * it is minted: the join consumes it within seconds of first boot, before any
 * workload or other user exists on the machine, and a token read later is
 * worthless. The token never appears in a command line, `runcmd`, or the
 * process list.
 *
 * @module
 */
import { ProvisionError } from "./errors";

/** Hetzner's limit for `user_data` (documented on `POST /servers`). */
export const HETZNER_USER_DATA_LIMIT = 32 * 1024;

/** Directory for join files. `/run` is tmpfs, so nothing here reaches disk. */
export const JOIN_DIR = "/run/roundhouse";

/** Where the join token is written; root-only 0600. */
export const TOKEN_PATH = `${JOIN_DIR}/join-token`;

/** Where the join script is written; it holds no secrets. */
export const JOIN_SCRIPT_PATH = `${JOIN_DIR}/join.sh`;

/**
 * cloud-init's root-only copies of the user data, plus the merged config it
 * keeps on tmpfs. The join script removes them before joining.
 */
export const CLOUD_INIT_USER_DATA_COPIES = [
  "/var/lib/cloud/instance/user-data.txt",
  "/var/lib/cloud/instance/user-data.txt.i",
  "/var/lib/cloud/instance/cloud-config.txt",
  "/var/lib/cloud/instance/obj.pkl",
  "/run/cloud-init/combined-cloud-config.json",
] as const;

/** Input to {@link buildUserData}. */
export interface UserDataInput {
  /**
   * Control plane origin, e.g. `https://cp.example.com`. Must be `https://`,
   * except with {@link UserDataInput.allowLoopbackHttp}.
   */
  controlPlaneUrl: string;
  /** Single-use join token from `POST /v1/workspaces/{id}/nodes/join-tokens`. */
  joinToken: string;
  /** Node name: a lowercase DNS label (1-63 of `a-z`, `0-9`, `-`). */
  name: string;
  /** Join as a builder node. Default `false`. */
  builder?: boolean;
  /**
   * DEV ONLY: accept `http://` for a loopback host (`localhost`, `127.0.0.0/8`,
   * `[::1]`). This exists for running the generated user data in a local VM
   * whose loopback is forwarded to a dev control plane; a Hetzner server can
   * never reach your loopback. Mirrors install.sh, which also allows plain
   * HTTP only to loopback.
   */
  allowLoopbackHttp?: boolean;
}

const NODE_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// Join tokens are `njt_` plus base64url (see apps/api randomToken); the
// charset check also keeps the token inert inside YAML.
const JOIN_TOKEN = /^[A-Za-z0-9_-]{16,200}$/;

function invalid(message: string): ProvisionError {
  return new ProvisionError("invalid_input", message);
}

/**
 * Validates a node name: one lowercase RFC 1123 label, which is both a valid
 * Hetzner server name and a valid label value.
 *
 * @param name - Proposed name.
 * @returns The name.
 * @throws ProvisionError `invalid_input`.
 */
export function validateNodeName(name: string): string {
  if (!NODE_NAME.test(name)) {
    throw invalid(
      `node name ${JSON.stringify(name)} must be 1-63 lowercase letters, digits, or hyphens, not starting or ending with a hyphen`,
    );
  }
  return name;
}

/**
 * Validates a join token's shape.
 *
 * @param token - Join token.
 * @returns The token.
 * @throws ProvisionError `invalid_input`.
 */
export function validateJoinToken(token: string): string {
  if (!JOIN_TOKEN.test(token)) throw invalid("join token is malformed");
  return token;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * Validates the control plane URL and reduces it to its origin.
 *
 * @param url - Control plane URL.
 * @param options - `allowLoopbackHttp` for local development.
 * @returns The origin, e.g. `https://cp.example.com`.
 * @throws ProvisionError `invalid_input` for non-HTTPS, credentials, a path,
 *   a query, or a fragment.
 */
export function validateControlPlaneUrl(
  url: string,
  options: { allowLoopbackHttp?: boolean } = {},
): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw invalid(`control plane URL ${JSON.stringify(url)} is not a URL`);
  }
  if (u.protocol === "http:") {
    if (!(options.allowLoopbackHttp && isLoopback(u.hostname))) {
      // SECURITY: plaintext would expose install.sh to tampering in transit,
      // and the agent's join request with it.
      throw invalid("control plane URL must use https://");
    }
  } else if (u.protocol !== "https:") {
    throw invalid("control plane URL must use https://");
  }
  if (u.username || u.password) throw invalid("control plane URL must not contain credentials");
  if (u.pathname !== "/" || u.search || u.hash) {
    throw invalid("control plane URL must be an origin, without a path, query, or fragment");
  }
  return u.origin;
}

/**
 * Quotes a string for POSIX shells.
 *
 * @param s - Any string.
 * @returns `s` in single quotes, with embedded quotes escaped.
 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function joinScript(origin: string, name: string, builder: boolean): string {
  const secure = origin.startsWith("https:");
  const curlProto = secure ? "--proto '=https' --tlsv1.2" : "--proto '=http'";
  const args = ["--url", shQuote(origin), "--token-file", '"$TOKEN_FILE"', "--name", shQuote(name)];
  if (builder) args.push("--builder");
  return [
    "#!/bin/bash",
    "# Joins this server to its control plane. Generated; holds no secrets.",
    "set -euo pipefail",
    "umask 077",
    `TOKEN_FILE=${TOKEN_PATH}`,
    `INSTALLER=${JOIN_DIR}/install.sh`,
    "scrub() {",
    '  shred -u "$1" 2>/dev/null || rm -f "$1"',
    "}",
    "cleanup() {",
    '  scrub "$TOKEN_FILE"',
    '  rm -f "$INSTALLER"',
    "}",
    "trap cleanup EXIT",
    "# cloud-init keeps root-only copies of the user data, which hold the token.",
    `for f in ${CLOUD_INIT_USER_DATA_COPIES.join(" ")}; do`,
    '  if [ -f "$f" ]; then scrub "$f"; fi',
    "done",
    "if ! command -v curl >/dev/null 2>&1; then",
    "  apt-get -o DPkg::Lock::Timeout=300 update -qq",
    "  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 install -y -qq curl ca-certificates",
    "fi",
    `curl ${curlProto} -fsSL --retry 5 --retry-delay 3 --retry-connrefused -o "$INSTALLER" ${shQuote(`${origin}/install.sh`)}`,
    `bash "$INSTALLER" ${args.join(" ")}`,
    "",
  ].join("\n");
}

function yamlBlock(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => (line ? indent + line : ""))
    .join("\n");
}

/**
 * Builds the `#cloud-config` user data for a new server.
 *
 * @param input - Control plane URL, join token, node name, builder flag.
 * @returns User data, at most {@link HETZNER_USER_DATA_LIMIT} bytes.
 * @throws ProvisionError `invalid_input` for bad input or oversized output.
 * @example
 * const userData = buildUserData({
 *   controlPlaneUrl: "https://cp.example.com",
 *   joinToken: token,
 *   name: "web-1",
 * });
 */
export function buildUserData(input: UserDataInput): string {
  const origin = validateControlPlaneUrl(input.controlPlaneUrl, input);
  const token = validateJoinToken(input.joinToken);
  const name = validateNodeName(input.name);
  const script = joinScript(origin, name, input.builder === true);

  // JSON strings are valid YAML double-quoted scalars, so every interpolated
  // scalar is emitted with JSON.stringify.
  const doc = [
    "#cloud-config",
    "write_files:",
    `  - path: ${JSON.stringify(TOKEN_PATH)}`,
    '    owner: "root:root"',
    '    permissions: "0600"',
    `    content: ${JSON.stringify(`${token}\n`)}`,
    `  - path: ${JSON.stringify(JOIN_SCRIPT_PATH)}`,
    '    owner: "root:root"',
    '    permissions: "0700"',
    "    content: |",
    yamlBlock(script, "      "),
    "runcmd:",
    `  - [${JSON.stringify("/bin/bash")}, ${JSON.stringify(JOIN_SCRIPT_PATH)}]`,
    "",
  ].join("\n");

  const bytes = new TextEncoder().encode(doc).byteLength;
  if (bytes > HETZNER_USER_DATA_LIMIT) {
    throw invalid(`user data is ${bytes} bytes; Hetzner allows ${HETZNER_USER_DATA_LIMIT}`);
  }
  return doc;
}
