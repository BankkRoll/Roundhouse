/**
 * Published security advisories for comparable self-hosted deploy platforms, and the
 * Roundhouse design choice that blocks each kind of flaw.
 *
 * Every entry was checked against the vendor's own advisory (NVD where the vendor
 * published none) on {@link ADVISORIES_AS_OF}; none is recalled from memory. Where the
 * vendor and NVD disagree, the vendor's value is kept; a fixed version that only NVD
 * states is marked with its source. A kind of flaw maps to a defence only where the
 * defence is real (`defences.ts` names the code behind each), and the explanation says
 * where it narrows a class rather than ruling it out.
 *
 * @module
 */
import type { DefenceId } from "./defences";

/** Severity as the advisory rates it. */
export type Severity = "critical" | "high" | "medium" | "low";

/** Kind of flaw, the filter the table offers. */
export type AdvisoryClass =
  | "command-injection"
  | "access-control"
  | "auth-bypass"
  | "privilege-escalation"
  | "secret-exposure"
  | "path-traversal"
  | "insecure-defaults"
  | "ssrf"
  | "csrf"
  | "xss";

/** One published advisory. */
export interface Advisory {
  /** The affected platform, e.g. "Coolify". */
  product: string;
  /** CVE identifier. */
  id: string;
  /** The vendor's GitHub advisory identifier, when there is one. */
  ghsa: string | null;
  /** Publication date, `YYYY-MM-DD`. */
  published: string;
  severity: Severity;
  /** CVSS base score, or `null` when the advisory gives only a rating. */
  score: number | null;
  /** CVSS version of {@link Advisory.score}. */
  cvss: string | null;
  /** Affected versions as the vendor lists them. */
  affectedVersions: string;
  /** First fixed version, or `null` when no advisory states one. */
  fixedVersion: string | null;
  /** `"NVD"` when only NVD states the fixed version; `null` when the vendor does. */
  fixedSource: "NVD" | null;
  kind: AdvisoryClass;
  /** One plain sentence on what went wrong. */
  summary: string;
  /** The vendor's advisory, or NVD where the vendor published none. */
  url: string;
  /** The NVD entry. */
  nvdUrl: string;
}

/** A vendor page listing more advisories of a kind than the table shows. */
export interface MoreAdvisories {
  product: string;
  url: string;
}

/** What a kind of flaw is called and what stands in its way here. */
export interface ClassInfo {
  /** Plain sentence-case name, shown on the filter. */
  label: string;
  /** The name security people use for it. */
  term: string;
  /** Defences that block or narrow it. */
  defences: readonly DefenceId[];
  /** Why those defences help, and where they stop. */
  why: string;
  /** Vendors' pages listing more advisories of this kind than the table shows. */
  more?: readonly MoreAdvisories[];
}

/** The date every entry was last checked against its advisory. */
export const ADVISORIES_AS_OF = "2026-10-31";

/** Every advisory, in no particular order; {@link sortAdvisories} orders them. */
export const ADVISORIES: readonly Advisory[] = [
  {
    product: "Coolify",
    id: "CVE-2025-22612",
    ghsa: "GHSA-wg8x-cgq4-vjxj",
    published: "2025-01-24",
    severity: "critical",
    score: 10,
    cvss: "3.1",
    affectedVersions: "< v4.0.0-beta.374",
    fixedVersion: "v4.0.0-beta.374",
    fixedSource: null,
    kind: "access-control",
    summary:
      "Any logged-in user could read every SSH private key stored on the instance in plain text and use it to run commands on the servers those keys unlock.",
    url: "https://github.com/coollabsio/coolify/security/advisories/GHSA-wg8x-cgq4-vjxj",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2025-22612",
  },
  {
    product: "Coolify",
    id: "CVE-2025-22611",
    ghsa: "GHSA-9w72-9qww-qj6g",
    published: "2025-01-24",
    severity: "critical",
    score: 9.9,
    cvss: "3.1",
    affectedVersions: "< v4.0.0-beta.361",
    fixedVersion: "v4.0.0-beta.361",
    fixedSource: null,
    kind: "privilege-escalation",
    summary:
      "Any authenticated team member could promote themselves (or anyone) to owner, remove other admins, and then use the terminal feature to run commands on servers.",
    url: "https://github.com/coollabsio/coolify/security/advisories/GHSA-9w72-9qww-qj6g",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2025-22611",
  },
  {
    product: "Coolify",
    id: "CVE-2025-22607",
    ghsa: "GHSA-8w24-gfgq-jg72",
    published: "2025-01-24",
    severity: "high",
    score: null,
    cvss: null,
    affectedVersions: "< v4.0.0-beta.361",
    fixedVersion: "v4.0.0-beta.361",
    fixedSource: null,
    kind: "secret-exposure",
    summary:
      "Any authenticated user who knew a source's UUID could view its GitHub/GitLab OAuth client secret and webhook secret.",
    url: "https://github.com/coollabsio/coolify/security/advisories/GHSA-8w24-gfgq-jg72",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2025-22607",
  },
  {
    product: "Coolify",
    id: "CVE-2025-59157",
    ghsa: "GHSA-5cg9-38qj-8mc3",
    published: "2026-01-03",
    severity: "critical",
    score: 9.9,
    cvss: "3.1",
    affectedVersions: "<= v4.0.0-beta.420.6",
    fixedVersion: "v4.0.0-beta.420.7",
    fixedSource: null,
    kind: "command-injection",
    summary:
      "A low-privileged user could put shell syntax in the Git repository field of a new resource and get commands executed on the host during deployment.",
    url: "https://github.com/coollabsio/coolify/security/advisories/GHSA-5cg9-38qj-8mc3",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2025-59157",
  },
  {
    product: "Coolify",
    id: "CVE-2025-59158",
    ghsa: "GHSA-h52r-jxv9-9vhf",
    published: "2026-01-03",
    severity: "critical",
    score: 9.4,
    cvss: "4.0",
    affectedVersions: "<= v4.0.0-beta.420.6",
    fixedVersion: "v4.0.0-beta.420.7",
    fixedSource: null,
    kind: "xss",
    summary:
      "A low-privileged member could store JavaScript in a project name that runs in an administrator's browser.",
    url: "https://github.com/coollabsio/coolify/security/advisories/GHSA-h52r-jxv9-9vhf",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2025-59158",
  },
  {
    product: "Coolify",
    id: "CVE-2025-64420",
    ghsa: "GHSA-qwxj-qch7-whpc",
    published: "2026-01-03",
    severity: "critical",
    score: 9.9,
    cvss: "3.1",
    affectedVersions: "<= v4.0.0-beta.434",
    fixedVersion: null,
    fixedSource: null,
    kind: "secret-exposure",
    summary:
      "Low-privileged members could view the root SSH private key of the server Coolify runs on and log in to it as root.",
    url: "https://github.com/coollabsio/coolify/security/advisories/GHSA-qwxj-qch7-whpc",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2025-64420",
  },
  {
    product: "Coolify",
    id: "CVE-2026-34048",
    ghsa: "GHSA-mw6q-2hmg-mhxv",
    published: "2026-07-02",
    severity: "critical",
    score: 9.9,
    cvss: "3.1",
    affectedVersions: "<= 4.0.0-beta.470",
    fixedVersion: "4.0.0-beta.471",
    fixedSource: null,
    kind: "access-control",
    summary:
      "The terminal websocket routes only checked that a user was logged in, so a low-privileged member could open an admin-only terminal and run commands on team servers.",
    url: "https://github.com/coollabsio/coolify/security/advisories/GHSA-mw6q-2hmg-mhxv",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-34048",
  },
  {
    product: "Coolify",
    id: "CVE-2026-57498",
    ghsa: "GHSA-725v-f5gh-22q9",
    published: "2026-06-28",
    severity: "critical",
    score: 9.6,
    cvss: "3.1",
    affectedVersions: "< v4.0.0-beta.474",
    fixedVersion: "v4.0.0-beta.474",
    fixedSource: null,
    kind: "access-control",
    summary:
      "Web UI components accepted server and destination IDs without checking team ownership, letting a user deploy resources onto another team's servers.",
    url: "https://github.com/coollabsio/coolify/security/advisories/GHSA-725v-f5gh-22q9",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-57498",
  },
  {
    product: "Coolify",
    id: "CVE-2026-41896",
    ghsa: "GHSA-w8wm-r924-f65v",
    published: "2026-06-25",
    severity: "high",
    score: 7.5,
    cvss: "3.1",
    affectedVersions: "<= 4.0.0-beta.473",
    fixedVersion: "v4.0.0-beta.474",
    fixedSource: null,
    kind: "auth-bypass",
    summary:
      "When a Git webhook had no secret configured, signature checking could be bypassed so an unauthenticated attacker could trigger deployments.",
    url: "https://github.com/coollabsio/coolify/security/advisories/GHSA-w8wm-r924-f65v",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-41896",
  },
  {
    product: "Coolify",
    id: "CVE-2026-34171",
    ghsa: "GHSA-389w-cc6x-wr2m",
    published: "2026-07-02",
    severity: "high",
    score: 8,
    cvss: "3.1",
    affectedVersions: "< v4.0.0-beta.471",
    fixedVersion: "v4.0.0-beta.471",
    fixedSource: null,
    kind: "csrf",
    summary:
      "A state-changing GET link could reset a victim's password to a value the attacker knows, so getting a user to click it led to account takeover.",
    url: "https://github.com/coollabsio/coolify/security/advisories/GHSA-389w-cc6x-wr2m",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-34171",
  },
  {
    product: "Coolify",
    id: "CVE-2026-34170",
    ghsa: "GHSA-3g6r-cxv5-3c7h",
    published: "2026-07-02",
    severity: "medium",
    score: 4.3,
    cvss: "3.1",
    affectedVersions: "< v4.0.0-beta.471",
    fixedVersion: "v4.0.0-beta.471",
    fixedSource: null,
    kind: "ssrf",
    summary:
      "Any authenticated user could set a GitHub App API URL pointing at internal addresses (cloud metadata, localhost services) and make the Coolify server send requests there.",
    url: "https://github.com/coollabsio/coolify/security/advisories/GHSA-3g6r-cxv5-3c7h",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-34170",
  },
  {
    product: "Coolify",
    id: "CVE-2026-42200",
    ghsa: "GHSA-mv4c-9x67-rrmv",
    published: "2026-07-02",
    severity: "high",
    score: 8.8,
    cvss: "3.1",
    affectedVersions: "<= 4.0.0-beta.473",
    fixedVersion: "4.0.0-beta.474",
    fixedSource: null,
    kind: "path-traversal",
    summary:
      "A crafted PostgreSQL init-script filename let any authenticated user write arbitrary files on the host, leading to root code execution.",
    url: "https://github.com/coollabsio/coolify/security/advisories/GHSA-mv4c-9x67-rrmv",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-42200",
  },
  {
    product: "Dokploy",
    id: "CVE-2026-45631",
    ghsa: "GHSA-w3gm-rc4p-9rhj",
    published: "2026-05-11",
    severity: "critical",
    score: 10,
    cvss: "3.1",
    affectedVersions: ">= 0.27.0, <= 0.28.8",
    fixedVersion: "0.29.3",
    fixedSource: "NVD",
    kind: "insecure-defaults",
    summary:
      "A hardcoded fallback auth secret let an unauthenticated attacker forge tokens, sign in as admin and run commands on the host.",
    url: "https://github.com/Dokploy/dokploy/security/advisories/GHSA-w3gm-rc4p-9rhj",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-45631",
  },
  {
    product: "Dokploy",
    id: "CVE-2025-53825",
    ghsa: "GHSA-h67g-mpq5-6ph5",
    published: "2025-07-14",
    severity: "critical",
    score: 9.8,
    cvss: "3.1",
    affectedVersions: "< 0.24.3",
    fixedVersion: "0.24.3",
    fixedSource: null,
    kind: "command-injection",
    summary:
      "Anyone could open a pull request on a public repo that uses preview deployments to run their code on the server and read the app's secret environment variables.",
    url: "https://github.com/Dokploy/dokploy/security/advisories/GHSA-h67g-mpq5-6ph5",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2025-53825",
  },
  {
    product: "Dokploy",
    id: "CVE-2026-24840",
    ghsa: "GHSA-jr65-3j3w-gjmc",
    published: "2026-01-27",
    severity: "high",
    score: 8,
    cvss: "3.1",
    affectedVersions: "<= v0.25.10",
    fixedVersion: "0.26.6",
    fixedSource: null,
    kind: "insecure-defaults",
    summary:
      "The install script created the database with the same hardcoded password on nearly every installation, so anyone reaching the internal network could access it.",
    url: "https://github.com/Dokploy/dokploy/security/advisories/GHSA-jr65-3j3w-gjmc",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-24840",
  },
  {
    product: "Dokploy",
    id: "CVE-2026-72864",
    ghsa: "GHSA-899j-cjwp-v4gw",
    published: "2026-07-21",
    severity: "critical",
    score: 9.9,
    cvss: "3.1",
    affectedVersions: "v0.29.8",
    fixedVersion: "v0.29.13",
    fixedSource: null,
    kind: "access-control",
    summary:
      "The container-terminal websocket checked only for a valid session, so any member could open a root shell in arbitrary containers.",
    url: "https://github.com/Dokploy/dokploy/security/advisories/GHSA-899j-cjwp-v4gw",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-72864",
  },
  {
    product: "Dokploy",
    id: "CVE-2026-72737",
    ghsa: "GHSA-56qv-89fq-3h2q",
    published: "2026-07-21",
    severity: "critical",
    score: 9.6,
    cvss: "3.1",
    affectedVersions: "<= 0.29.8",
    fixedVersion: null,
    fixedSource: null,
    kind: "access-control",
    summary:
      "A member could point their backups at another organization's backup destination, exposing that tenant's S3 credentials and backups.",
    url: "https://github.com/Dokploy/dokploy/security/advisories/GHSA-56qv-89fq-3h2q",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-72737",
  },
  {
    product: "Dokploy",
    id: "CVE-2026-45661",
    ghsa: "GHSA-66v7-g3fh-47h3",
    published: "2026-05-11",
    severity: "critical",
    score: 9.9,
    cvss: "3.1",
    affectedVersions: "<= 0.26.5",
    fixedVersion: null,
    fixedSource: null,
    kind: "path-traversal",
    summary:
      "Authenticated users could write arbitrary files during deployment, including onto remote servers, and turn that into code execution via cron.",
    url: "https://github.com/Dokploy/dokploy/security/advisories/GHSA-66v7-g3fh-47h3",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-45661",
  },
  {
    product: "Dokploy",
    id: "CVE-2025-53375",
    ghsa: "GHSA-vq94-qm94-mxp6",
    published: "2025-07-05",
    severity: "medium",
    score: null,
    cvss: null,
    affectedVersions: "< 0.23.6",
    fixedVersion: "0.23.7",
    fixedSource: null,
    kind: "path-traversal",
    summary:
      "An authenticated attacker could read any file the Traefik process can access, including credential and environment files.",
    url: "https://github.com/Dokploy/dokploy/security/advisories/GHSA-vq94-qm94-mxp6",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2025-53375",
  },
  {
    product: "Dokploy",
    id: "CVE-2026-45790",
    ghsa: "GHSA-fm9p-wmpw-gxjh",
    published: "2026-07-21",
    severity: "high",
    score: 8,
    cvss: "3.1",
    affectedVersions: "< 0.29.4",
    fixedVersion: "0.29.6",
    fixedSource: "NVD",
    kind: "privilege-escalation",
    summary:
      "A user allowed to invite members could invite an account with the owner role, giving a permanent organization takeover.",
    url: "https://github.com/Dokploy/dokploy/security/advisories/GHSA-fm9p-wmpw-gxjh",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-45790",
  },
  {
    product: "Dokploy",
    id: "CVE-2026-72871",
    ghsa: "GHSA-g9pp-xcf2-ph7x",
    published: "2026-07-21",
    severity: "high",
    score: 7.5,
    cvss: "3.1",
    affectedVersions: "< 0.29.4",
    fixedVersion: "0.29.13",
    fixedSource: "NVD",
    kind: "auth-bypass",
    summary:
      "The unauthenticated GitHub App setup callback let an attacker inject their own Git provider configuration into any organization.",
    url: "https://github.com/Dokploy/dokploy/security/advisories/GHSA-g9pp-xcf2-ph7x",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-72871",
  },
  {
    product: "Dokku",
    id: "CVE-2026-86002",
    ghsa: "GHSA-fccf-j7qf-2xp9",
    published: "2026-09-24",
    severity: "critical",
    score: 9,
    cvss: "3.1",
    affectedVersions: "< 0.38.24",
    fixedVersion: "0.38.25",
    fixedSource: null,
    kind: "command-injection",
    summary:
      "A user with app-level Dokku access could store Docker options containing shell substitutions that are later evaluated, running commands on the host.",
    url: "https://github.com/dokku/dokku/security/advisories/GHSA-fccf-j7qf-2xp9",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-86002",
  },
  {
    product: "Dokku",
    id: "CVE-2026-45405",
    ghsa: "GHSA-j6qq-xg73-ghqg",
    published: "2026-05-13",
    severity: "critical",
    score: 9,
    cvss: "3.1",
    affectedVersions: "< 0.38.2",
    fixedVersion: "0.38.2",
    fixedSource: null,
    kind: "path-traversal",
    summary:
      "Uploaded tar/zip archives with symlinks could write files anywhere the dokku user can write, such as authorized_keys, giving shell access.",
    url: "https://github.com/dokku/dokku/security/advisories/GHSA-j6qq-xg73-ghqg",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-45405",
  },
  {
    product: "Dokku",
    id: "CVE-2026-45407",
    ghsa: "GHSA-xh7p-9crg-pchr",
    published: "2026-05-13",
    severity: "medium",
    score: 5,
    cvss: "3.1",
    affectedVersions: "< 0.38.2",
    fixedVersion: "0.38.2",
    fixedSource: null,
    kind: "secret-exposure",
    summary:
      "Git credentials saved with git:auth were stored in a world-readable .netrc file that other local users could read.",
    url: "https://github.com/dokku/dokku/security/advisories/GHSA-xh7p-9crg-pchr",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-45407",
  },
  {
    product: "Kubero",
    id: "CVE-2026-92720",
    ghsa: null,
    published: "2026-09-16",
    severity: "critical",
    score: 9.3,
    cvss: "4.0",
    affectedVersions: "<= 3.1.1",
    fixedVersion: null,
    fixedSource: null,
    kind: "auth-bypass",
    summary:
      "The notifications API had no authentication guard, so unauthenticated attackers could read webhook secrets and add or delete notification webhooks.",
    url: "https://nvd.nist.gov/vuln/detail/CVE-2026-92720",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-92720",
  },
  {
    product: "Portainer",
    id: "CVE-2026-44848",
    ghsa: "GHSA-rrmm-9v76-h3p4",
    published: "2026-05-10",
    severity: "critical",
    score: 9.4,
    cvss: "4.0",
    affectedVersions: ">= 2.33.0 < 2.33.8; >= 2.39.0 < 2.39.2; >= 2.40.0 < 2.41.0",
    fixedVersion: "2.33.8 / 2.39.2 / 2.41.0",
    fixedSource: null,
    kind: "access-control",
    summary:
      "Docker plugin endpoints had no authorization handler, so standard users could install privileged plugins and gain code execution on the host.",
    url: "https://github.com/portainer/portainer/security/advisories/GHSA-rrmm-9v76-h3p4",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-44848",
  },
  {
    product: "Portainer",
    id: "CVE-2026-55761",
    ghsa: "GHSA-x626-fcwx-f5pc",
    published: "2026-07-02",
    severity: "high",
    score: 7.1,
    cvss: "4.0",
    affectedVersions: ">= 2.39.0 < 2.39.4; >= 2.40.0 < 2.43.0",
    fixedVersion: "2.39.4 / 2.43.0",
    fixedSource: null,
    kind: "auth-bypass",
    summary:
      "On an instance not yet initialised, an unauthenticated attacker could use the restore or admin-creation endpoints to take over as administrator.",
    url: "https://github.com/portainer/portainer/security/advisories/GHSA-x626-fcwx-f5pc",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-55761",
  },
  {
    product: "Portainer",
    id: "CVE-2026-72533",
    ghsa: "GHSA-jxhm-qq8x-v4c6",
    published: "2026-08-18",
    severity: "critical",
    score: 9.4,
    cvss: "4.0",
    affectedVersions: ">= 2.39.0 < 2.39.7; >= 2.40.0 < 2.45.0",
    fixedVersion: "2.39.7 / 2.45.0",
    fixedSource: null,
    kind: "auth-bypass",
    summary:
      "Unusual Docker API version prefixes slipped past the proxy's access-control routing, giving authenticated non-admins direct Docker API access.",
    url: "https://github.com/portainer/portainer/security/advisories/GHSA-jxhm-qq8x-v4c6",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-72533",
  },
  {
    product: "Portainer",
    id: "CVE-2026-44850",
    ghsa: "GHSA-7fw3-x4r2-g7wc",
    published: "2026-05-10",
    severity: "high",
    score: 8.5,
    cvss: "3.1",
    affectedVersions: ">= 2.33.0 < 2.33.8; >= 2.39.0 < 2.39.2; >= 2.40.0 < 2.41.0",
    fixedVersion: "2.33.8 / 2.39.2 / 2.41.0",
    fixedSource: null,
    kind: "privilege-escalation",
    summary:
      'The "disable bind mounts for non-admins" setting could be bypassed with an alternative mount field, letting users mount host paths into containers.',
    url: "https://github.com/portainer/portainer/security/advisories/GHSA-7fw3-x4r2-g7wc",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-44850",
  },
  {
    product: "Portainer",
    id: "CVE-2026-44883",
    ghsa: "GHSA-jvp4-q659-95mj",
    published: "2026-05-10",
    severity: "high",
    score: 7.7,
    cvss: "4.0",
    affectedVersions: ">= 2.33.0 < 2.33.8; >= 2.39.0 < 2.39.2; >= 2.40.0 < 2.41.0",
    fixedVersion: "2.33.8 / 2.39.2 / 2.41.0",
    fixedSource: null,
    kind: "secret-exposure",
    summary:
      "Session JWTs were accepted in URL query strings, so they leaked into proxy logs, browser history and Referer headers where others could reuse them.",
    url: "https://github.com/portainer/portainer/security/advisories/GHSA-jvp4-q659-95mj",
    nvdUrl: "https://nvd.nist.gov/vuln/detail/CVE-2026-44883",
  },
];

/** Kinds of flaw in filter order: the most damaging and most common first. */
export const CLASS_ORDER: readonly AdvisoryClass[] = [
  "command-injection",
  "access-control",
  "auth-bypass",
  "privilege-escalation",
  "secret-exposure",
  "path-traversal",
  "insecure-defaults",
  "ssrf",
  "csrf",
  "xss",
];

/** Each kind of flaw and its defences. */
export const CLASSES: Record<AdvisoryClass, ClassInfo> = {
  "command-injection": {
    label: "Commands run on the server",
    term: "command injection",
    defences: ["arguments", "forks", "cloudflare"],
    why: "What you type reaches a server as checked fields and separate arguments, never as text in a shell, and the dashboard runs where there is no shell at all. A fork's pull request builds without secrets, on builders kept apart for it.",
    more: [
      { product: "Coolify", url: "https://github.com/coollabsio/coolify/security/advisories" },
      { product: "Dokploy", url: "https://github.com/Dokploy/dokploy/security/advisories" },
    ],
  },
  "access-control": {
    label: "Reaching someone else's things",
    term: "broken access control",
    defences: ["access", "reauth"],
    why: "Each project request is checked against the project as stored, so an ID from another workspace is refused, and a shell needs its own permission, two-factor and a recent sign-in. This narrows such bugs without ruling them out: the October review found and fixed one.",
  },
  "auth-bypass": {
    label: "Skipped sign-in checks",
    term: "authentication bypass",
    defences: ["github", "setup", "access"],
    why: "GitHub webhooks need a valid signature, a fresh install can only be claimed with your MASTER_KEY, and project routes share one access check. A route that forgets a check is still possible: the October review found one missing two-factor check and fixed it.",
  },
  "privilege-escalation": {
    label: "Taking a higher role",
    term: "privilege escalation",
    defences: ["access", "reauth", "audit", "paths"],
    why: "Only owners can invite or appoint owners, and every role change needs a recent sign-in and lands in the tamper-evident audit log. Apps can mount only their own volumes, never a folder of the host.",
  },
  "secret-exposure": {
    label: "Leaked secrets and keys",
    term: "secret exposure",
    defences: ["write-only", "sealed", "dial-out"],
    why: "No route returns a secret value to anyone, secrets reach a server sealed to its key, and the control plane holds no SSH keys to your servers, so there is far less to leak.",
  },
  "path-traversal": {
    label: "Writing or reading any file",
    term: "path traversal",
    defences: ["paths"],
    why: "The agent checks every path it writes: archive entries stay inside their folder and can't pass through symlinks, builds can't read outside their checkout, and secret file names can't contain a path.",
  },
  "insecure-defaults": {
    label: "Built-in passwords and keys",
    term: "insecure defaults",
    defences: ["master-key", "setup"],
    why: "Nothing ships with a shared secret. Every key derives from the MASTER_KEY you generate, the control plane's database is Cloudflare D1 with no password to guess, and database passwords are generated per database and stored write-only.",
  },
  ssrf: {
    label: "Requests to internal addresses",
    term: "server-side request forgery",
    defences: ["cloudflare", "builds"],
    why: "The control plane runs on Cloudflare, with no metadata service or local admin port behind it, and only instance admins can set the outside addresses it calls, over https. On servers, apps and builds can't reach the metadata address.",
  },
  csrf: {
    label: "Forged clicks from other sites",
    term: "cross-site request forgery",
    defences: ["page-policy"],
    why: "A change sent from a signed-in browser is refused unless it comes from the dashboard's own origin.",
  },
  xss: {
    label: "Injected scripts",
    term: "cross-site scripting",
    defences: ["page-policy"],
    why: "The dashboard's policy allows only its own scripts, none inline, and it never renders raw HTML, so text such as a project name can't become code.",
  },
};

/** Lower is more severe. */
export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Display names for severities. */
export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** How the table is ordered. */
export type SortKey = "date" | "severity";

/**
 * Orders advisories newest first, or most severe first (by rating, then score) with
 * newest first within equal severity. Ties fall back to the identifier so the order is
 * stable.
 *
 * @param list - Advisories to order; not modified.
 * @param by - The order.
 * @returns A new, ordered array.
 */
export function sortAdvisories(list: readonly Advisory[], by: SortKey): Advisory[] {
  return [...list].sort((a, b) => {
    if (by === "severity") {
      const rank = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (rank !== 0) return rank;
      const score = (b.score ?? 0) - (a.score ?? 0);
      if (score !== 0) return score;
    }
    if (a.published !== b.published) return a.published < b.published ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Counts advisories per kind of flaw.
 *
 * @param list - Advisories.
 * @returns Count per kind; kinds with none are absent.
 */
export function countByClass(list: readonly Advisory[]): Map<AdvisoryClass, number> {
  const counts = new Map<AdvisoryClass, number>();
  for (const advisory of list) counts.set(advisory.kind, (counts.get(advisory.kind) ?? 0) + 1);
  return counts;
}
