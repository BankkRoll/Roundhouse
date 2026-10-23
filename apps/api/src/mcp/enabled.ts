/**
 * The `mcp_enabled` instance setting's gate in front of `/mcp` (ADR 0012).
 * MCP is off on new installs; while it is off, every request gets a 404 that
 * says so, before any authentication, so a disabled instance never checks
 * (or rate-limits, or logs) an agent's token.
 *
 * @module
 */
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../context";
import { errorBody } from "../lib/errors";
import { getMcpEnabled } from "../lib/settings";

/** Message of the disabled response. */
export const MCP_DISABLED_MESSAGE =
  "MCP is disabled on this instance; an instance admin can enable it in the dashboard under Settings → Platform";

/** JSON-RPC error code of the disabled response (implementation-defined server error range). */
export const MCP_DISABLED_RPC_CODE = -32000;

// Big enough for any real JSON-RPC envelope we'd answer; anything larger is
// answered with the plain error body instead of being parsed.
const MAX_SNIFF_BYTES = 64 * 1024;

type RpcId = string | number | null;

/** The IDs of the JSON-RPC requests in a body, or `null` when it isn't JSON-RPC. */
function rpcRequestIds(text: string): { batch: boolean; ids: RpcId[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const batch = Array.isArray(parsed);
  const messages = (batch ? parsed : [parsed]) as unknown[];
  const rpc = messages.filter(
    (m): m is { jsonrpc: "2.0"; id?: unknown; method?: unknown } =>
      typeof m === "object" && m !== null && (m as { jsonrpc?: unknown }).jsonrpc === "2.0",
  );
  if (rpc.length === 0) return null;
  // Notifications (no `id`) get no response object, as JSON-RPC 2.0 requires.
  const ids = rpc
    .filter((m) => "id" in m)
    .map((m) => (typeof m.id === "string" || typeof m.id === "number" ? m.id : null));
  return { batch, ids };
}

function rpcError(id: RpcId) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: {
      code: MCP_DISABLED_RPC_CODE,
      message: MCP_DISABLED_MESSAGE,
      data: { code: "mcp_disabled" },
    },
  };
}

/**
 * Answers `/mcp` with 404 while the `mcp_enabled` setting is off: a JSON-RPC
 * error (one per request in a batch) when the body is JSON-RPC, otherwise the
 * API's usual error body.
 */
export const requireMcpEnabled = createMiddleware<AppEnv>(async (c, next) => {
  if (await getMcpEnabled(c.get("db"))) return next();

  let parsed: ReturnType<typeof rpcRequestIds> = null;
  const declared = Number(c.req.header("content-length") ?? 0);
  if (c.req.method === "POST" && declared <= MAX_SNIFF_BYTES) {
    const raw = await c.req.arrayBuffer().catch(() => new ArrayBuffer(0));
    if (raw.byteLength <= MAX_SNIFF_BYTES) parsed = rpcRequestIds(new TextDecoder().decode(raw));
  }
  if (parsed) {
    const errors = (parsed.ids.length ? parsed.ids : [null]).map(rpcError);
    return c.json(parsed.batch ? errors : errors[0], 404);
  }
  return c.json(errorBody("mcp_disabled", MCP_DISABLED_MESSAGE), 404);
});
