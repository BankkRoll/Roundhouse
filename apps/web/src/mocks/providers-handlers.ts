/**
 * MSW handlers for the cloud provider routes (`apps/api/src/routes/providers.ts`) against
 * the in-memory {@link db}: integrations with write-only tokens, offers and one-click
 * provisioning. `contract.test.ts` validates every response against the API's schemas.
 *
 * Tokens steer the connect check: `ro-…` is read-only (409 `provider_read_only`),
 * `bad-…` is rejected (400 `provider_token_invalid`), anything else connects. A run
 * advances one status per `GET …/node-provisions/{id}`: queued → creating → booting →
 * joined, adding the node on the last step. Names starting `fail-` fail while booting,
 * and `leak-` fail with `cleanup_failed`. `slow-` runs stay creating and `wait-` runs
 * stay booting until cancelled. A cancelled run still creating its server ends
 * `cancelled` on its next poll, as the workflow finishes the cancel once the server exists.
 *
 * @module
 */
import { isProviderId, PROVIDER_IDS, PROVIDERS, type ProviderId } from "@roundhouse/providers";
import { HttpResponse, http } from "msw";
import type { ProviderIntegration } from "../lib/api/providers-types";
import { apiError, invalid, notFound, recordAudit, requireWorkspace } from "./common";
import { db, makePendingNode, nextId } from "./db";
import { type DbProvision, MOCK_OFFERS, mockRecommendations } from "./providers-db";

const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PLAN_OR_REGION = /^[A-Za-z0-9._-]{1,64}$/;
const TOKEN = /^[\x21-\x7e]+$/;

function parseProvider(raw: unknown): ProviderId | Response {
  const value = String(raw);
  return isProviderId(value) ? value : invalid("provider: Invalid option");
}

function notConnected(provider: ProviderId) {
  return apiError(
    409,
    "provider_not_connected",
    `Connect ${PROVIDERS[provider].displayName} to this workspace first`,
  );
}

function findIntegration(workspaceId: string, provider: ProviderId) {
  return db.providers.integrations.find(
    (row) => row.workspace_id === workspaceId && row.provider === provider,
  );
}

function toIntegration(workspaceId: string, provider: ProviderId): ProviderIntegration {
  const row = findIntegration(workspaceId, provider);
  return {
    provider,
    display_name: PROVIDERS[provider].displayName,
    connected: row !== undefined,
    account_label: row?.account_label ?? null,
    token_fingerprint: row?.token_fingerprint ?? null,
    token_last4: row?.token_last4 ?? null,
    last_validated_at: row?.last_validated_at ?? null,
    updated_at: row?.updated_at ?? null,
  };
}

/** A stable 8-hex stand-in for the API's keyed fingerprint (FNV-1a). */
function fingerprint(token: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function toProvision({ workspace_id: _ws, ...run }: DbProvision) {
  return run;
}

const ACTIVE = new Set(["queued", "creating", "booting", "cleanup_failed"]);

/** The run's plan price from the mock catalogue, as the workflow records it. */
function offerPrice(run: DbProvision): DbProvision["estimated_monthly_cost"] {
  const offer = MOCK_OFFERS[run.provider].find(
    (row) => row.plan === run.plan && row.region === run.region,
  );
  return offer ? { monthly_cents: offer.monthly_cents, currency: offer.currency } : null;
}

/** Moves a run one status forward, as the provisioning workflow would between polls. */
function advance(run: DbProvision): void {
  const now = Date.now();
  run.updated_at = now;
  const failing = run.name.startsWith("fail-") || run.name.startsWith("leak-");
  const stuck =
    (run.name.startsWith("slow-") && run.status === "creating") ||
    (run.name.startsWith("wait-") && run.status === "booting");
  if (stuck && run.cancel_requested_at === null) return;
  switch (run.status) {
    case "queued":
      Object.assign(run, { status: "creating", step: "create_server" });
      return;
    case "creating":
      if (run.cancel_requested_at !== null) {
        Object.assign(run, {
          status: "cancelled",
          failure_reason: "cancelled",
          failure_message: "Cancelled before the server joined",
          server_id: String(48_000_000 + db.counter),
          finished_at: now,
        });
        return;
      }
      Object.assign(run, {
        estimated_monthly_cost: offerPrice(run),
        status: "booting",
        step: "wait_until_running",
        server_id: String(48_000_000 + db.counter),
        ipv4: "203.0.113.42",
        ipv6: "2001:db8::42",
      });
      return;
    case "booting": {
      if (failing) {
        const leaked = run.name.startsWith("leak-");
        Object.assign(run, {
          status: leaked ? "cleanup_failed" : "failed",
          failure_reason: leaked ? "cleanup_failed" : "join_timeout",
          failure_message: leaked
            ? "The agent never joined, and deleting the server failed"
            : "The agent did not join within 10 minutes",
          finished_at: now,
        });
        recordAudit({
          workspaceId: run.workspace_id,
          actorType: "system",
          actorId: null,
          action: "node.provision_failed",
          targetType: "node_provision",
          targetId: run.id,
          metadata: { provider: run.provider, name: run.name, reason: run.failure_reason },
        });
        return;
      }
      const nodeId = nextId("node");
      db.nodes.push({
        ...makePendingNode({
          id: nodeId,
          name: run.name,
          provider: run.provider,
          provider_server_id: run.server_id,
          estimated_monthly_cost: run.estimated_monthly_cost,
          region: run.region,
          public_ip: run.ipv4,
          created_at: now,
        }),
        workspace_id: run.workspace_id,
      });
      Object.assign(run, { status: "joined", step: "done", node_id: nodeId, finished_at: now });
      recordAudit({
        workspaceId: run.workspace_id,
        actorType: "system",
        actorId: null,
        action: "node.provisioned",
        targetType: "node",
        targetId: nodeId,
        metadata: { provider: run.provider, name: run.name, server_id: run.server_id },
      });
      return;
    }
    default:
      return;
  }
}

/** Every cloud provider route the dashboard calls. */
export const providerHandlers = [
  http.get("*/v1/workspaces/:workspaceId/integrations", ({ params }) => {
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "nodes:manage");
    if (!access.ok) return access.response;
    const integrations = PROVIDER_IDS.map((provider) => toIntegration(workspaceId, provider));
    return HttpResponse.json({ integrations });
  }),

  http.get("*/v1/workspaces/:workspaceId/integrations/:provider", ({ params }) => {
    const provider = parseProvider(params.provider);
    if (provider instanceof Response) return provider;
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "nodes:manage");
    if (!access.ok) return access.response;
    return HttpResponse.json(toIntegration(workspaceId, provider));
  }),

  http.put("*/v1/workspaces/:workspaceId/integrations/:provider", async ({ params, request }) => {
    const provider = parseProvider(params.provider);
    if (provider instanceof Response) return provider;
    const body = (await request.json().catch(() => ({}))) as { token?: unknown };
    if (typeof body.token !== "string") return invalid("token: Invalid input: expected string");
    const token = body.token.trim();
    if (token.length < 16) return invalid("token: Too small: expected >=16 chars");
    if (token.length > 512) return invalid("token: Too big: expected <=512 chars");
    if (!TOKEN.test(token)) return invalid("token: must be printable ASCII without spaces");
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "nodes:manage");
    if (!access.ok) return access.response;

    const info = PROVIDERS[provider];
    if (token.startsWith("bad-")) {
      return apiError(400, "provider_token_invalid", `${info.displayName} rejected this token`);
    }
    if (token.startsWith("ro-")) {
      return apiError(
        409,
        "provider_read_only",
        `This ${info.displayName} token can't create servers (missing: ${info.requiredScopes.join(", ")}); create one with ${info.requiredScopes.join(", ")}`,
      );
    }
    const now = Date.now();
    const existing = findIntegration(workspaceId, provider);
    const values = {
      account_label: "demo@example.com",
      token_fingerprint: fingerprint(token),
      token_last4: token.slice(-4),
      last_validated_at: now,
      updated_at: now,
    };
    if (existing) Object.assign(existing, values);
    else db.providers.integrations.push({ workspace_id: workspaceId, provider, ...values });
    recordAudit({
      workspaceId,
      actorType: "user",
      actorId: access.user.id,
      action: "provider.connected",
      targetType: "provider_credential",
      targetId: `pcr_${provider}`,
      metadata: { provider, fingerprint: values.token_fingerprint, replaced: Boolean(existing) },
    });
    return HttpResponse.json(toIntegration(workspaceId, provider));
  }),

  http.delete("*/v1/workspaces/:workspaceId/integrations/:provider", ({ params, request }) => {
    const provider = parseProvider(params.provider);
    if (provider instanceof Response) return provider;
    const force = new URL(request.url).searchParams.get("force");
    if (force !== null && force !== "true" && force !== "false") {
      return invalid("force: Invalid option");
    }
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "nodes:manage");
    if (!access.ok) return access.response;
    const row = findIntegration(workspaceId, provider);
    if (!row) return notFound("Integration");
    if (force !== "true") {
      const busy =
        db.nodes.filter(
          (node) =>
            node.workspace_id === workspaceId &&
            node.provider === provider &&
            node.provider_server_id !== null,
        ).length +
        db.providers.provisions.filter(
          (run) =>
            run.workspace_id === workspaceId && run.provider === provider && ACTIVE.has(run.status),
        ).length;
      if (busy > 0) {
        return apiError(
          409,
          "conflict",
          `${busy} server(s) were created with this ${PROVIDERS[provider].displayName} token; deleting them needs it. Remove them first, or pass force=true to leave them running at the provider.`,
        );
      }
    }
    db.providers.integrations = db.providers.integrations.filter((entry) => entry !== row);
    recordAudit({
      workspaceId,
      actorType: "user",
      actorId: access.user.id,
      action: "provider.disconnected",
      targetType: "provider_credential",
      targetId: `pcr_${provider}`,
      metadata: { provider, fingerprint: row.token_fingerprint, forced: force === "true" },
    });
    return new HttpResponse(null, { status: 204 });
  }),

  http.get("*/v1/workspaces/:workspaceId/providers/:provider/offers", ({ params, request }) => {
    const provider = parseProvider(params.provider);
    if (provider instanceof Response) return provider;
    const query = new URL(request.url).searchParams;
    const role = query.get("role") ?? "node";
    if (role !== "node" && role !== "builder") return invalid("role: Invalid option");
    const region = query.get("region");
    if (region !== null && !/^[a-z0-9-]{1,32}$/.test(region)) {
      return invalid("region: Invalid string");
    }
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "nodes:manage");
    if (!access.ok) return access.response;
    if (!findIntegration(workspaceId, provider)) return notConnected(provider);
    const offers = MOCK_OFFERS[provider].filter(
      (offer) =>
        (region === null || offer.region === region) && (role === "node" || offer.disk_gb >= 20),
    );
    return HttpResponse.json({
      provider,
      role,
      offers,
      recommendations: mockRecommendations(offers, role),
      fetched_at: Date.now(),
    });
  }),

  http.post("*/v1/workspaces/:workspaceId/nodes/provision", async ({ params, request }) => {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const provider = parseProvider(body.provider);
    if (provider instanceof Response) return provider;
    for (const field of ["plan", "region"] as const) {
      if (typeof body[field] !== "string" || !PLAN_OR_REGION.test(body[field] as string)) {
        return invalid(`${field}: Invalid string`);
      }
    }
    if (typeof body.name !== "string" || !NAME.test(body.name)) {
      return invalid(
        "name: must be 1-63 lowercase letters, digits or hyphens, not starting or ending with a hyphen",
      );
    }
    if (body.builder !== undefined && typeof body.builder !== "boolean") {
      return invalid("builder: Invalid input: expected boolean");
    }
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "nodes:manage");
    if (!access.ok) return access.response;
    if (!findIntegration(workspaceId, provider)) return notConnected(provider);
    const name = body.name;
    const taken =
      db.nodes.some((node) => node.workspace_id === workspaceId && node.name === name) ||
      db.providers.provisions.some(
        (run) => run.workspace_id === workspaceId && run.name === name && ACTIVE.has(run.status),
      );
    if (taken) return apiError(409, "conflict", `A server named ${name} already exists`);

    const now = Date.now();
    const run: DbProvision = {
      id: nextId("npr"),
      workspace_id: workspaceId,
      provider,
      name,
      plan: body.plan as string,
      region: body.region as string,
      builder: body.builder === true,
      status: "queued",
      step: null,
      failure_reason: null,
      failure_message: null,
      server_id: null,
      ipv4: null,
      ipv6: null,
      node_id: null,
      cancel_requested_at: null,
      estimated_monthly_cost: null,
      created_at: now,
      updated_at: now,
      finished_at: null,
    };
    db.providers.provisions.push(run);
    recordAudit({
      workspaceId,
      actorType: "user",
      actorId: access.user.id,
      action: "node.provision_requested",
      targetType: "node_provision",
      targetId: run.id,
      metadata: { provider, name, plan: run.plan, region: run.region, builder: run.builder },
    });
    return HttpResponse.json(toProvision(run), { status: 202 });
  }),

  http.get("*/v1/workspaces/:workspaceId/node-provisions", ({ params }) => {
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "nodes:read");
    if (!access.ok) return access.response;
    const provisions = db.providers.provisions
      .filter((run) => run.workspace_id === workspaceId)
      .sort((a, b) => b.created_at - a.created_at)
      .map(toProvision);
    return HttpResponse.json({ provisions });
  }),

  http.get("*/v1/workspaces/:workspaceId/node-provisions/:provisionId", ({ params }) => {
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "nodes:read");
    if (!access.ok) return access.response;
    const run = db.providers.provisions.find(
      (row) => row.id === params.provisionId && row.workspace_id === workspaceId,
    );
    if (!run) return notFound("Provisioning run");
    advance(run);
    return HttpResponse.json(toProvision(run));
  }),

  http.post("*/v1/workspaces/:workspaceId/node-provisions/:provisionId/cancel", ({ params }) => {
    const workspaceId = String(params.workspaceId);
    const access = requireWorkspace(workspaceId, "nodes:manage");
    if (!access.ok) return access.response;
    const run = db.providers.provisions.find(
      (row) => row.id === params.provisionId && row.workspace_id === workspaceId,
    );
    if (!run) return notFound("Provisioning run");
    if (run.cancel_requested_at !== null) return HttpResponse.json(toProvision(run));
    if (!["queued", "creating", "booting"].includes(run.status)) {
      return apiError(
        409,
        "conflict",
        run.status === "joined"
          ? `${run.name} already joined; remove the server instead`
          : `This run already finished (${run.status})`,
      );
    }
    const now = Date.now();
    const from = run.status;
    run.cancel_requested_at = now;
    run.updated_at = now;
    if (from !== "creating") {
      Object.assign(run, {
        status: "cancelled",
        failure_reason: "cancelled",
        failure_message: "Cancelled before the server joined",
        finished_at: now,
      });
    }
    recordAudit({
      workspaceId,
      actorType: "user",
      actorId: access.user.id,
      action: "node.provision_cancelled",
      targetType: "node_provision",
      targetId: run.id,
      metadata: {
        provider: run.provider,
        name: run.name,
        from_status: from,
        status: run.status,
        server_id: run.server_id,
      },
    });
    return HttpResponse.json(toProvision(run));
  }),
];
