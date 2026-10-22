/**
 * The default Hetzner firewall for nodes.
 *
 * Agents dial out to the control plane (ADR 0002), so nodes need no inbound
 * control port. The firewall admits only ingress traffic: 80/tcp (HTTP and
 * ACME), 443/tcp (HTTPS), 443/udp (HTTP/3), and optionally 22/tcp. Hetzner
 * blocks all other inbound traffic once a firewall has rules, and allows all
 * outbound traffic when there are no outbound rules.
 *
 * Two variants exist, with and without SSH, so servers provisioned with
 * different SSH choices never fight over one firewall's rules. A managed
 * firewall is created once and never rewritten, so an operator can tighten
 * it (e.g. restrict SSH sources) in the Hetzner console.
 *
 * @module
 */
import type { HetznerClient, RequestOptions } from "./client";
import { HetznerApiError, ProvisionError } from "./errors";
import { isManaged, LABEL_FIREWALL, LABEL_MANAGED } from "./labels";
import type { Firewall, FirewallRule } from "./types";

/** Every IPv4 and IPv6 source. */
const ANYWHERE = ["0.0.0.0/0", "::/0"];

/** Options for the default firewall. */
export interface FirewallOptions {
  /** Also allow inbound 22/tcp from anywhere. Default `false`. */
  allowSsh?: boolean;
}

/**
 * The default firewall's rules.
 *
 * @param options - Whether to allow SSH.
 * @returns Inbound rules for 80/tcp, 443/tcp, 443/udp, and optionally 22/tcp.
 */
export function defaultFirewallRules(options: FirewallOptions = {}): FirewallRule[] {
  const rule = (protocol: "tcp" | "udp", port: string, description: string): FirewallRule => ({
    direction: "in",
    protocol,
    port,
    source_ips: [...ANYWHERE],
    description,
  });
  const rules = [
    rule("tcp", "80", "HTTP ingress and ACME"),
    rule("tcp", "443", "HTTPS ingress"),
    rule("udp", "443", "HTTP/3 ingress"),
  ];
  if (options.allowSsh) rules.unshift(rule("tcp", "22", "SSH"));
  return rules;
}

/**
 * Name and label value of the default firewall variant.
 *
 * @param options - Whether SSH is allowed.
 * @returns `{ name, variant }`.
 */
export function defaultFirewallIdentity(options: FirewallOptions = {}): {
  name: string;
  variant: string;
} {
  const variant = options.allowSsh ? "default-ssh" : "default";
  return { name: `roundhouse-${variant}`, variant };
}

/**
 * Finds or creates the managed default firewall.
 *
 * @param api - Hetzner client.
 * @param options - Whether SSH is allowed.
 * @param request - Signal and timeout.
 * @returns The firewall.
 * @throws ProvisionError `name_taken` when an unmanaged firewall already uses the name.
 */
export async function ensureFirewall(
  api: HetznerClient,
  options: FirewallOptions = {},
  request: RequestOptions = {},
): Promise<Firewall> {
  const { name, variant } = defaultFirewallIdentity(options);
  const selector = `${LABEL_MANAGED}=true,${LABEL_FIREWALL}=${variant}`;
  const [existing] = await api.listFirewalls({ labelSelector: selector }, request);
  if (existing) return existing;
  try {
    const res = await api.createFirewall(
      {
        name,
        labels: { [LABEL_MANAGED]: "true", [LABEL_FIREWALL]: variant },
        rules: defaultFirewallRules(options),
      },
      request,
    );
    return res.firewall;
  } catch (e) {
    // A concurrent provision may have created it first.
    if (!(e instanceof HetznerApiError && e.code === "uniqueness_error")) throw e;
    const [byName] = await api.listFirewalls({ name }, request);
    if (byName && isManaged(byName.labels)) return byName;
    throw new ProvisionError(
      "name_taken",
      `a firewall named ${name} exists but is not managed by Roundhouse`,
      {
        cause: e,
      },
    );
  }
}
