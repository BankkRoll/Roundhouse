/**
 * Wire types for the subset of the DigitalOcean API v2 the adapter uses.
 *
 * Field names match the JSON exactly. Shapes follow the official OpenAPI
 * document at https://github.com/digitalocean/openapi (see SOURCES.md).
 *
 * @module
 */

/** Standard error body. */
export interface DoErrorBody {
  /** Short identifier for the status, e.g. `unprocessable_entity`. */
  id: string;
  message: string;
  request_id?: string;
}

/** `links` of list responses. Only the links that make sense are present. */
export interface DoLinks {
  pages?: { first?: string; prev?: string; next?: string; last?: string };
}

/** `GET /v2/account` subset. */
export interface DoAccount {
  droplet_limit: number;
  email: string;
  name?: string;
  uuid: string;
  email_verified: boolean;
  status: "active" | "warning" | "locked";
  team?: { uuid: string; name: string };
}

/** `GET /v2/sizes` item. */
export interface DoSize {
  slug: string;
  /** MB. */
  memory: number;
  vcpus: number;
  /** GB. */
  disk: number;
  /** Included transfer in TB. */
  transfer: number;
  /** USD. */
  price_monthly: number;
  /** USD. */
  price_hourly: number;
  /** Region slugs the size can be created in. */
  regions: string[];
  available: boolean;
  /** Plan class: `Basic`, `General Purpose`, `CPU-Optimized`, `Memory-Optimized`, `Storage-Optimized`. */
  description: string;
  gpu_info?: { count: number; model: string } | null;
}

/** `GET /v2/regions` item. */
export interface DoRegion {
  name: string;
  slug: string;
  features: string[];
  available: boolean;
  sizes: string[];
}

/** `GET /v2/images` item. */
export interface DoImage {
  id: number;
  name: string;
  distribution: string;
  /** E.g. `ubuntu-24-04-x64`; `null` for private images. */
  slug: string | null;
  public: boolean;
  regions: string[];
  /** DigitalOcean's distribution images report `snapshot`, not `base`. */
  type: string;
  status: "NEW" | "available" | "pending" | "deleted" | "retired";
  description?: string;
}

/** IPv4 network of a droplet. */
export interface DoNetworkV4 {
  ip_address: string;
  netmask: string;
  gateway: string | null;
  type: "public" | "private";
}

/** IPv6 network of a droplet. */
export interface DoNetworkV6 {
  ip_address: string;
  netmask: number;
  gateway: string | null;
  type: "public";
}

/** Droplet status. */
export type DoDropletStatus = "new" | "active" | "off" | "archive";

/** `GET /v2/droplets/{id}` subset. */
export interface DoDroplet {
  id: number;
  name: string;
  memory: number;
  vcpus: number;
  disk: number;
  locked: boolean;
  status: DoDropletStatus;
  created_at: string;
  size_slug: string;
  networks: { v4: DoNetworkV4[]; v6: DoNetworkV6[] };
  region: { slug: string; name: string };
  tags: string[];
}

/** Body of `POST /v2/droplets` (the fields the adapter uses). */
export interface DoCreateDropletBody {
  name: string;
  region: string;
  size: string;
  /** Slug or ID. */
  image: string | number;
  /** Key IDs or fingerprints already on the account. */
  ssh_keys?: (number | string)[];
  ipv6?: boolean;
  monitoring?: boolean;
  /** Existing or new tags. */
  tags?: string[];
  /** Plain text, at most 64 KiB. */
  user_data?: string;
}

/** Response of `POST /v2/droplets`. */
export interface DoCreateDropletResponse {
  droplet: DoDroplet;
  links: { actions: { id: number; rel: string; href: string }[] };
}

/** `GET /v2/actions/{id}` subset. */
export interface DoAction {
  id: number;
  status: "in-progress" | "completed" | "errored";
  type: string;
  started_at: string;
  completed_at: string | null;
  resource_id: number | null;
  resource_type: string;
}

/** Sources or destinations of a firewall rule. */
export interface DoFirewallTargets {
  addresses?: string[];
  droplet_ids?: number[];
  load_balancer_uids?: string[];
  tags?: string[];
}

/** Inbound firewall rule. */
export interface DoInboundRule {
  protocol: "tcp" | "udp" | "icmp";
  /** A port, a range `8000-9000`, or `"0"` for all. */
  ports: string;
  sources: DoFirewallTargets;
}

/** Outbound firewall rule. */
export interface DoOutboundRule {
  protocol: "tcp" | "udp" | "icmp";
  ports: string;
  destinations: DoFirewallTargets;
}

/** `GET /v2/firewalls` item. */
export interface DoFirewall {
  /** UUID. */
  id: string;
  name: string;
  status: "waiting" | "succeeded" | "failed";
  inbound_rules: DoInboundRule[];
  outbound_rules: DoOutboundRule[];
  created_at: string;
  droplet_ids: number[];
  /** Tags the firewall applies to. */
  tags: string[];
}

/** Body of `POST /v2/firewalls`. */
export interface DoCreateFirewallBody {
  name: string;
  inbound_rules: DoInboundRule[];
  outbound_rules: DoOutboundRule[];
  /** Existing tags to apply the firewall to. */
  tags?: string[];
}

/** `GET /v2/account/keys` item. */
export interface DoSshKey {
  id: number;
  fingerprint: string;
  public_key: string;
  name: string;
}
