/**
 * Variable tiers and the classifier that picks a variable's default tier.
 * Shared so the API (which enforces the result) and the dashboard (which
 * previews it while the user types) always agree. See ADR 0014.
 *
 * - `plain` values are stored encrypted but returned to callers allowed to
 *   read plain values.
 * - `secret` values are write-only: no API, CLI or dashboard path returns
 *   them, ever. They reach only the nodes that run or build the service.
 *
 * {@link classifyVariable} decides, in order:
 * 1. a public framework prefix (`NEXT_PUBLIC_`, `VITE_`, …) forces `plain`,
 *    locked, because the framework ships the value to every browser;
 * 2. a value matching a known credential format forces `secret`, locked;
 * 3. a high-entropy value, or a name that reads like a credential, defaults
 *    to `secret` but may be changed;
 * 4. anything else defaults to `plain`.
 *
 * Everything here is pure and runtime-agnostic.
 *
 * @module
 */
import { parseReferences } from "./variables";

// -----------------------------------------------------------------------------
// Tiers
// -----------------------------------------------------------------------------

/** Storage tiers of a variable. */
export const VARIABLE_TIERS = ["plain", "secret"] as const;

/** A variable's tier; see {@link VARIABLE_TIERS}. */
export type VariableTier = (typeof VARIABLE_TIERS)[number];

/**
 * Shortest secret the log redactor replaces. Shorter values would turn
 * ordinary words and numbers in logs into `[REDACTED]`, so they are not
 * redacted and the write carries a {@link ClassificationWarningCode} instead.
 */
export const MIN_REDACTABLE_SECRET_LENGTH = 6;

// -----------------------------------------------------------------------------
// Public prefixes
// -----------------------------------------------------------------------------

/** A name prefix whose variables a framework inlines into client bundles. */
export interface PublicPrefix {
  prefix: string;
  /** Who bundles it, for the dashboard's explanation. */
  framework: string;
}

/**
 * Prefixes whose variables end up in code every visitor downloads. Only
 * prefixes a framework bundles by default are listed; matching is
 * case-sensitive because the frameworks' is.
 *
 * - `NEXT_PUBLIC_`: Next.js inlines them at build time.
 * - `VITE_`: Vite's default `envPrefix`, exposed on `import.meta.env`
 *   (also SolidStart, Remix-on-Vite, and Vite-based Vue/React/Svelte apps).
 * - `PUBLIC_`: SvelteKit (`$env/*\/public`), Astro and Qwik
 *   (`import.meta.env.PUBLIC_*`).
 * - `NUXT_PUBLIC_`: Nuxt overrides of `runtimeConfig.public`, sent to the client.
 * - `EXPO_PUBLIC_`: Expo inlines them into the app bundle.
 * - `REACT_APP_`: Create React App.
 * - `GATSBY_`: Gatsby's browser-exposed variables.
 * - `VUE_APP_`: Vue CLI.
 * - `STORYBOOK_`: Storybook's manager and preview bundles.
 * - `REDWOOD_ENV_`: RedwoodJS web side.
 * - `SANITY_STUDIO_`: Sanity Studio bundles.
 * - `NG_APP_`: `@ngx-env/builder`, the usual way Angular apps read env.
 * - `PLASMO_PUBLIC_`: Plasmo browser extensions.
 */
export const PUBLIC_VARIABLE_PREFIXES: readonly PublicPrefix[] = [
  { prefix: "NEXT_PUBLIC_", framework: "Next.js" },
  { prefix: "NUXT_PUBLIC_", framework: "Nuxt" },
  { prefix: "EXPO_PUBLIC_", framework: "Expo" },
  { prefix: "PLASMO_PUBLIC_", framework: "Plasmo" },
  { prefix: "VITE_", framework: "Vite" },
  { prefix: "PUBLIC_", framework: "SvelteKit, Astro and Qwik" },
  { prefix: "REACT_APP_", framework: "Create React App" },
  { prefix: "GATSBY_", framework: "Gatsby" },
  { prefix: "VUE_APP_", framework: "Vue CLI" },
  { prefix: "STORYBOOK_", framework: "Storybook" },
  { prefix: "REDWOOD_ENV_", framework: "RedwoodJS" },
  { prefix: "SANITY_STUDIO_", framework: "Sanity Studio" },
  { prefix: "NG_APP_", framework: "Angular (@ngx-env)" },
];

/**
 * The public prefix a variable name starts with.
 *
 * @param key - Variable name.
 * @returns The matching prefix, or `null`.
 * @example
 * publicPrefixOf("NEXT_PUBLIC_API_URL"); // { prefix: "NEXT_PUBLIC_", framework: "Next.js" }
 */
export function publicPrefixOf(key: string): PublicPrefix | null {
  return (
    PUBLIC_VARIABLE_PREFIXES.find(
      (p) => key.startsWith(p.prefix) && key.length > p.prefix.length,
    ) ?? null
  );
}

// -----------------------------------------------------------------------------
// Names
// -----------------------------------------------------------------------------

/** Words that make a name secret wherever they appear. */
const SECRET_WORDS = new Set([
  "SECRET",
  "SECRETS",
  "PASSWORD",
  "PASSWORDS",
  "PASSWD",
  "PASSPHRASE",
  "CREDENTIAL",
  "CREDENTIALS",
  "CREDS",
  "DSN",
  "SALT",
  "PEPPER",
  "HMAC",
  "CERT",
  "CERTIFICATE",
  "PEM",
  "JWT",
  "BEARER",
  "APIKEY",
  "ACCESSKEY",
  "SECRETKEY",
  "PRIVATEKEY",
  "AUTHTOKEN",
  "CONNSTR",
]);

/** Words that make a name secret only as its last word (`DB_PASS`, but not `PASS_THROUGH`). */
const TRAILING_SECRET_WORDS = new Set(["PASS", "PWD", "AUTH", "PRIVATE", "SIGNING"]);

/** A final word that names metadata about a credential rather than the credential itself. */
const METADATA_SUFFIXES = new Set([
  "PATH",
  "FILE",
  "DIR",
  "DIRECTORY",
  "LOCATION",
  "ENABLED",
  "DISABLED",
  "ENABLE",
  "DISABLE",
  "TTL",
  "EXPIRY",
  "EXPIRES",
  "LIFETIME",
  "LENGTH",
  "SIZE",
  "TYPE",
  "ALGORITHM",
  "ALG",
  "HEADER",
  "ISSUER",
  "AUDIENCE",
  "NAME",
  "ID",
  "IDS",
  "ALIAS",
  "ARN",
  "PREFIX",
  "VERSION",
  "LIMIT",
  "MAX",
  "MIN",
  "COUNT",
]);

/** Words before `KEY` that make it a public or structural key. */
const NON_SECRET_KEY_QUALIFIERS = new Set([
  "PUBLIC",
  "PUBLISHABLE",
  "PUB",
  "SITE",
  "CACHE",
  "PARTITION",
  "SORT",
  "PRIMARY",
  "FOREIGN",
  "ROUTING",
  "IDEMPOTENCY",
]);

/** Words before `TOKEN(S)` that make it a count, as in `MAX_TOKENS`. */
const TOKEN_COUNT_QUALIFIERS = new Set(["MAX", "MIN", "NUM", "TOTAL", "LIMIT", "CONTEXT"]);

/** Words that, followed by `URL`, `URI` or `DSN`, name a connection string with credentials. */
const DATABASE_WORDS = new Set([
  "DATABASE",
  "DB",
  "POSTGRES",
  "POSTGRESQL",
  "PG",
  "MYSQL",
  "MARIADB",
  "MONGO",
  "MONGODB",
  "REDIS",
  "VALKEY",
  "AMQP",
  "CLOUDAMQP",
  "RABBITMQ",
]);

/**
 * Splits a variable name into upper-case words at `_`, other punctuation and
 * camelCase boundaries: `stripeSecretKey` → `STRIPE`, `SECRET`, `KEY`.
 *
 * @param key - Variable name.
 * @returns Its words, upper-cased.
 */
export function variableNameWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toUpperCase());
}

/**
 * Whether a variable name reads like a credential. Word-aware, so
 * `KEYBOARD_LAYOUT`, `MONKEY` and `MAX_TOKENS` are not, while `API_KEY`,
 * `DB_PASS` and `DATABASE_URL` are. Names ending in a metadata word
 * (`JWT_ISSUER`, `KEY_PATH`, `TOKEN_TTL`) are not.
 *
 * @param key - Variable name.
 * @returns `true` when the name suggests a secret.
 * @example
 * isSecretName("STRIPE_SECRET_KEY"); // true
 * isSecretName("STRIPE_PUBLISHABLE_KEY"); // false
 */
export function isSecretName(key: string): boolean {
  const words = variableNameWords(key);
  if (words.length === 0) return false;
  // `PWD` alone is the shell's working directory.
  if (words.length === 1 && (words[0] === "PWD" || words[0] === "OLDPWD")) return false;
  for (let i = 0; i + 1 < words.length; i++) {
    if (words[i] === "ACCESS" && words[i + 1] === "KEY") return true;
  }
  const last = words[words.length - 1]!;
  if (METADATA_SUFFIXES.has(last)) return false;

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const prev = words[i - 1];
    const next = words[i + 1];
    const isLast = i === words.length - 1;
    if (SECRET_WORDS.has(w)) return true;
    if (TRAILING_SECRET_WORDS.has(w) && isLast && words.length > 1) return true;
    if (w === "PRIVATE" && next === "KEY") return true;
    if ((w === "KEY" || w === "KEYS") && !(prev && NON_SECRET_KEY_QUALIFIERS.has(prev))) {
      return true;
    }
    if ((w === "TOKEN" || w === "TOKENS") && !(prev && TOKEN_COUNT_QUALIFIERS.has(prev))) {
      return true;
    }
    if (
      (w === "CONNECTION" || w === "CONN") &&
      (next === "STRING" || next === "STR" || next === "URI")
    ) {
      return true;
    }
    if ((w === "URL" || w === "URI") && prev && DATABASE_WORDS.has(prev)) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Values
// -----------------------------------------------------------------------------

/** Known credential formats {@link detectSecretValue} recognises. */
export const SECRET_DETECTORS = [
  "private_key",
  "anthropic",
  "openai",
  "stripe",
  "github",
  "aws_access_key",
  "slack",
  "google_api_key",
  "sendgrid",
  "twilio",
  "npm",
  "jwt",
  "url_password",
] as const;

/** A known credential format; see {@link SECRET_DETECTORS}. */
export type SecretDetector = (typeof SECRET_DETECTORS)[number];

const DETECTOR_PATTERNS: readonly (readonly [SecretDetector, RegExp])[] = [
  ["private_key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/],
  // Before `openai`: Anthropic keys also start with `sk-`.
  ["anthropic", /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai", /(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/],
  ["stripe", /(?<![A-Za-z0-9])(?:(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{10,}|whsec_[A-Za-z0-9]{20,})/],
  ["github", /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/],
  ["aws_access_key", /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/],
  [
    "slack",
    /xox[abprs]-[A-Za-z0-9-]{10,}|hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/,
  ],
  ["google_api_key", /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/],
  ["sendgrid", /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/],
  ["twilio", /(?<![A-Za-z0-9])SK[0-9a-fA-F]{32}(?![A-Za-z0-9])/],
  ["npm", /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/],
];

const JWT_RE = /eyJ[A-Za-z0-9_-]{6,}\.(eyJ[A-Za-z0-9_-]{6,})\.[A-Za-z0-9_-]{10,}/;
const URL_PASSWORD_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/?#@]*:[^\s/?#@]+@/;

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// COMPAT: `atob` is not in this package's lib (it must run anywhere), and a
// JWT payload is ASCII JSON, so a byte-per-char decode is enough.
function decodeBase64UrlAscii(s: string): string {
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const ch of s) {
    const v = B64URL.indexOf(ch);
    if (v === -1) throw new Error("not base64url");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 0xff);
    }
  }
  return out;
}

/**
 * Supabase anon keys are JWTs meant for browsers. Their payload says
 * `"role":"anon"`, which is the only way to tell them from service keys.
 */
function isPublicJwt(payloadB64: string): boolean {
  try {
    const payload = JSON.parse(decodeBase64UrlAscii(payloadB64)) as { role?: unknown };
    return payload.role === "anon";
  } catch {
    return false;
  }
}

/**
 * The literal text of a value with `${{…}}` references removed: a reference
 * points at another variable, whose own tier covers it, so
 * `postgres://${{db.USER}}:${{db.PASSWORD}}@db` holds no secret itself.
 *
 * @param value - Raw variable value.
 * @returns The value's literal text.
 */
export function literalText(value: string): string {
  return parseReferences(value)
    .segments.map((s) => (s.type === "text" ? s.text : ""))
    .join("");
}

/**
 * Finds a known credential format in a value.
 *
 * @param value - Raw variable value; references are ignored.
 * @returns The first matching detector, or `null`.
 * @example
 * detectSecretValue("postgres://app:hunter2@db:5432/app"); // "url_password"
 */
export function detectSecretValue(value: string): SecretDetector | null {
  const text = literalText(value);
  for (const [detector, re] of DETECTOR_PATTERNS) if (re.test(text)) return detector;
  const jwt = JWT_RE.exec(text);
  if (jwt && !isPublicJwt(jwt[1]!)) return "jwt";
  if (URL_PASSWORD_RE.test(text)) return "url_password";
  return null;
}

/**
 * Shannon entropy of a string, in bits per character.
 *
 * @param s - Any string.
 * @returns Entropy; 0 for an empty or single-symbol string.
 */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const n = [...s].length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Shortest mixed-alphabet token considered for the entropy check. */
export const HIGH_ENTROPY_MIN_LENGTH = 24;

/** Shortest hex token considered for the entropy check. */
export const HIGH_ENTROPY_MIN_HEX_LENGTH = 32;

/** Bits per character above which a mixed-alphabet token counts as random. */
export const HIGH_ENTROPY_THRESHOLD = 4.0;

/** Bits per character above which a hex token counts as random (hex tops out at 4). */
export const HIGH_ENTROPY_HEX_THRESHOLD = 3.0;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-fA-F]+$/;
const WHOLE_JWT_RE = /^eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;
const TOKEN_CHARS_RE = /^[A-Za-z0-9+/=_\-.~]+$/;

/**
 * Whether a single token looks randomly generated.
 *
 * Decisions: UUIDs are identifiers, not secrets. A 40-character hex string
 * is almost always a git commit SHA-1, so it is skipped; other hex strings of
 * 32+ characters (`openssl rand -hex`, HMAC keys) count. Other tokens need
 * 24+ characters drawn from base64/base64url, upper case, lower case and a
 * digit, and entropy of at least {@link HIGH_ENTROPY_THRESHOLD}: that admits
 * generated keys while leaving hostnames, slugs and words alone.
 */
function isHighEntropyToken(token: string): boolean {
  // JWTs are judged by their payload in `detectSecretValue`, not by entropy.
  if (UUID_RE.test(token) || WHOLE_JWT_RE.test(token)) return false;
  if (HEX_RE.test(token)) {
    return (
      token.length >= HIGH_ENTROPY_MIN_HEX_LENGTH &&
      token.length !== 40 &&
      shannonEntropy(token) >= HIGH_ENTROPY_HEX_THRESHOLD
    );
  }
  return (
    token.length >= HIGH_ENTROPY_MIN_LENGTH &&
    TOKEN_CHARS_RE.test(token) &&
    /[A-Z]/.test(token) &&
    /[a-z]/.test(token) &&
    /[0-9]/.test(token) &&
    shannonEntropy(token) >= HIGH_ENTROPY_THRESHOLD
  );
}

/**
 * Whether any token of a value looks randomly generated. Values carrying a
 * PEM block (certificates, public keys) are skipped: their base64 body is
 * high-entropy by nature, and private keys are caught by
 * {@link detectSecretValue} instead.
 *
 * @param value - Raw variable value; references are ignored.
 * @returns `true` when a token passes the entropy check.
 */
export function hasHighEntropyToken(value: string): boolean {
  const text = literalText(value);
  if (text.includes("-----BEGIN ")) return false;
  return text.split(/[\s,;'"`=:]+/).some(isHighEntropyToken);
}

// -----------------------------------------------------------------------------
// Classification
// -----------------------------------------------------------------------------

/**
 * Why a variable got its default tier:
 * - `public_prefix`: a framework ships it to browsers; plain, locked;
 * - `value_detected`: a known credential format; secret, locked;
 * - `high_entropy`: looks randomly generated; secret, changeable;
 * - `secret_name`: the name reads like a credential; secret, changeable;
 * - `default`: none of the above; plain, changeable.
 */
export type ClassificationReason =
  | "public_prefix"
  | "value_detected"
  | "high_entropy"
  | "secret_name"
  | "default";

/** Warnings a classification can carry. */
export const CLASSIFICATION_WARNING_CODES = [
  "public_prefix_secret_value",
  "public_prefix_secret_name",
  "secret_too_short_to_redact",
] as const;

/**
 * A warning code:
 * - `public_prefix_secret_value`: a public variable's value looks like a
 *   credential. The API refuses the write unless the key is acknowledged.
 * - `public_prefix_secret_name`: a public variable's name reads like a
 *   credential. Informational.
 * - `secret_too_short_to_redact`: a secret shorter than
 *   {@link MIN_REDACTABLE_SECRET_LENGTH} is not redacted from logs.
 */
export type ClassificationWarningCode = (typeof CLASSIFICATION_WARNING_CODES)[number];

/** A warning shown next to a variable and returned by the API. */
export interface ClassificationWarning {
  code: ClassificationWarningCode;
  message: string;
}

/** Result of {@link classifyVariable}. */
export interface VariableClassification {
  /** Default tier for the variable. */
  tier: VariableTier;
  /** `true` when the user may not pick the other tier. */
  locked: boolean;
  reason: ClassificationReason;
  /** Set for `public_prefix`. */
  publicPrefix: PublicPrefix | null;
  /** The credential format found in the value, if any (also set under a public prefix). */
  detector: SecretDetector | null;
  warnings: ClassificationWarning[];
}

/**
 * Picks a variable's default tier from its name and value.
 *
 * @param key - Variable name.
 * @param value - Raw value, possibly with `${{…}}` references (ignored for scanning).
 * @returns The tier, whether it is locked, why, and warnings.
 * @example
 * classifyVariable("NEXT_PUBLIC_STRIPE_KEY", "pk_live_123").tier; // "plain" (locked)
 * classifyVariable("API_KEY", "abc").reason; // "secret_name"
 * classifyVariable("CONFIG", "sk_live_" + "x".repeat(24)).locked; // true
 */
export function classifyVariable(key: string, value: string): VariableClassification {
  const publicPrefix = publicPrefixOf(key);
  const detector = detectSecretValue(value);
  const warnings: ClassificationWarning[] = [];

  if (publicPrefix) {
    if (detector || hasHighEntropyToken(value)) {
      warnings.push({
        code: "public_prefix_secret_value",
        message: `${key} looks like a credential, and ${publicPrefix.framework} ships every ${publicPrefix.prefix} variable to every browser`,
      });
    }
    if (isSecretName(key.slice(publicPrefix.prefix.length))) {
      warnings.push({
        code: "public_prefix_secret_name",
        message: `${key} is named like a secret, but ${publicPrefix.prefix} variables are public`,
      });
    }
    return {
      tier: "plain",
      locked: true,
      reason: "public_prefix",
      publicPrefix,
      detector,
      warnings,
    };
  }

  let tier: VariableTier = "plain";
  let locked = false;
  let reason: ClassificationReason = "default";
  if (detector) {
    tier = "secret";
    locked = true;
    reason = "value_detected";
  } else if (hasHighEntropyToken(value)) {
    tier = "secret";
    reason = "high_entropy";
  } else if (isSecretName(key)) {
    tier = "secret";
    reason = "secret_name";
  }
  if (tier === "secret") warnings.push(...secretLengthWarnings(key, value));
  return { tier, locked, reason, publicPrefix: null, detector, warnings };
}

/**
 * The redaction warning for a value about to be stored as a secret.
 *
 * @param key - Variable name.
 * @param value - Raw value.
 * @returns `secret_too_short_to_redact` when the literal text is non-empty and short.
 */
export function secretLengthWarnings(key: string, value: string): ClassificationWarning[] {
  const literal = literalText(value);
  if (literal.length === 0 || [...literal].length >= MIN_REDACTABLE_SECRET_LENGTH) return [];
  return [
    {
      code: "secret_too_short_to_redact",
      message: `${key} is shorter than ${MIN_REDACTABLE_SECRET_LENGTH} characters, so it can't be redacted from logs`,
    },
  ];
}

/** Input of {@link decideVariableTier}. */
export interface TierRequest {
  /** Classification of the value being stored (the new value, or the stored one). */
  classification: VariableClassification;
  /** Tier the caller asked for; absent to take the default. */
  requested?: VariableTier;
  /** The variable's current tier, when it exists. */
  previous?: VariableTier;
  /** Whether the write carries a value (a tier-only change carries none). */
  valueProvided: boolean;
}

/** Outcome of {@link decideVariableTier}. */
export type TierDecision =
  | { ok: true; tier: VariableTier; locked: boolean }
  | { ok: false; code: "tier_locked" | "value_required"; message: string };

/**
 * Decides the tier a write stores.
 *
 * Rules: a locked classification can't be overridden. Without an explicit
 * request, an existing secret stays secret and anything else takes the
 * classification's tier, so a variable never silently becomes plain.
 * Turning a secret into a plain variable needs the value re-entered, since
 * the stored one may never be shown.
 *
 * @param r - The classification, request and current state.
 * @returns The tier to store, or why the write is refused.
 * @example
 * decideVariableTier({ classification, requested: "plain", previous: "secret", valueProvided: false });
 * // { ok: false, code: "value_required", … }
 */
export function decideVariableTier(r: TierRequest): TierDecision {
  const { classification: c } = r;
  if (c.locked) {
    if (r.requested && r.requested !== c.tier) {
      return {
        ok: false,
        code: "tier_locked",
        message:
          c.reason === "public_prefix"
            ? `${c.publicPrefix!.prefix} variables are public and can't be secret`
            : "This value is a recognised credential and must stay secret",
      };
    }
    return { ok: true, tier: c.tier, locked: true };
  }
  const tier = r.requested ?? (r.previous === "secret" ? "secret" : c.tier);
  if (r.previous === "secret" && tier === "plain" && !r.valueProvided) {
    return {
      ok: false,
      code: "value_required",
      message: "Re-enter the value to make a secret plain",
    };
  }
  return { ok: true, tier, locked: false };
}

// -----------------------------------------------------------------------------
// Build inputs
// -----------------------------------------------------------------------------

/** Names a build arg or build-time variable may not take; see {@link isReservedBuildName}. */
export const RESERVED_BUILD_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SHELL",
  "ENV",
  "BASH_ENV",
  "IFS",
  "GODEBUG",
  "GOTRACEBACK",
  "TERM",
  "NO_COLOR",
  "SYSTEMROOT",
  "BUILDKIT_HOST",
];

/** Name prefixes reserved like {@link RESERVED_BUILD_NAMES}; any `*_PROXY` name is too. */
export const RESERVED_BUILD_NAME_PREFIXES: readonly string[] = [
  "LD_",
  "DYLD_",
  "XDG_",
  "GIT_",
  "SSL_CERT_",
  "MISE_",
];

/**
 * Whether a name is reserved for the builder's own process environment.
 * Mirrors `isReservedEnvName` in `agent/internal/builder/env.go`, which
 * refuses such names at build time; the API refuses them at save so the
 * error comes before a deploy fails.
 *
 * SECURITY: Railpack runs on the host with the build's args and secrets in
 * its environment, so `LD_PRELOAD`, `PATH` or `GIT_SSH_COMMAND` would steer
 * it (or git) into code from the repository being built (ADR 0014 M1).
 * Case-insensitive like the agent.
 *
 * @param name - A build arg or variable name.
 * @returns `true` when the builder would refuse it.
 * @example
 * isReservedBuildName("LD_PRELOAD"); // true
 * isReservedBuildName("https_proxy"); // true
 * isReservedBuildName("NODE_ENV"); // false
 */
export function isReservedBuildName(name: string): boolean {
  const upper = name.toUpperCase();
  return (
    RESERVED_BUILD_NAMES.includes(upper) ||
    upper.endsWith("_PROXY") ||
    RESERVED_BUILD_NAME_PREFIXES.some((p) => upper.startsWith(p))
  );
}
