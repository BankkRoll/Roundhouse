/**
 * Generated hostnames: `<service>-<environment>-<4 chars>.<apps_domain>`.
 *
 * @module
 */
import { slugify } from "./slug";

/** Longest DNS label. */
export const MAX_DNS_LABEL_LENGTH = 63;

/** Longest DNS name. */
export const MAX_HOSTNAME_LENGTH = 253;

/** Length of the random suffix that keeps generated hostnames unique. */
export const HOSTNAME_SUFFIX_LENGTH = 4;

const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Longest environment part, so long environment names don't crowd out the service. */
const MAX_ENV_PART = 20;

/**
 * Builds a generated hostname for a service in an environment. The first
 * label is DNS-safe and at most 63 characters: the service and environment
 * slugs are shortened to fit, the environment first.
 *
 * Callers must retry with a new suffix when the hostname is already taken
 * (`domains.hostname` is unique).
 *
 * @param service - Service name or slug.
 * @param environment - Environment name or slug.
 * @param appsDomain - Parent domain, e.g. `127.0.0.1.nip.io`.
 * @param random - Source of uniform numbers in `[0, 1)`; injected for tests.
 * @returns A lowercase hostname such as `api-production-x7k2.127.0.0.1.nip.io`.
 * @throws RangeError when `appsDomain` leaves no room for the label.
 * @example
 * generatedHostname("API", "production", "apps.example.com", Math.random);
 * // "api-production-q3zk.apps.example.com"
 */
export function generatedHostname(
  service: string,
  environment: string,
  appsDomain: string,
  random: () => number,
): string {
  const domain = appsDomain.toLowerCase().replace(/^\.+|\.+$/g, "");
  let suffix = "";
  for (let i = 0; i < HOSTNAME_SUFFIX_LENGTH; i++) {
    const index = Math.min(
      SUFFIX_ALPHABET.length - 1,
      Math.floor(random() * SUFFIX_ALPHABET.length),
    );
    suffix += SUFFIX_ALPHABET[Math.max(0, index)];
  }
  // Two dashes join the three parts.
  const budget = MAX_DNS_LABEL_LENGTH - HOSTNAME_SUFFIX_LENGTH - 2;
  const env = slugify(environment, MAX_ENV_PART, "env");
  const svc = slugify(service, budget - env.length, "service");
  const hostname = `${svc}-${env}-${suffix}.${domain}`;
  if (!domain || hostname.length > MAX_HOSTNAME_LENGTH) {
    throw new RangeError(`apps domain ${JSON.stringify(appsDomain)} is empty or too long`);
  }
  return hostname;
}
