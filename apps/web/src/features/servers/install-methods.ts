/**
 * The ways to join a server to this control plane, as the add-server flow offers them,
 * and what each one needs: the Linux one-liner, cloud-init user data (built by
 * `@openrail/hetzner`'s `buildUserData`, which keeps the token out of every command
 * line), and the local Docker node for development.
 *
 * Pure, so the generated text is unit-tested directly.
 *
 * @module
 */
import { buildUserData, ProvisionError } from "@openrail/hetzner";

/** An install method tab. `hetzner` is shown but not available yet. */
export type InstallMethod = "linux" | "cloud-init" | "local" | "hetzner";

/** Methods that can be picked today. */
export const AVAILABLE_METHODS: readonly InstallMethod[] = ["linux", "cloud-init", "local"];

/** localStorage key remembering the last method picked. */
export const INSTALL_METHOD_STORAGE_KEY = "openrail.add-server.method";

/**
 * Whether an origin points at this machine, where the local Docker node can reach it.
 *
 * @param origin - Page origin, e.g. `http://localhost:5173`.
 * @returns `true` for `localhost`, `127.0.0.0/8` and `[::1]`.
 */
export function isLocalOrigin(origin: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}

/**
 * The install one-liner, with `--builder` appended for a builder node.
 *
 * @param installCommand - The command the API returned with the join token.
 * @param builder - Join as a builder node.
 * @returns The command to show.
 */
export function linuxInstallCommand(installCommand: string, builder: boolean): string {
  return builder ? `${installCommand} --builder` : installCommand;
}

/**
 * The command that runs a local development node in Docker (`scripts/dev-node.mjs`).
 *
 * @param token - Join token.
 * @returns E.g. `pnpm dev:node njt_…`.
 */
export function localNodeCommand(token: string): string {
  return `pnpm dev:node ${token}`;
}

/** Result of {@link cloudInitUserData}. */
export type CloudInitResult =
  | { ok: true; userData: string }
  /**
   * A cloud server couldn't (safely) reach the control plane at this origin: it is plain
   * HTTP, or this machine.
   */
  | { ok: false; reason: "unreachable_origin" }
  /** The name (or token) was refused; `message` says why. */
  | { ok: false; reason: "invalid"; message: string };

/**
 * Builds `#cloud-config` user data that joins a new server at first boot: the token goes
 * to a root-only 0600 file (never a command line), install.sh comes over HTTPS only and
 * runs with `--token-file`, and the file is shredded afterwards.
 *
 * @param input - Control plane origin, join token, node name and builder flag.
 * @returns The user data, or why it can't be built.
 * @example
 * cloudInitUserData({ origin: "https://cp.example.com", token, name: "web-1", builder: false });
 */
export function cloudInitUserData(input: {
  origin: string;
  token: string;
  name: string;
  builder: boolean;
}): CloudInitResult {
  // SECURITY: A cloud server reaches the control plane over the internet; plain HTTP
  // would let anyone on the path swap install.sh or read the token as it joins.
  if (!input.origin.startsWith("https://") || isLocalOrigin(input.origin)) {
    return { ok: false, reason: "unreachable_origin" };
  }
  try {
    return {
      ok: true,
      userData: buildUserData({
        controlPlaneUrl: input.origin,
        joinToken: input.token,
        name: input.name,
        builder: input.builder,
      }),
    };
  } catch (error) {
    if (error instanceof ProvisionError) {
      return { ok: false, reason: "invalid", message: error.message };
    }
    throw error;
  }
}

/**
 * A default node name for cloud-init: `server-` and four random characters, so two
 * servers made from the same dialog don't collide.
 *
 * @param random - Uniform random source in `[0, 1)`.
 * @returns E.g. `server-k3x9`.
 */
export function defaultNodeName(random: () => number = Math.random): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  let suffix = "";
  for (let i = 0; i < 4; i++) suffix += alphabet[Math.floor(random() * alphabet.length)];
  return `server-${suffix}`;
}

/**
 * Reads the last method picked, falling back to `linux` when nothing (or something no
 * longer offered here) was stored, or storage is unavailable.
 *
 * @param offered - Methods this page can show.
 * @returns The method to start on.
 */
export function readStoredMethod(offered: readonly InstallMethod[]): InstallMethod {
  try {
    const stored = window.localStorage.getItem(INSTALL_METHOD_STORAGE_KEY);
    return offered.find((method) => method === stored && method !== "hetzner") ?? "linux";
  } catch {
    // NOTE: Storage throws in some private modes and sandboxed frames; the default is fine.
    return "linux";
  }
}

/**
 * Remembers the method picked, ignoring storage failures.
 *
 * @param method - The method.
 */
export function storeMethod(method: InstallMethod): void {
  try {
    window.localStorage.setItem(INSTALL_METHOD_STORAGE_KEY, method);
  } catch {
    // NOTE: Remembering is a convenience; a full or blocked storage just skips it.
  }
}
