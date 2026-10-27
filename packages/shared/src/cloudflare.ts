/**
 * Cloudflare Containers as a service runtime (ADR 0011), shared by the API
 * (which enforces it at apply time) and the dashboard (which shows the
 * checklist live):
 * - {@link CLOUDFLARE_INSTANCE_TYPES} and {@link instanceTypeFor};
 * - {@link cloudflareEligibility}: whether a service may switch to
 *   `placement.provider = "cloudflare"`, and every rule it fails;
 * - {@link parseSleepAfter}.
 *
 * @module
 */
import type { ServiceKind } from "./projects";
import type { ResourcesConfig } from "./service-config";

/** Where a service's replicas run. */
export const SERVICE_PROVIDERS = ["nodes", "cloudflare"] as const;

/** Where a service's replicas run; see {@link SERVICE_PROVIDERS}. */
export type ServiceProvider = (typeof SERVICE_PROVIDERS)[number];

/** One Cloudflare Containers instance type (ADR 0011, "Facts"). */
export interface CloudflareInstanceType {
  name: string;
  /** Thousandths of a vCPU. */
  cpu_millis: number;
  memory_mb: number;
  disk_mb: number;
}

/**
 * Instance types, smallest first. Disk is ephemeral. Values as documented
 * on 2026-10-21; the live verification refreshes them (ADR 0011).
 */
export const CLOUDFLARE_INSTANCE_TYPES = [
  { name: "lite", cpu_millis: 62, memory_mb: 256, disk_mb: 2048 },
  { name: "basic", cpu_millis: 250, memory_mb: 1024, disk_mb: 4096 },
  { name: "standard-1", cpu_millis: 500, memory_mb: 4096, disk_mb: 8192 },
  { name: "standard-2", cpu_millis: 1000, memory_mb: 6144, disk_mb: 12288 },
  { name: "standard-3", cpu_millis: 2000, memory_mb: 8192, disk_mb: 16384 },
  { name: "standard-4", cpu_millis: 4000, memory_mb: 12288, disk_mb: 20480 },
] as const satisfies readonly CloudflareInstanceType[];

/** An instance type name. */
export type CloudflareInstanceTypeName = (typeof CLOUDFLARE_INSTANCE_TYPES)[number]["name"];

/** Every instance type name, smallest first. */
export const CLOUDFLARE_INSTANCE_TYPE_NAMES = CLOUDFLARE_INSTANCE_TYPES.map(
  (t) => t.name,
) as readonly CloudflareInstanceTypeName[];

/** Most instances one service-environment pools (`getRandom` over a fixed pool). */
export const MAX_CLOUDFLARE_INSTANCES = 100;

/** `sleep_after` when none is set. */
export const DEFAULT_CLOUDFLARE_SLEEP_AFTER = "10m";

/** Per-service Cloudflare settings (`placement.cloudflare`). */
export interface CloudflarePlacement {
  /** Derived from `resources` when omitted ({@link instanceTypeFor}). */
  instance_type?: CloudflareInstanceTypeName;
  /** 1..{@link MAX_CLOUDFLARE_INSTANCES}; the pool size. */
  max_instances: number;
  /** `"1m"`..`"24h"`; idle time before an instance sleeps. */
  sleep_after: string;
  /** Placement constraints (`constraints.regions`), when set. */
  regions?: string[];
}

/**
 * Looks up an instance type.
 *
 * @param name - Type name.
 * @returns The type, or `undefined` for an unknown name.
 */
export function cloudflareInstanceType(name: string): CloudflareInstanceType | undefined {
  return CLOUDFLARE_INSTANCE_TYPES.find((t) => t.name === name);
}

/**
 * The smallest instance type that fits a service's resources.
 *
 * @param resources - CPU and memory per replica.
 * @returns The type name, or `null` when nothing is large enough.
 * @example
 * instanceTypeFor({ cpu_millis: 500, memory_mb: 512 }); // "standard-1"
 */
export function instanceTypeFor(resources: ResourcesConfig): CloudflareInstanceTypeName | null {
  const fit = CLOUDFLARE_INSTANCE_TYPES.find(
    (t) => resources.cpu_millis <= t.cpu_millis && resources.memory_mb <= t.memory_mb,
  );
  return fit?.name ?? null;
}

/**
 * Parses a `sleep_after` duration such as `"90s"`, `"10m"` or `"2h"`.
 *
 * @param value - Duration text.
 * @returns Seconds, or `null` when malformed or outside 1 minute to 24 hours.
 * @example
 * parseSleepAfter("10m"); // 600
 */
export function parseSleepAfter(value: string): number | null {
  const m = /^([1-9][0-9]{0,4})(s|m|h)$/.exec(value);
  if (!m) return null;
  const seconds = Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2] as "s" | "m" | "h"];
  return seconds >= 60 && seconds <= 86_400 ? seconds : null;
}

/** Facts about a service that decide whether it may run on Cloudflare. */
export interface CloudflareEligibilityInput {
  kind: ServiceKind;
  /** `networking.port`. */
  port: number | null;
  resources: ResourcesConfig;
  /** `placement.cloudflare.instance_type`, when set. */
  instanceType?: string;
  hasVolume: boolean;
  hasTcpProxy: boolean;
  /**
   * Custom domains in the environment. Only Cloudflare-for-SaaS ones (ADR
   * 0009 `saas`) can be served by a Worker route outside the apps zone.
   */
  customDomains: readonly { hostname: string; saas: boolean }[];
  /**
   * The image's architectures as recorded by the builder, `null` when not
   * known yet (an image source not inspected, or the first build).
   */
  imageArchitectures: readonly string[] | null;
}

/** Rules a Cloudflare-provider service must pass (ADR 0011, "Eligibility"). */
export const CLOUDFLARE_ELIGIBILITY_RULES = [
  "kind",
  "port",
  "volume",
  "tcp_proxy",
  "domains",
  "resources",
  "image_arch",
] as const;

/** One eligibility rule; see {@link CLOUDFLARE_ELIGIBILITY_RULES}. */
export type CloudflareEligibilityRule = (typeof CLOUDFLARE_ELIGIBILITY_RULES)[number];

/** A failed rule, with a sentence the dashboard and the 422 show. */
export interface CloudflareEligibilityFailure {
  rule: CloudflareEligibilityRule;
  message: string;
}

/**
 * Checks every eligibility rule, so the dashboard can show the whole
 * checklist and the API can name each failing rule in its 422.
 *
 * - `kind`: only `app` services.
 * - `port`: `networking.port` must be set; Workers reach a container over HTTP.
 * - `volume`, `tcp_proxy`: container disks are ephemeral and inbound is HTTP only.
 * - `domains`: every custom domain must be a SaaS-mode one (generated
 *   hostnames always pass).
 * - `resources`: the chosen instance type must fit `resources`, or one
 *   must exist when none is chosen.
 * - `image_arch`: the image must have a `linux/amd64` variant; an unknown
 *   architecture passes here and is checked again when the image is pushed.
 *
 * @param input - Facts about the service.
 * @returns Every failed rule; empty when eligible.
 */
export function cloudflareEligibility(
  input: CloudflareEligibilityInput,
): CloudflareEligibilityFailure[] {
  const failures: CloudflareEligibilityFailure[] = [];
  const fail = (rule: CloudflareEligibilityRule, message: string) =>
    failures.push({ rule, message });
  if (input.kind !== "app") fail("kind", "Only app services can run on Cloudflare Containers");
  if (input.port === null) fail("port", "Set the port the app listens on");
  if (input.hasVolume) fail("volume", "Services with a volume must run on nodes");
  if (input.hasTcpProxy) fail("tcp_proxy", "Services with a TCP proxy must run on nodes");
  const direct = input.customDomains.filter((d) => !d.saas);
  if (direct.length) {
    fail(
      "domains",
      `Custom domains must use Cloudflare for SaaS mode: ${direct.map((d) => d.hostname).join(", ")}`,
    );
  }
  if (input.instanceType !== undefined) {
    const type = cloudflareInstanceType(input.instanceType);
    if (!type) fail("resources", `Unknown instance type ${input.instanceType}`);
    else if (
      input.resources.cpu_millis > type.cpu_millis ||
      input.resources.memory_mb > type.memory_mb
    ) {
      fail(
        "resources",
        `${type.name} has ${type.cpu_millis} millicores and ${type.memory_mb} MB; the service asks for ${input.resources.cpu_millis} and ${input.resources.memory_mb}`,
      );
    }
  } else if (instanceTypeFor(input.resources) === null) {
    fail("resources", "No instance type is large enough (at most 4 vCPU and 12 GiB)");
  }
  if (input.imageArchitectures !== null && !input.imageArchitectures.includes("amd64")) {
    fail("image_arch", "The image has no linux/amd64 variant");
  }
  return failures;
}
