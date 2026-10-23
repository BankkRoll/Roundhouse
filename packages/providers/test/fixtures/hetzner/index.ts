/**
 * Hetzner test data built from the documented response shapes in this folder. Each
 * builder clones a documented object and overrides only what a scenario
 * needs, so every field the client reads exists exactly as Hetzner documents
 * it. Names and prices are illustrative, not current Hetzner prices.
 *
 * @module
 */
import type {
  Action,
  Image,
  Location,
  Server,
  ServerType,
  ServerTypeLocation,
} from "../../../src/hetzner/types";
import createServerDoc from "./create_server.201.json";
import getActionDoc from "./get_action.200.json";
import getServerDoc from "./get_server.200.json";
import listImagesDoc from "./list_images.200.json";
import listLocationsDoc from "./list_locations.200.json";
import listServerTypesDoc from "./list_server_types.200.json";

export { default as errors } from "./errors.json";
export { default as pricingDoc } from "./get_pricing.200.json";

const clone = <T>(v: T): T => structuredClone(v);

/** The documented server type example. */
export const docServerType = listServerTypesDoc.server_types[0] as unknown as ServerType;
/** The documented server example. */
export const docServer = getServerDoc.server as unknown as Server;
/** The documented action example. */
export const docAction = getActionDoc.action as unknown as Action;
/** The documented image example. */
export const docImage = listImagesDoc.images[0] as unknown as Image;
/** The documented location example. */
export const docLocation = listLocationsDoc.locations[0] as unknown as Location;
/** The documented create-server response, including `root_password`. */
export const docCreateServer = createServerDoc;

/** Builds a location from the documented example. */
export function location(
  name: string,
  city: string,
  country: string,
  zone: string,
  id: number,
): Location {
  return {
    ...clone(docLocation),
    id,
    name,
    city,
    country,
    network_zone: zone,
    description: `${city} DC`,
  };
}

/** Locations used across tests. */
export const LOCATIONS: Location[] = [
  location("fsn1", "Falkenstein", "DE", "eu-central", 1),
  location("nbg1", "Nuremberg", "DE", "eu-central", 2),
  location("hel1", "Helsinki", "FI", "eu-central", 3),
  location("ash", "Ashburn, VA", "US", "us-east", 4),
];

interface TypeSpec {
  id: number;
  name: string;
  cores: number;
  memory: number;
  disk: number;
  arch?: "x86" | "arm";
  cpu?: "shared" | "dedicated";
  /** Monthly gross price per location; hourly is derived. */
  prices: Record<string, string>;
  /** Per-location overrides. */
  at?: Record<string, Partial<ServerTypeLocation>>;
  /** Locations listed without a price. */
  unpriced?: string[];
  deprecated?: boolean;
}

/** Builds a server type from the documented example. */
export function serverType(spec: TypeSpec): ServerType {
  const base = clone(docServerType);
  const names = [...Object.keys(spec.prices), ...(spec.unpriced ?? [])];
  return {
    ...base,
    id: spec.id,
    name: spec.name,
    description: spec.name.toUpperCase(),
    cores: spec.cores,
    memory: spec.memory,
    disk: spec.disk,
    architecture: spec.arch ?? "x86",
    cpu_type: spec.cpu ?? "shared",
    category: spec.cpu === "dedicated" ? "Dedicated vCPU" : "Shared vCPU",
    deprecated: spec.deprecated ?? false,
    deprecation: null,
    prices: Object.entries(spec.prices).map(([loc, gross]) => {
      const p = clone(base.prices[0]!);
      const net = (Number(gross) / 1.19).toFixed(4);
      return {
        ...p,
        location: loc,
        price_monthly: { net, gross },
        price_hourly: {
          net: (Number(net) / 730).toFixed(4),
          gross: (Number(gross) / 730).toFixed(4),
        },
        included_traffic: 20 * 1e12,
      };
    }),
    locations: names.map((n) => {
      const loc = LOCATIONS.find((l) => l.name === n);
      return {
        id: loc?.id ?? 99,
        name: n,
        deprecation: null,
        recommended: false,
        available: true,
        ...spec.at?.[n],
      };
    }),
  };
}

const FUTURE = { announced: "2026-10-01T00:00:00Z", unavailable_after: "2099-01-01T00:00:00Z" };
const PAST = { announced: "2025-10-16T00:00:00Z", unavailable_after: "2026-01-01T00:00:00Z" };

/**
 * Catalogue covering every join rule: deprecations (future and past),
 * temporary unavailability, a missing price, an unknown location, arm, and
 * dedicated types.
 */
export const SERVER_TYPES: ServerType[] = [
  serverType({
    id: 101,
    name: "cx23",
    cores: 2,
    memory: 4,
    disk: 40,
    prices: { fsn1: "4.1500", nbg1: "4.1500", hel1: "4.1500" },
    at: { nbg1: { recommended: true }, hel1: { available: false } },
  }),
  serverType({
    id: 102,
    name: "cpx22",
    cores: 2,
    memory: 4,
    disk: 80,
    prices: { fsn1: "7.4900", ash: "8.9900" },
    unpriced: ["nbg1"],
  }),
  serverType({
    id: 103,
    name: "cax11",
    cores: 2,
    memory: 4,
    disk: 40,
    arch: "arm",
    prices: { fsn1: "4.5100" },
  }),
  serverType({
    id: 104,
    name: "cx33",
    cores: 4,
    memory: 8,
    disk: 80,
    prices: { fsn1: "6.9900", nbg1: "6.9900" },
  }),
  serverType({
    id: 105,
    name: "ccx13",
    cores: 2,
    memory: 8,
    disk: 80,
    cpu: "dedicated",
    prices: { fsn1: "14.8700", ash: "15.4600" },
  }),
  serverType({
    id: 106,
    name: "cx22",
    cores: 2,
    memory: 4,
    disk: 40,
    prices: { fsn1: "3.9900", nbg1: "3.9900" },
    at: { fsn1: { deprecation: FUTURE }, nbg1: { deprecation: PAST } },
  }),
  serverType({ id: 107, name: "cx11", cores: 1, memory: 2, disk: 20, prices: { fsn1: "1.0050" } }),
  serverType({
    id: 108,
    name: "cx43",
    cores: 8,
    memory: 16,
    disk: 160,
    prices: { zzz9: "12.0000" },
  }),
];

/** Builds an image from the documented example. */
export function image(
  id: number,
  name: string | null,
  arch: "x86" | "arm",
  extra: Partial<Image> = {},
): Image {
  const [flavor, version] = (name ?? "unknown-").split("-");
  return {
    ...clone(docImage),
    id,
    type: "system",
    status: "available",
    name,
    description: name ?? "snapshot",
    os_flavor: (flavor as Image["os_flavor"]) ?? "unknown",
    os_version: version ?? null,
    architecture: arch,
    deprecation: null,
    labels: {},
    ...extra,
  };
}

/** Images: supported names on both architectures, plus ones to filter out. */
export const IMAGES: Image[] = [
  image(161547269, "ubuntu-24.04", "x86"),
  image(161547270, "ubuntu-24.04", "arm"),
  image(67794396, "ubuntu-22.04", "x86"),
  image(103908070, "ubuntu-22.04", "arm"),
  image(114690387, "debian-12", "x86"),
  image(114690389, "debian-12", "arm"),
  image(200000001, "fedora-42", "x86"),
  image(200000002, "debian-11", "x86", {
    deprecation: { announced: "2026-08-31T00:00:00Z", unavailable_after: "2026-01-01T00:00:00Z" },
  }),
  image(200000003, null, "x86", { type: "snapshot" }),
];

/** Builds a server from the documented example. */
export function server(overrides: Partial<Server> & { id: number; name: string }): Server {
  const base = clone(docServer);
  return {
    ...base,
    status: "running",
    labels: {},
    ...overrides,
    public_net: overrides.public_net ?? {
      ...base.public_net,
      ipv4: { ...base.public_net.ipv4!, ip: `203.0.113.${overrides.id % 250}` },
      ipv6: { ...base.public_net.ipv6!, ip: `2001:db8:${overrides.id.toString(16)}::/64` },
    },
  };
}

/** Builds an action from the documented example. */
export function action(id: number, command: string, status: Action["status"] = "running"): Action {
  return {
    ...clone(docAction),
    id,
    command,
    status,
    progress: status === "running" ? 0 : 100,
    finished: status === "running" ? null : "2026-10-22T00:00:00Z",
    error: null,
    resources: [],
  };
}
