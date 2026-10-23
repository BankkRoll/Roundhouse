/**
 * Wire types for the subset of the Linode (Akamai) API v4 the adapter uses.
 *
 * Field names match the JSON exactly. Shapes follow the official OpenAPI
 * document at https://github.com/linode/linode-api-docs (see SOURCES.md).
 *
 * @module
 */

/** Error body. `field` is absent or `null` when no field is involved. */
export interface LinodeErrorBody {
  errors: { field?: string | null; reason: string }[];
}

/** Paginated envelope. */
export interface LinodePage<T> {
  data: T[];
  page: number;
  pages: number;
  results: number;
}

/** `GET /v4/profile` subset. */
export interface LinodeProfile {
  uid: number;
  username: string;
  email: string;
  /** Restricted users need grants and cannot tag Linodes. */
  restricted: boolean;
}

/** Plan class. */
export type LinodeTypeClass =
  | "nanode"
  | "standard"
  | "dedicated"
  | "premium"
  | "gpu"
  | "accelerated"
  | "highmem";

/** `GET /v4/linode/types` item. */
export interface LinodeType {
  /** E.g. `g6-standard-2`. */
  id: string;
  label: string;
  class: LinodeTypeClass;
  vcpus: number;
  /** MB. */
  memory: number;
  /** MB. */
  disk: number;
  /** Monthly outbound transfer quota (GB, despite the spec's wording). */
  transfer: number;
  /** USD, outside {@link LinodeType.region_prices} regions. */
  price: { hourly: number; monthly: number };
  /** Regions where the price differs. */
  region_prices: { id: string; hourly: number; monthly: number }[];
  /** The type that replaces this one, when it is being retired. */
  successor: string | null;
  gpus: number;
}

/** `GET /v4/regions` item. */
export interface LinodeRegion {
  /** E.g. `us-east`. */
  id: string;
  /** E.g. `Newark, NJ`. */
  label: string;
  /** Lowercase ISO 3166-1 alpha-2. */
  country: string;
  /** Includes `Linodes`, `Metadata`, `Cloud Firewall`, `Premium Plans`. */
  capabilities: string[];
  status: "ok" | "outage";
  site_type: "core" | "distributed";
}

/** `GET /v4/images` item. */
export interface LinodeImage {
  /** E.g. `linode/ubuntu24.04`. */
  id: string;
  label: string;
  vendor: string | null;
  is_public: boolean;
  deprecated: boolean;
  status: "creating" | "pending_upload" | "available";
  /** `cloud-init` marks images that read Metadata user data. */
  capabilities: string[];
  eol: string | null;
  type: "manual" | "automatic" | "shared";
}

/** Linode status. */
export type LinodeStatus =
  | "running"
  | "offline"
  | "booting"
  | "busy"
  | "rebooting"
  | "shutting_down"
  | "provisioning"
  | "deleting"
  | "migrating"
  | "rebuilding"
  | "cloning"
  | "restoring"
  | "stopped"
  | "billing_suspension";

/** `GET /v4/linode/instances/{id}` subset. */
export interface Linode {
  id: number;
  label: string;
  status: LinodeStatus;
  created: string;
  region: string;
  type: string;
  image: string | null;
  tags: string[];
  /** Public and private IPv4 addresses. */
  ipv4: string[];
  /** SLAAC address with prefix, e.g. `2600:3c00::f03c:91ff:fe24:3a2f/128`, or `null`. */
  ipv6: string | null;
  has_user_data?: boolean;
}

/** Body of `POST /v4/linode/instances` (the fields the adapter uses). */
export interface LinodeCreateBody {
  label: string;
  region: string;
  type: string;
  image: string;
  /** Required with an image; generated and discarded by the adapter. */
  root_pass: string;
  authorized_keys?: string[];
  tags: string[];
  firewall_id: number;
  /** Base64 cloud-config, at most 65 535 bytes before encoding. */
  metadata: { user_data: string };
  booted: boolean;
}

/** Firewall rule. */
export interface LinodeFirewallRule {
  action: "ACCEPT" | "DROP";
  protocol: "TCP" | "UDP" | "ICMP" | "IPENCAP";
  /** E.g. `"80"` or `"22-24, 80"`. */
  ports?: string;
  /** Omit a family rather than sending an empty list. */
  addresses: { ipv4?: string[]; ipv6?: string[] };
  label?: string;
  description?: string;
}

/** Firewall rule set. */
export interface LinodeFirewallRules {
  inbound_policy: "ACCEPT" | "DROP";
  outbound_policy: "ACCEPT" | "DROP";
  inbound: LinodeFirewallRule[];
  outbound: LinodeFirewallRule[];
}

/** `GET /v4/networking/firewalls` item. */
export interface LinodeFirewall {
  id: number;
  /** 3-32 characters, unique on the account. */
  label: string;
  status: "enabled" | "disabled" | "deleted";
  rules: LinodeFirewallRules;
  tags: string[];
  created: string;
}

/** Body of `POST /v4/networking/firewalls`. */
export interface LinodeCreateFirewallBody {
  label: string;
  rules: LinodeFirewallRules;
  tags: string[];
}
