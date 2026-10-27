/**
 * Vocabulary for projects, environments, services, variables, domains and
 * the GitHub App: the enum values stored in D1 and returned by the API.
 *
 * @module
 */

/** Kinds of environment. Every project gets a `production` one on creation. */
export const ENVIRONMENT_KINDS = ["production", "staging", "preview"] as const;

/** Kind of environment; see {@link ENVIRONMENT_KINDS}. */
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

/** Slug and name of the environment created with every project. */
export const DEFAULT_ENVIRONMENT = { name: "production", slug: "production" } as const;

/** What a service is, for the dashboard; it does not change how it runs. */
export const SERVICE_KINDS = ["app", "database", "cron"] as const;

/** Kind of service; see {@link SERVICE_KINDS}. */
export type ServiceKind = (typeof SERVICE_KINDS)[number];

/**
 * Service slugs that would collide with a variable-reference namespace
 * (`${{shared.VAR}}`), so no service may use them.
 */
export const RESERVED_SERVICE_SLUGS = ["shared"] as const;

/** Where a variable lives: on one service, or shared by a project environment. */
export const VARIABLE_SCOPES = ["service", "shared"] as const;

/** Variable scope; see {@link VARIABLE_SCOPES}. */
export type VariableScope = (typeof VARIABLE_SCOPES)[number];

/** `generated` domains live under the apps domain; `custom` ones are user-owned (Phase 3). */
export const DOMAIN_TYPES = ["generated", "custom"] as const;

/** Domain type; see {@link DOMAIN_TYPES}. */
export type DomainType = (typeof DOMAIN_TYPES)[number];

/** Ownership verification of a domain. Generated domains start `verified`. */
export const DOMAIN_VERIFICATION_STATUSES = ["pending", "verified", "failed"] as const;

/** Domain verification status; see {@link DOMAIN_VERIFICATION_STATUSES}. */
export type DomainVerificationStatus = (typeof DOMAIN_VERIFICATION_STATUSES)[number];

/** Certificate state of a domain as last reported by ingress. */
export const DOMAIN_TLS_STATUSES = ["pending", "issued", "failed", "disabled"] as const;

/** Domain certificate status; see {@link DOMAIN_TLS_STATUSES}. */
export type DomainTlsStatus = (typeof DOMAIN_TLS_STATUSES)[number];

/** GitHub account types a GitHub App can be installed on. */
export const GITHUB_ACCOUNT_TYPES = ["User", "Organization"] as const;

/** GitHub account type; see {@link GITHUB_ACCOUNT_TYPES}. */
export type GithubAccountType = (typeof GITHUB_ACCOUNT_TYPES)[number];

/**
 * Ingress TLS modes, as stored in the `tls_mode` instance setting. Same values
 * as `INGRESS_TLS_MODES` in `@roundhouse/protocol`:
 * - `acme`: each node's Caddy issues on demand; fit for one ingress node;
 * - `managed`: the control plane issues every certificate and ships it to
 *   the nodes (ADR 0009), so DNS may point at any number of them;
 * - `internal`, `off`: development and tests.
 */
export const TLS_MODES = ["acme", "managed", "internal", "off"] as const;

/** Ingress TLS mode; see {@link TLS_MODES}. */
export type TlsMode = (typeof TLS_MODES)[number];

/** TLS mode of an install until an owner changes it. */
export const DEFAULT_TLS_MODE: TlsMode = "acme";

/** Apps domain suggested for local development; resolves to loopback. */
export const LOCAL_APPS_DOMAIN = "127.0.0.1.nip.io";
