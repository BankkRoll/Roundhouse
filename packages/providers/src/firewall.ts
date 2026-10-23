/**
 * The provider-neutral default firewall for nodes.
 *
 * Agents dial out to the control plane (ADR 0002), so nodes need no inbound
 * control port. The firewall admits only ingress traffic: 80/tcp (HTTP and
 * ACME), 443/tcp (HTTPS), 443/udp (HTTP/3), and optionally 22/tcp. All
 * other inbound traffic is dropped and all outbound traffic is allowed.
 * Each adapter maps these rules onto its provider's firewall product (some
 * need explicit outbound rules to allow egress).
 *
 * Two variants exist, with and without SSH, so servers provisioned with
 * different SSH choices never fight over one firewall's rules. A managed
 * firewall is created once and never rewritten, so an operator can tighten
 * it (e.g. restrict SSH sources) in the provider's console.
 *
 * @module
 */

/** Every IPv4 and IPv6 source. */
export const ANYWHERE_V4 = "0.0.0.0/0";
/** Every IPv6 source. */
export const ANYWHERE_V6 = "::/0";

/** One inbound allow rule. */
export interface FirewallRule {
  /** Transport protocol. */
  protocol: "tcp" | "udp";
  /** Destination port. */
  port: number;
  /** Source CIDRs (IPv4 and IPv6). */
  sources: string[];
  /** Short human-readable purpose, shown in provider consoles. */
  description: string;
}

/** Options for the default firewall. */
export interface FirewallOptions {
  /** Also allow inbound 22/tcp from anywhere. Default `false`. */
  allowSsh?: boolean;
}

/** The managed default firewall a provision needs. */
export interface FirewallSpec {
  /** Name to create it under, e.g. `roundhouse-default`. */
  name: string;
  /** Variant, stored as the `roundhouse.firewall` label: `default` or `default-ssh`. */
  variant: "default" | "default-ssh";
  /** Inbound allow rules; everything else inbound is dropped. */
  rules: FirewallRule[];
}

/**
 * The default firewall's inbound rules.
 *
 * @param options - Whether to allow SSH.
 * @returns Rules for 80/tcp, 443/tcp, 443/udp, and optionally 22/tcp first.
 */
export function defaultFirewallRules(options: FirewallOptions = {}): FirewallRule[] {
  const rule = (protocol: "tcp" | "udp", port: number, description: string): FirewallRule => ({
    protocol,
    port,
    sources: [ANYWHERE_V4, ANYWHERE_V6],
    description,
  });
  const rules = [
    rule("tcp", 80, "HTTP ingress and ACME"),
    rule("tcp", 443, "HTTPS ingress"),
    rule("udp", 443, "HTTP/3 ingress"),
  ];
  if (options.allowSsh) rules.unshift(rule("tcp", 22, "SSH"));
  return rules;
}

/**
 * The full spec of the default firewall variant.
 *
 * @param options - Whether SSH is allowed.
 * @returns Name, variant, and rules.
 * @example
 * defaultFirewall({ allowSsh: true }).name; // "roundhouse-default-ssh"
 */
export function defaultFirewall(options: FirewallOptions = {}): FirewallSpec {
  const variant = options.allowSsh ? "default-ssh" : "default";
  return { name: `roundhouse-${variant}`, variant, rules: defaultFirewallRules(options) };
}
