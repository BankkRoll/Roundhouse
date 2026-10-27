/**
 * MSW mocks of the Cloudflare Containers provider (ADR 0011): the instance's account
 * (Settings → Cloudflare) and a service's runtime view (Service → Settings → Runtime).
 *
 * @module
 */
import { cloudflareEligibility, type PlacementConfig, serviceProvider } from "@roundhouse/shared";
import { HttpResponse, http } from "msw";
import type {
  CloudflareCheck,
  CloudflareDeployment,
  CloudflareRuntime,
  InstanceCloudflare,
  ProviderEligibility,
} from "../lib/api/cloudflare-client";
import {
  apiError,
  currentUser,
  invalid,
  notFound,
  requireFreshSession,
  unauthorized,
} from "./common";
import { db } from "./db";

/** A token the mock's Cloudflare refuses, for the 422 path. */
export const REFUSED_CLOUDFLARE_TOKEN = "refused-cloudflare-token-0000";

interface CloudflareMockState {
  instance: InstanceCloudflare;
  /** The stored token; never returned. */
  token: string | null;
  /** Checks `verify` reports. */
  checks: CloudflareCheck[];
  /** Failures the API would add for facts the dashboard can't see (volume, domains, image). */
  serverFailures: Record<string, ProviderEligibility[]>;
  /** Non-fatal notes the API adds, by service. */
  warnings: Record<string, string[]>;
  runtimes: Record<string, CloudflareRuntime>;
  deployments: Record<string, CloudflareDeployment[]>;
}

function emptyInstance(): InstanceCloudflare {
  return {
    configured: false,
    account_id: null,
    workers_subdomain: null,
    apps_domain_proxied: false,
    apps_zone: null,
    token_hint: null,
    validated_at: null,
    image_storage_bytes: null,
  };
}

function defaultChecks(): CloudflareCheck[] {
  return [
    { name: "Workers Scripts", ok: true, message: "Can edit Worker scripts." },
    { name: "Containers", ok: true, message: "Can edit container applications." },
    { name: "Workers Routes", ok: true, message: "Can edit routes on the apps zone." },
    { name: "Account Analytics", ok: true, message: "Can read container metrics." },
  ];
}

/** The mock's Cloudflare state; tests read and steer it. Reset after every test. */
export const cloudflareMock: CloudflareMockState = {
  instance: emptyInstance(),
  token: null,
  checks: defaultChecks(),
  serverFailures: {},
  warnings: {},
  runtimes: {},
  deployments: {},
};

/** Restores {@link cloudflareMock}. */
export function resetCloudflareMock(): void {
  cloudflareMock.instance = emptyInstance();
  cloudflareMock.token = null;
  cloudflareMock.checks = defaultChecks();
  cloudflareMock.serverFailures = {};
  cloudflareMock.warnings = {};
  cloudflareMock.runtimes = {};
  cloudflareMock.deployments = {};
}

/**
 * Connects the mock account, as a successful `PUT` would.
 *
 * @param overrides - Fields to change.
 */
export function connectCloudflareMock(overrides: Partial<InstanceCloudflare> = {}): void {
  cloudflareMock.token = "mock-token-abcdefghijklmnop";
  cloudflareMock.instance = {
    configured: true,
    account_id: "0123456789abcdef0123456789abcdef",
    workers_subdomain: "acme",
    apps_domain_proxied: true,
    apps_zone: "example.com",
    token_hint: "mnop",
    validated_at: Date.now() - 3_600_000,
    image_storage_bytes: 5 * 1024 ** 3,
    ...overrides,
  };
}

function requireInstanceAdmin(): Response | null {
  const user = currentUser();
  if (!user) return unauthorized();
  if (!user.instance_admin) {
    return apiError(403, "forbidden", "Only instance admins can change instance settings");
  }
  return null;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => ({}));
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

/** HTTP handlers of the Cloudflare routes. */
export const cloudflareHandlers = [
  http.get("*/v1/instance/cloudflare", () => {
    const refused = requireInstanceAdmin();
    if (refused) return refused;
    return HttpResponse.json(cloudflareMock.instance);
  }),

  http.put("*/v1/instance/cloudflare", async ({ request }) => {
    const body = await readBody(request);
    if (typeof body.account_id !== "string" || !/^[a-f0-9]{32}$/.test(body.account_id)) {
      return invalid("account_id: expected a 32-character account ID");
    }
    if (typeof body.api_token !== "string" || body.api_token.length < 20) {
      return invalid("api_token: Too small: expected >=20 chars");
    }
    const refused = requireInstanceAdmin() ?? requireFreshSession();
    if (refused) return refused;
    if (body.api_token === REFUSED_CLOUDFLARE_TOKEN) {
      return apiError(
        422,
        "cloudflare_account_invalid",
        "Cloudflare refused the token: it lacks Containers → Edit",
      );
    }
    cloudflareMock.token = body.api_token;
    cloudflareMock.instance = {
      configured: true,
      account_id: body.account_id,
      workers_subdomain: "acme",
      apps_domain_proxied:
        typeof body.apps_domain_proxied === "boolean"
          ? body.apps_domain_proxied
          : cloudflareMock.instance.apps_domain_proxied,
      apps_zone: "example.com",
      token_hint: body.api_token.slice(-4),
      validated_at: Date.now(),
      image_storage_bytes: cloudflareMock.instance.image_storage_bytes ?? 0,
    };
    return HttpResponse.json(cloudflareMock.instance);
  }),

  http.delete("*/v1/instance/cloudflare", () => {
    const refused = requireInstanceAdmin() ?? requireFreshSession();
    if (refused) return refused;
    const latest = new Map<string, (typeof db.deploy.configs)[number]>();
    for (const config of db.deploy.configs) {
      const key = `${config.service_id}/${config.environment_id}`;
      if ((latest.get(key)?.version ?? 0) < config.version) latest.set(key, config);
    }
    const running = [...latest.values()].some(
      (config) => serviceProvider(config.placement as PlacementConfig) === "cloudflare",
    );
    if (running) {
      return apiError(
        409,
        "conflict",
        "Services still run on Cloudflare; switch them to nodes first",
      );
    }
    cloudflareMock.instance = emptyInstance();
    cloudflareMock.token = null;
    return HttpResponse.json(cloudflareMock.instance);
  }),

  http.post("*/v1/instance/cloudflare/verify", () => {
    const refused = requireInstanceAdmin();
    if (refused) return refused;
    if (!cloudflareMock.instance.configured) {
      return apiError(409, "cloudflare_not_configured", "Connect a Cloudflare account first");
    }
    return HttpResponse.json({
      ok: cloudflareMock.checks.every((check) => check.ok),
      checks: cloudflareMock.checks,
    });
  }),

  http.get("*/v1/services/:serviceId/cloudflare", ({ params, request }) => {
    const environmentId = new URL(request.url).searchParams.get("environment_id");
    if (!environmentId) return invalid("environment_id: Required");
    const user = currentUser();
    if (!user) return unauthorized();
    const service = db.deploy.services.find((row) => row.id === params.serviceId && !row.deleted);
    const project = service
      ? db.deploy.projects.find((row) => row.id === service.project_id)
      : undefined;
    const member = project
      ? db.memberships.find(
          (row) => row.workspace_id === project.workspace_id && row.user_id === user.id,
        )
      : undefined;
    if (!service || !member) return notFound("Service");
    const config = db.deploy.configs
      .filter((row) => row.service_id === service.id && row.environment_id === environmentId)
      .sort((a, b) => b.version - a.version)[0];
    if (!config) return notFound("Config");
    const placement = config.placement as PlacementConfig;
    const eligibility = [
      ...cloudflareEligibility({
        kind: service.kind,
        port: config.networking.port,
        resources: config.resources,
        instanceType: placement.cloudflare?.instance_type,
        hasVolume: false,
        hasTcpProxy: false,
        customDomains: [],
        imageArchitectures: null,
      }),
      ...(cloudflareMock.serverFailures[service.id] ?? []),
    ];
    return HttpResponse.json({
      provider: serviceProvider(placement),
      configured: cloudflareMock.instance.configured,
      eligibility,
      warnings: cloudflareMock.warnings[service.id] ?? [],
      runtime: cloudflareMock.runtimes[service.id] ?? null,
      deployments: cloudflareMock.deployments[service.id] ?? [],
    });
  }),
];
