/**
 * Wire types for the subset of the Vultr API v2 the adapter uses.
 *
 * Field names match the JSON exactly. Shapes follow the official OpenAPI
 * document embedded in https://www.vultr.com/api/ (see SOURCES.md).
 *
 * @module
 */

/** Error body of 4xx responses. */
export interface VultrErrorBody {
  error: string;
  status: number;
}

/** `meta` of list responses; `links.next` is `""` on the last page. */
export interface VultrMeta {
  total: number;
  links: { next: string; prev: string };
}

/** `GET /v2/account` subset. */
export interface VultrAccount {
  name: string;
  email: string;
  /** Permissions of the user that owns the key. */
  acls: string[];
}

/** Per-region price override of a plan. */
export interface VultrLocationCost {
  monthly_cost: number;
  hourly_cost: number;
}

/** `GET /v2/plans` item. */
export interface VultrPlan {
  id: string;
  vcpu_count: number;
  /** MB. */
  ram: number;
  /** GB. */
  disk: number;
  disk_count: number;
  /** Included bandwidth in GB. */
  bandwidth: number;
  /** USD, the price outside {@link VultrPlan.location_cost} regions. */
  monthly_cost: number;
  hourly_cost: number;
  /** `vc2`, `vhf`, `vhp`, `voc`, `vcg`, … */
  type: string;
  /** Regions the plan can be deployed in now. */
  locations: string[];
  /** Regions where the price differs from `monthly_cost`. */
  location_cost?: Record<string, VultrLocationCost>;
  cpu_vendor?: string;
  /** `none` for plans without a GPU. */
  gpu_brand?: string;
  /** `false` for plans that cannot be deployed on demand. */
  deploy_ondemand?: boolean;
}

/** `GET /v2/regions` item. */
export interface VultrRegion {
  id: string;
  city: string;
  country: string;
  continent: string;
  options: string[];
}

/** `GET /v2/os` item. */
export interface VultrOs {
  id: number;
  /** E.g. `Ubuntu 24.04 LTS x64` or `Debian 12 x64 (bookworm)`. */
  name: string;
  arch: string;
  family: string;
}

/** Instance lifecycle. */
export type VultrInstanceStatus = "active" | "pending" | "suspended" | "resizing";

/** `GET /v2/instances/{id}` subset. */
export interface VultrInstance {
  /** UUID. */
  id: string;
  os: string;
  ram: number;
  disk: number;
  /** `"0.0.0.0"` until assigned. */
  main_ip: string;
  vcpu_count: number;
  region: string;
  plan: string;
  date_created: string;
  status: VultrInstanceStatus;
  power_status: "running" | "stopped";
  server_status: "none" | "locked" | "installingbooting" | "ok";
  /** `""` until assigned. */
  v6_main_ip: string;
  label: string;
  hostname: string;
  os_id: number;
  firewall_group_id: string;
  tags: string[];
  /** Only in the create response, for ten minutes. Never surfaced. */
  default_password?: string;
}

/** Body of `POST /v2/instances` (the fields the adapter uses). */
export interface VultrCreateInstanceBody {
  region: string;
  plan: string;
  os_id: number;
  label: string;
  hostname: string;
  tags: string[];
  /** Base64. */
  user_data: string;
  enable_ipv6: boolean;
  sshkey_id?: string[];
  firewall_group_id: string;
  backups: "enabled" | "disabled";
  activation_email: boolean;
}

/** `GET /v2/firewalls` item. */
export interface VultrFirewallGroup {
  id: string;
  description: string;
  date_created: string;
  date_modified: string;
  instance_count: number;
  rule_count: number;
  max_rule_count: number;
}

/** Body of `POST /v2/firewalls/{id}/rules`. */
export interface VultrCreateRuleBody {
  ip_type: "v4" | "v6";
  protocol: "tcp" | "udp";
  /** A port or `from:to`. */
  port: string;
  subnet: string;
  subnet_size: number;
  source: string;
  notes: string;
}

/** `GET /v2/firewalls/{id}/rules` item. */
export interface VultrFirewallRule extends VultrCreateRuleBody {
  id: number;
  action: "accept";
}

/** `GET /v2/ssh-keys` item. */
export interface VultrSshKey {
  id: string;
  date_created: string;
  name: string;
  ssh_key: string;
}
