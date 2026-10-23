/**
 * Wire types for the subset of the Hetzner Cloud API the adapter uses.
 *
 * Field names match the JSON exactly (snake_case) so responses need no
 * mapping. Each type covers only the fields this package reads or sends; the
 * API returns more. Shapes follow the official OpenAPI document at
 * https://docs.hetzner.cloud/cloud.spec.json (see SOURCES.md).
 *
 * @module
 */

/** CPU architecture as Hetzner names it. */
export type HetznerArchitecture = "x86" | "arm";

/** A net/gross price pair. Values are decimal strings, e.g. `"4.7481"`. */
export interface PriceAmount {
  /** Price without VAT. */
  net: string;
  /** Price including the project owner's VAT. */
  gross: string;
}

/**
 * Deprecation info. `null` on the parent means "not deprecated"; any value
 * means deprecated.
 */
export interface DeprecationInfo {
  /** RFC 3339 time the deprecation was announced. */
  announced: string;
  /** RFC 3339 time after which the resource can no longer be ordered. */
  unavailable_after: string;
}

/** Price of a server type in one location. */
export interface ServerTypePrice {
  /** Location name, e.g. `fsn1`. */
  location: string;
  price_hourly: PriceAmount;
  price_monthly: PriceAmount;
  /** Included outbound traffic in bytes. */
  included_traffic: number;
  price_per_tb_traffic: PriceAmount;
}

/** Per-location availability of a server type. */
export interface ServerTypeLocation {
  id: number;
  /** Location name, e.g. `fsn1`. */
  name: string;
  /** Set when the type is deprecated in this location. */
  deprecation: DeprecationInfo | null;
  /** Whether Hetzner recommends this type in this location. */
  recommended: boolean;
  /** `false` while the type is temporarily unavailable (sold out) here. */
  available: boolean;
}

/** `GET /server_types` item. */
export interface ServerType {
  id: number;
  /** Unique name used when ordering, e.g. `cpx22`. */
  name: string;
  description: string;
  /** vCPU count. */
  cores: number;
  /** Memory in GB. */
  memory: number;
  /** Local disk in GB. */
  disk: number;
  /**
   * @deprecated Hetzner removes this field on 2026-11-02. Use
   * `locations[].deprecation` instead.
   */
  deprecated?: boolean;
  prices: ServerTypePrice[];
  storage_type: "local" | "network";
  cpu_type: "shared" | "dedicated";
  /** Marketing category, e.g. `"Shared vCPU"`. Added 2025-08-25. */
  category?: string;
  architecture: HetznerArchitecture;
  /**
   * @deprecated Use `locations[].deprecation` instead.
   */
  deprecation?: DeprecationInfo | null;
  /** Locations the type is offered in. Absent locations are unsupported. */
  locations: ServerTypeLocation[];
}

/** `GET /locations` item. */
export interface Location {
  id: number;
  /** Short name, e.g. `fsn1`. */
  name: string;
  description: string;
  /** ISO 3166-1 alpha-2 country code. */
  country: string;
  city: string;
  latitude: number;
  longitude: number;
  /** Network zone, e.g. `eu-central`. */
  network_zone: string;
}

/** `GET /images` item. */
export interface Image {
  id: number;
  type: "system" | "app" | "snapshot" | "backup";
  status: "available" | "creating" | "unavailable";
  /** Unique name, only set for system images, e.g. `ubuntu-24.04`. */
  name: string | null;
  description: string;
  os_flavor: "ubuntu" | "centos" | "debian" | "fedora" | "rocky" | "alma" | "opensuse" | "unknown";
  os_version: string | null;
  architecture: HetznerArchitecture;
  deprecation: DeprecationInfo | null;
  labels: Record<string, string>;
}

/** `GET /ssh_keys` item. */
export interface SshKey {
  id: number;
  name: string;
  /** MD5 fingerprint, colon separated. */
  fingerprint: string;
  public_key: string;
  labels: Record<string, string>;
  created: string;
}

/** Firewall rule as Hetzner stores it. */
export interface FirewallRule {
  direction: "in" | "out";
  protocol: "tcp" | "udp" | "icmp" | "esp" | "gre";
  /** Port or range (`"1024-5000"`); only for tcp and udp. */
  port?: string | null;
  /** CIDRs; required for inbound rules. */
  source_ips?: string[];
  /** CIDRs; required for outbound rules. */
  destination_ips?: string[];
  description?: string | null;
}

/** Target a firewall is applied to. */
export type FirewallResource =
  | { type: "server"; server: { id: number } }
  | { type: "label_selector"; label_selector: { selector: string } };

/** `GET /firewalls` item. */
export interface Firewall {
  id: number;
  name: string;
  labels: Record<string, string>;
  created: string;
  rules: FirewallRule[];
  applied_to: FirewallResource[];
}

/** Server lifecycle status. */
export type ServerStatus =
  | "running"
  | "initializing"
  | "starting"
  | "stopping"
  | "off"
  | "deleting"
  | "migrating"
  | "rebuilding"
  | "unknown";

/** `GET /servers` item. */
export interface Server {
  id: number;
  /** Unique per project; a valid RFC 1123 hostname. */
  name: string;
  status: ServerStatus;
  created: string;
  public_net: {
    ipv4: { id?: number; ip: string; blocked: boolean; dns_ptr: string } | null;
    /** `ip` is the assigned /64 network, e.g. `2001:db8::/64`. */
    ipv6: { id?: number; ip: string; blocked: boolean } | null;
    firewalls?: { id?: number; status?: "applied" | "pending" }[];
  };
  server_type: ServerType;
  location: Location;
  image: Image | null;
  locked: boolean;
  protection: { delete: boolean; rebuild: boolean };
  labels: Record<string, string>;
}

/** Status of an asynchronous action. */
export type ActionStatus = "running" | "success" | "error";

/** An asynchronous task, polled until it reaches `success` or `error`. */
export interface Action {
  id: number;
  command: string;
  status: ActionStatus;
  /** Percent complete, 0 to 100. */
  progress: number;
  started: string;
  finished: string | null;
  resources: { id: number; type: string }[];
  error: { code: string; message: string } | null;
}

/** `meta.pagination` of list responses. */
export interface Pagination {
  page: number;
  per_page: number;
  previous_page: number | null;
  next_page: number | null;
  last_page: number | null;
  total_entries: number | null;
}

/** `GET /pricing` subset. */
export interface Pricing {
  /** Currency of the project owner, e.g. `EUR`. */
  currency: string;
  /** VAT rate applied to gross prices, as a decimal string percentage. */
  vat_rate: string;
}

/** Body of `POST /servers` (the fields this package uses). */
export interface CreateServerBody {
  name: string;
  /** ID or name. */
  server_type: string;
  /** Location name. */
  location?: string;
  /** Image ID (as a string) or name. */
  image: string;
  /** SSH key IDs or names. */
  ssh_keys?: (number | string)[];
  firewalls?: { firewall: number }[];
  /** cloud-init user data, at most 32 KiB. */
  user_data?: string;
  labels?: Record<string, string>;
  start_after_create?: boolean;
  public_net?: { enable_ipv4?: boolean; enable_ipv6?: boolean };
}

/** Response of `POST /servers`. */
export interface CreateServerResponse {
  server: Server;
  action: Action;
  next_actions: Action[];
  /** Set only when no SSH key was given. Never log or return it. */
  root_password: string | null;
}

/** Body of `POST /firewalls`. */
export interface CreateFirewallBody {
  name: string;
  labels?: Record<string, string>;
  rules?: FirewallRule[];
  apply_to?: FirewallResource[];
}

/** Response of `POST /firewalls`. */
export interface CreateFirewallResponse {
  firewall: Firewall;
  actions: Action[];
}

/** Body of `POST /ssh_keys`. */
export interface CreateSshKeyBody {
  name: string;
  public_key: string;
  labels?: Record<string, string>;
}
