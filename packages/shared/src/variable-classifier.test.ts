// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are variable references (`${{svc.VAR}}`), not template literals.
import { describe, expect, it } from "vitest";
import {
  classifyVariable,
  decideVariableTier,
  detectSecretValue,
  hasHighEntropyToken,
  isSecretName,
  literalText,
  MIN_REDACTABLE_SECRET_LENGTH,
  PUBLIC_VARIABLE_PREFIXES,
  publicPrefixOf,
  type SecretDetector,
  secretLengthWarnings,
  shannonEntropy,
  type VariableClassification,
  variableNameWords,
} from "./variable-classifier";

// NOTE: credential-shaped fixtures are assembled at runtime so secret
// scanners (GitHub push protection and friends) don't flag this file.
const join = (...parts: string[]) => parts.join("");
const ALNUM = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0";
const repeatTo = (s: string, n: number) => s.repeat(Math.ceil(n / s.length)).slice(0, n);
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const b64url = (o: object) => {
  const text = JSON.stringify(o);
  let out = "";
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < text.length; i++) {
    acc = ((acc << 8) | text.charCodeAt(i)) & 0xffff;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += B64URL[(acc >> bits) & 63];
    }
  }
  if (bits) out += B64URL[(acc << (6 - bits)) & 63];
  return out;
};

const FAKE = {
  stripeLive: join("sk", "_live_", repeatTo(ALNUM, 24)),
  stripeRestricted: join("rk", "_test_", repeatTo(ALNUM, 24)),
  stripeWebhook: join("whsec", "_", repeatTo(ALNUM, 32)),
  githubPat: join("ghp", "_", repeatTo(ALNUM, 36)),
  githubServer: join("ghs", "_", repeatTo(ALNUM, 36)),
  githubFine: join("github", "_pat_", repeatTo(ALNUM, 40)),
  aws: join("AKIA", "IOSFODNN7EXAMPL0"),
  awsSession: join("ASIA", "Q2W3E4R5T6Y7U8I9"),
  slack: join("xox", "b-", "123456789012-abcdefABCDEF"),
  slackHook: join("https://hooks.slack", ".com/services/T0123ABCD/B0123ABCD/", repeatTo(ALNUM, 24)),
  openai: join("sk", "-proj-", repeatTo(ALNUM, 48)),
  openaiLegacy: join("sk", "-", repeatTo(ALNUM, 48)),
  anthropic: join("sk", "-ant-api03-", repeatTo(ALNUM, 40)),
  google: join("AI", "za", repeatTo(ALNUM, 35)),
  sendgrid: join("SG", ".", repeatTo(ALNUM, 22), ".", repeatTo(ALNUM, 43)),
  twilio: join("SK", "0123456789abcdef0123456789abcdef"),
  npm: join("npm", "_", repeatTo(ALNUM, 36)),
  pem: join("-----BEGIN ", "RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----"),
  pemOpenssh: join("-----BEGIN ", "OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE=\n-----END"),
  pemPgp: join("-----BEGIN ", "PGP PRIVATE KEY BLOCK-----\nlQOYBF\n"),
  jwt: join(
    b64url({ alg: "HS256", typ: "JWT" }),
    ".",
    b64url({ sub: "1", role: "service_role" }),
    ".",
    repeatTo(ALNUM, 43),
  ),
  anonJwt: join(
    b64url({ alg: "HS256", typ: "JWT" }),
    ".",
    b64url({ iss: "supabase", role: "anon" }),
    ".",
    repeatTo(ALNUM, 43),
  ),
  base64Key: "q8Rz3K1vYp0Lw9Xn2Tf5Hj7Ug4Ob6Ic8Ea1Ds3Mk5Q=",
  hex64: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
};

describe("variableNameWords", () => {
  it.each([
    ["DATABASE_URL", ["DATABASE", "URL"]],
    ["stripeSecretKey", ["STRIPE", "SECRET", "KEY"]],
    ["APIKey", ["API", "KEY"]],
    ["OAUTH2_TOKEN", ["OAUTH2", "TOKEN"]],
    ["__weird--name__", ["WEIRD", "NAME"]],
  ])("splits %s", (key, words) => {
    expect(variableNameWords(key)).toEqual(words);
  });
});

describe("isSecretName", () => {
  it.each([
    "API_KEY",
    "STRIPE_SECRET_KEY",
    "SECRET",
    "TOKEN",
    "KEY",
    "GITHUB_TOKEN",
    "ACCESS_TOKEN",
    "REFRESH_TOKENS",
    "DB_PASSWORD",
    "SMTP_PASSWD",
    "DB_PASS",
    "MYSQL_PWD",
    "PRIVATE_KEY",
    "GOOGLE_PRIVATE",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_ACCESS_KEY_ID",
    "SENTRY_DSN",
    "DATABASE_URL",
    "POSTGRES_URL",
    "REDIS_URL",
    "MONGODB_URI",
    "PG_URL",
    "CLOUDAMQP_URL",
    "SQL_CONNECTION_STRING",
    "AZURE_CONN_STR",
    "PASSWORD_SALT",
    "WEBHOOK_SIGNING",
    "TLS_CERT",
    "SERVER_CERTIFICATE",
    "CLIENT_PEM",
    "BASIC_AUTH",
    "SESSION_SECRET",
    "NEXTAUTH_SECRET",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "DOCKER_CREDS",
    "apiKey",
    "stripeSecretKey",
    "OPENAI_APIKEY",
    "HMAC_KEY",
    "JWT",
    "BEARER",
    "ENCRYPTION_KEYS",
  ])("flags %s", (key) => {
    expect(isSecretName(key)).toBe(true);
  });

  it.each([
    "KEYBOARD_LAYOUT",
    "MONKEY",
    "TURKEY_MODE",
    "PORT",
    "NODE_ENV",
    "LOG_LEVEL",
    "STRIPE_PUBLISHABLE_KEY",
    "VAPID_PUBLIC_KEY",
    "RECAPTCHA_SITE_KEY",
    "CACHE_KEY",
    "DYNAMO_PARTITION_KEY",
    "MAX_TOKENS",
    "OPENAI_MAX_TOKENS",
    "TOKENIZER_MODEL",
    "AUTH_URL",
    "AUTH_TRUST_HOST",
    "NEXTAUTH_URL",
    "AUTH",
    "PWD",
    "OLDPWD",
    "PASS_THROUGH",
    "PRIVATE_NETWORK",
    "ROUNDHOUSE_PRIVATE_DOMAIN",
    "RAILWAY_PRIVATE_DOMAIN",
    "SIGNING_ALGORITHM",
    "JWT_ISSUER",
    "JWT_AUDIENCE",
    "TOKEN_TTL",
    "SESSION_TOKEN_EXPIRY",
    "PASSWORD_MIN_LENGTH",
    "KMS_KEY_ID",
    "SSH_KEY_PATH",
    "TLS_CERT_FILE",
    "GOOGLE_APPLICATION_CREDENTIALS_FILE",
    "DATABASE_NAME",
    "DATABASE_HOST",
    "API_URL",
    "PUBLIC_URL",
    "CONNECTION_TIMEOUT",
    "",
  ])("leaves %s alone", (key) => {
    expect(isSecretName(key)).toBe(false);
  });
});

describe("publicPrefixOf", () => {
  it.each(PUBLIC_VARIABLE_PREFIXES.map((p) => [p.prefix]))("recognises %s", (prefix) => {
    expect(publicPrefixOf(`${prefix}THING`)?.prefix).toBe(prefix);
  });

  it("matches the most specific prefix", () => {
    expect(publicPrefixOf("NEXT_PUBLIC_X")?.prefix).toBe("NEXT_PUBLIC_");
    expect(publicPrefixOf("NUXT_PUBLIC_X")?.prefix).toBe("NUXT_PUBLIC_");
    expect(publicPrefixOf("PUBLIC_X")?.prefix).toBe("PUBLIC_");
  });

  it("is case-sensitive and needs a name after the prefix", () => {
    expect(publicPrefixOf("vite_API")).toBe(null);
    expect(publicPrefixOf("Next_Public_X")).toBe(null);
    expect(publicPrefixOf("VITE_")).toBe(null);
    expect(publicPrefixOf("MY_VITE_URL")).toBe(null);
    expect(publicPrefixOf("PUBLICATION_ID")).toBe(null);
  });
});

describe("detectSecretValue", () => {
  it.each<[string, SecretDetector]>([
    [FAKE.stripeLive, "stripe"],
    [FAKE.stripeRestricted, "stripe"],
    [FAKE.stripeWebhook, "stripe"],
    [FAKE.githubPat, "github"],
    [FAKE.githubServer, "github"],
    [FAKE.githubFine, "github"],
    [FAKE.aws, "aws_access_key"],
    [FAKE.awsSession, "aws_access_key"],
    [FAKE.slack, "slack"],
    [FAKE.slackHook, "slack"],
    [FAKE.openai, "openai"],
    [FAKE.openaiLegacy, "openai"],
    [FAKE.anthropic, "anthropic"],
    [FAKE.google, "google_api_key"],
    [FAKE.sendgrid, "sendgrid"],
    [FAKE.twilio, "twilio"],
    [FAKE.npm, "npm"],
    [FAKE.pem, "private_key"],
    [FAKE.pemOpenssh, "private_key"],
    [FAKE.pemPgp, "private_key"],
    [FAKE.jwt, "jwt"],
    ["postgres://app:hunter2@db.internal:5432/app", "url_password"],
    ["redis://:p4ss@cache:6379", "url_password"],
    ["amqps://user:pw@mq.example.com/vhost", "url_password"],
  ])("finds %s", (value, detector) => {
    expect(detectSecretValue(value)).toBe(detector);
  });

  it("finds a credential embedded in a longer value", () => {
    expect(detectSecretValue(`Bearer ${FAKE.githubPat}`)).toBe("github");
    expect(detectSecretValue(`{"key":"${FAKE.stripeLive}"}`)).toBe("stripe");
  });

  it.each([
    "",
    "hello world",
    "production",
    "https://example.com/path?x=1",
    "postgres://app@db:5432/app",
    "postgres://db:5432/app",
    "https://user@example.com",
    join("pk", "_live_", repeatTo(ALNUM, 24)),
    join("sk", "-short"),
    "AKIA123",
    "mask_live_thing",
    FAKE.anonJwt,
    "eyJhbGciOi.not-a-jwt",
    "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----",
    "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
  ])("ignores %j", (value) => {
    expect(detectSecretValue(value)).toBe(null);
  });

  it("ignores credentials that live behind references", () => {
    expect(detectSecretValue("postgres://${{db.USER}}:${{db.PASSWORD}}@db:5432/app")).toBe(null);
    expect(detectSecretValue("postgres://app:${{db.PASSWORD}}@db:5432/app")).toBe(null);
    // An escaped reference is literal text, so the password is real.
    expect(detectSecretValue("postgres://app:$${{x}}@db")).toBe("url_password");
  });
});

describe("literalText", () => {
  it("drops references and keeps escapes as text", () => {
    expect(literalText("a${{b.C}}d")).toBe("ad");
    expect(literalText("$${{X}}")).toBe("${{X}}");
    expect(literalText("${{X}}")).toBe("");
  });
});

describe("shannonEntropy", () => {
  it("measures bits per character", () => {
    expect(shannonEntropy("")).toBe(0);
    expect(shannonEntropy("aaaa")).toBe(0);
    expect(shannonEntropy("ab")).toBe(1);
    expect(shannonEntropy("abcd")).toBe(2);
    expect(shannonEntropy("0123456789abcdef")).toBe(4);
  });
});

describe("hasHighEntropyToken", () => {
  it.each([
    FAKE.base64Key,
    FAKE.hex64,
    `${"0123456789abcdef0123456789abcdef".split("").reverse().join("")}99`,
    `token=${FAKE.base64Key}`,
    "Zx8Q2mN7pL4kR9wB3vT6yH1jF5gD0sA",
  ])("flags %s", (value) => {
    expect(hasHighEntropyToken(value)).toBe(true);
  });

  it.each([
    "550e8400-e29b-41d4-a716-446655440000",
    "1f0d3a7c9e2b4d6f8a0c1e3b5d7f9a2c4e6b8d0f",
    "my-app-production.us-east-1.elb.amazonaws.com",
    "https://api.example.com/v1/endpoint",
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "ThisIsJustALongCamelCaseIdentifier",
    "00000000000000000000000000000000000000000000",
    "Hello, world! This is a sentence with words and 42 numbers.",
    "short1A",
    "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEq8Rz3K1vYp0Lw9Xn2Tf5Hj7Ug4Ob6Ic8\n-----END PUBLIC KEY-----",
    "${{db.PASSWORD}}",
  ])("leaves %j alone", (value) => {
    expect(hasHighEntropyToken(value)).toBe(false);
  });
});

describe("classifyVariable", () => {
  const pick = (c: VariableClassification) => ({
    tier: c.tier,
    locked: c.locked,
    reason: c.reason,
  });

  it("forces public prefixes to plain, locked", () => {
    expect(pick(classifyVariable("NEXT_PUBLIC_API_URL", "https://api.example.com"))).toEqual({
      tier: "plain",
      locked: true,
      reason: "public_prefix",
    });
    expect(classifyVariable("VITE_SENTRY_DSN", "x").warnings.map((w) => w.code)).toEqual([
      "public_prefix_secret_name",
    ]);
  });

  it("warns when a public variable's value looks like a credential", () => {
    const c = classifyVariable("NEXT_PUBLIC_STRIPE", FAKE.stripeLive);
    expect(pick(c)).toEqual({ tier: "plain", locked: true, reason: "public_prefix" });
    expect(c.detector).toBe("stripe");
    expect(c.warnings.map((w) => w.code)).toEqual(["public_prefix_secret_value"]);
    expect(c.warnings[0]!.message).toContain("every browser");
    expect(
      classifyVariable("VITE_KEY_MATERIAL", FAKE.base64Key).warnings.map((w) => w.code),
    ).toContain("public_prefix_secret_value");
  });

  it("does not warn about a Supabase anon key or a publishable key under a public prefix", () => {
    expect(classifyVariable("NEXT_PUBLIC_SUPABASE_ANON", FAKE.anonJwt).warnings).toEqual([]);
    expect(
      classifyVariable("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", join("pk", "_live_", "abc")).warnings,
    ).toEqual([]);
  });

  it("locks recognised credentials as secret, whatever the name", () => {
    const c = classifyVariable("CONFIG", FAKE.githubPat);
    expect(pick(c)).toEqual({ tier: "secret", locked: true, reason: "value_detected" });
    expect(c.detector).toBe("github");
  });

  it("defaults high-entropy values to secret without locking", () => {
    expect(pick(classifyVariable("SOMETHING", FAKE.base64Key))).toEqual({
      tier: "secret",
      locked: false,
      reason: "high_entropy",
    });
  });

  it("defaults secret-looking names to secret without locking", () => {
    expect(pick(classifyVariable("API_KEY", "abc123"))).toEqual({
      tier: "secret",
      locked: false,
      reason: "secret_name",
    });
    expect(
      pick(classifyVariable("DATABASE_URL", "postgres://${{db.USER}}:${{db.PASSWORD}}@db/app")),
    ).toEqual({ tier: "secret", locked: false, reason: "secret_name" });
  });

  it("defaults everything else to plain", () => {
    expect(pick(classifyVariable("LOG_LEVEL", "debug"))).toEqual({
      tier: "plain",
      locked: false,
      reason: "default",
    });
    expect(classifyVariable("LOG_LEVEL", "debug").warnings).toEqual([]);
  });

  it("warns about secrets too short to redact", () => {
    expect(classifyVariable("DB_PASSWORD", "abc").warnings.map((w) => w.code)).toEqual([
      "secret_too_short_to_redact",
    ]);
    expect(
      classifyVariable("DB_PASSWORD", "a".repeat(MIN_REDACTABLE_SECRET_LENGTH)).warnings,
    ).toEqual([]);
    // A pure reference is redacted where it is defined.
    expect(classifyVariable("DB_PASSWORD", "${{db.PASSWORD}}").warnings).toEqual([]);
    expect(secretLengthWarnings("X", "")).toEqual([]);
  });
});

describe("decideVariableTier", () => {
  const plainDefault = classifyVariable("LOG_LEVEL", "debug");
  const secretByName = classifyVariable("API_KEY", "abcdefgh");
  const lockedSecret = classifyVariable("CONFIG", FAKE.githubPat);
  const lockedPublic = classifyVariable("VITE_URL", "https://x.example.com");

  it("takes the classification for a new variable", () => {
    expect(decideVariableTier({ classification: plainDefault, valueProvided: true })).toEqual({
      ok: true,
      tier: "plain",
      locked: false,
    });
    expect(decideVariableTier({ classification: secretByName, valueProvided: true })).toMatchObject(
      {
        tier: "secret",
      },
    );
  });

  it("lets the user pick either tier when unlocked", () => {
    expect(
      decideVariableTier({ classification: secretByName, requested: "plain", valueProvided: true }),
    ).toMatchObject({ ok: true, tier: "plain" });
    expect(
      decideVariableTier({
        classification: plainDefault,
        requested: "secret",
        valueProvided: true,
      }),
    ).toMatchObject({ ok: true, tier: "secret" });
  });

  it("refuses to override a lock either way", () => {
    expect(
      decideVariableTier({ classification: lockedSecret, requested: "plain", valueProvided: true }),
    ).toMatchObject({ ok: false, code: "tier_locked" });
    const pub = decideVariableTier({
      classification: lockedPublic,
      requested: "secret",
      valueProvided: true,
    });
    expect(pub).toMatchObject({ ok: false, code: "tier_locked" });
    expect(pub.ok === false && pub.message).toContain("VITE_");
    expect(
      decideVariableTier({
        classification: lockedSecret,
        requested: "secret",
        valueProvided: true,
      }),
    ).toEqual({ ok: true, tier: "secret", locked: true });
  });

  it("keeps an existing secret secret unless asked otherwise", () => {
    expect(
      decideVariableTier({ classification: plainDefault, previous: "secret", valueProvided: true }),
    ).toMatchObject({ ok: true, tier: "secret" });
    expect(
      decideVariableTier({ classification: plainDefault, previous: "plain", valueProvided: true }),
    ).toMatchObject({ ok: true, tier: "plain" });
  });

  it("upgrades a stored plain value to secret without a value", () => {
    expect(
      decideVariableTier({
        classification: plainDefault,
        previous: "plain",
        requested: "secret",
        valueProvided: false,
      }),
    ).toMatchObject({ ok: true, tier: "secret" });
  });

  it("needs the value re-entered to make a secret plain", () => {
    expect(
      decideVariableTier({
        classification: plainDefault,
        previous: "secret",
        requested: "plain",
        valueProvided: false,
      }),
    ).toMatchObject({ ok: false, code: "value_required" });
    expect(
      decideVariableTier({
        classification: plainDefault,
        previous: "secret",
        requested: "plain",
        valueProvided: true,
      }),
    ).toMatchObject({ ok: true, tier: "plain" });
  });
});
