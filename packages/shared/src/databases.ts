/**
 * The database registry (ADR 0004, "Database templates"): which engines and
 * versions a database service can run, the pinned image of each, and how a
 * database service is rendered: config, volume, health probe and the
 * generated credentials with the connection variables derived from them.
 *
 * Images are pinned by multi-arch index digest in `database-images.json`;
 * `scripts/pin-database-images.mjs` re-resolves them, so a digest change is
 * always a reviewed diff.
 *
 * The protocol names the Redis-compatible engine `redis`. Its default image
 * is Valkey (BSD), the licensing call ADR 0004 left open; Redis 8 (tri-
 * licensed, including AGPLv3) stays available as a version.
 *
 * @module
 */
import IMAGE_DIGESTS from "./database-images.json";
import type { ServiceConfigSpec } from "./service-config";

/** Engines a database service can run; the protocol's `DATABASE_ENGINES`. */
export const SERVICE_DATABASE_ENGINES = ["postgres", "mysql", "redis", "mongodb"] as const;

/** A database engine; see {@link SERVICE_DATABASE_ENGINES}. */
export type ServiceDatabaseEngine = (typeof SERVICE_DATABASE_ENGINES)[number];

/** Principal the data browser's read-only mode connects as. */
export const READONLY_DB_USER = "roundhouse_ro";

/** Variable holding the read-only principal's password, on every engine. */
export const READONLY_PASSWORD_VARIABLE = "ROUNDHOUSE_RO_PASSWORD";

/**
 * Principals of a database whose password a rotation changes: the engine's
 * admin, the application user (MySQL's `MYSQL_USER`) and the data
 * browser's read-only user.
 */
export const DATABASE_PRINCIPALS = ["admin", "app", "readonly"] as const;

/** A database principal; see {@link DATABASE_PRINCIPALS}. */
export type DatabasePrincipal = (typeof DATABASE_PRINCIPALS)[number];

/** Where a principal's name and password live among the service's variables. */
export interface DatabasePrincipalVariables {
  principal: DatabasePrincipal;
  /** A fixed user name, or the variable holding it. */
  username: { literal: string } | { variable: string };
  /** The secret variable holding the password. */
  passwordVariable: string;
}

/**
 * The principals an engine's template creates, in the order a rotation
 * changes them: the admin last, because it is the credential every other
 * change connects with.
 *
 * @param engine - The engine.
 * @returns One entry per principal.
 * @example
 * databasePrincipals("mysql").map((p) => p.principal); // ["readonly", "app", "admin"]
 */
export function databasePrincipals(engine: ServiceDatabaseEngine): DatabasePrincipalVariables[] {
  const readonly: DatabasePrincipalVariables = {
    principal: "readonly",
    username: { literal: READONLY_DB_USER },
    passwordVariable: READONLY_PASSWORD_VARIABLE,
  };
  const admin = databaseCredentialVariables(engine, "write");
  const out: DatabasePrincipalVariables[] = [readonly];
  if (engine === "mysql") {
    out.push({
      principal: "app",
      username: { variable: "MYSQL_USER" },
      passwordVariable: "MYSQL_PASSWORD",
    });
  }
  out.push({ principal: "admin", ...admin });
  return out;
}

/** Volume size a database starts with, in MiB. */
export const DEFAULT_DATABASE_VOLUME_MB = 5120;

/** Smallest volume, in MiB; the protocol's `MIN_VOLUME_SIZE_MB`. */
export const MIN_VOLUME_MB = 256;

/** Largest volume, in MiB; the protocol's `MAX_VOLUME_SIZE_MB`. */
export const MAX_VOLUME_MB = 1_048_576;

/** Seconds a database gets between SIGTERM and SIGKILL. */
export const DATABASE_STOP_GRACE_S = 60;

/** One offered version of an engine. */
export interface DatabaseVersion {
  /** What the API and templates call it, e.g. `18` or `valkey-9`. */
  version: string;
  /** Shown in the dashboard. */
  label: string;
  /** `repository:tag` the digest in `database-images.json` belongs to. */
  tag: string;
  /** Where the engine keeps its data; the volume is mounted here. */
  mountPath: string;
  /** Server and CLI binaries of the Redis-compatible images. */
  server?: "valkey" | "redis";
}

/** How the registry runs one engine. */
export interface DatabaseEngineSpec {
  engine: ServiceDatabaseEngine;
  name: string;
  /** `builtin:` icon of the service. */
  icon: string;
  port: number;
  memoryMb: number;
  /** Default first. */
  versions: readonly DatabaseVersion[];
  /** The variable other services usually reference, e.g. `DATABASE_URL`. */
  connectionVariable: string;
}

/** Every engine, in dashboard order. */
export const DATABASE_ENGINE_SPECS: Readonly<Record<ServiceDatabaseEngine, DatabaseEngineSpec>> = {
  postgres: {
    engine: "postgres",
    name: "PostgreSQL",
    icon: "builtin:postgres",
    port: 5432,
    memoryMb: 1024,
    versions: [
      // From 18 the image keeps PGDATA under a versioned directory of
      // /var/lib/postgresql and declares that as its VOLUME.
      {
        version: "18",
        label: "PostgreSQL 18",
        tag: "postgres:18-bookworm",
        mountPath: "/var/lib/postgresql",
      },
      // NOTE: 16 and 17 declare VOLUME /var/lib/postgresql/data; mounting the
      // parent would leave Docker an anonymous volume shadowing the data.
      {
        version: "17",
        label: "PostgreSQL 17",
        tag: "postgres:17-bookworm",
        mountPath: "/var/lib/postgresql/data",
      },
      {
        version: "16",
        label: "PostgreSQL 16",
        tag: "postgres:16-bookworm",
        mountPath: "/var/lib/postgresql/data",
      },
    ],
    connectionVariable: "DATABASE_URL",
  },
  mysql: {
    engine: "mysql",
    name: "MySQL",
    icon: "builtin:mysql",
    port: 3306,
    memoryMb: 1024,
    versions: [
      { version: "9.7", label: "MySQL 9.7 LTS", tag: "mysql:9.7", mountPath: "/var/lib/mysql" },
      { version: "8.4", label: "MySQL 8.4 LTS", tag: "mysql:8.4", mountPath: "/var/lib/mysql" },
    ],
    connectionVariable: "DATABASE_URL",
  },
  redis: {
    engine: "redis",
    name: "Valkey",
    icon: "builtin:redis",
    port: 6379,
    memoryMb: 512,
    versions: [
      {
        version: "valkey-9",
        label: "Valkey 9.1",
        tag: "valkey/valkey:9.1",
        mountPath: "/data",
        server: "valkey",
      },
      {
        version: "valkey-8",
        label: "Valkey 8.1",
        tag: "valkey/valkey:8.1",
        mountPath: "/data",
        server: "valkey",
      },
      {
        version: "redis-8",
        label: "Redis 8.10 (RSALv2/SSPLv1/AGPLv3)",
        tag: "redis:8.10",
        mountPath: "/data",
        server: "redis",
      },
    ],
    connectionVariable: "REDIS_URL",
  },
  mongodb: {
    engine: "mongodb",
    name: "MongoDB",
    icon: "builtin:mongodb",
    port: 27017,
    memoryMb: 1024,
    versions: [
      { version: "9.0", label: "MongoDB 9.0", tag: "mongo:9.0", mountPath: "/data/db" },
      { version: "8.0", label: "MongoDB 8.0", tag: "mongo:8.0", mountPath: "/data/db" },
    ],
    connectionVariable: "MONGO_URL",
  },
};

/**
 * Type guard for engine names from requests and stored rows.
 *
 * @param value - Candidate engine.
 * @returns `true` for an engine in {@link SERVICE_DATABASE_ENGINES}.
 */
export function isDatabaseEngine(value: unknown): value is ServiceDatabaseEngine {
  return (
    typeof value === "string" && (SERVICE_DATABASE_ENGINES as readonly string[]).includes(value)
  );
}

/**
 * Looks up an engine's version, the default when `version` is omitted.
 * Templates may name a bare major (`redis` + `9`), which matches the
 * version whose tag carries it.
 *
 * @param engine - The engine.
 * @param version - A version from {@link DatabaseEngineSpec.versions}, or omitted.
 * @returns The version, or `undefined` when the registry has no such version.
 * @example
 * databaseVersion("postgres")?.version; // "18"
 */
export function databaseVersion(
  engine: ServiceDatabaseEngine,
  version?: string | null,
): DatabaseVersion | undefined {
  const versions = DATABASE_ENGINE_SPECS[engine].versions;
  if (!version) return versions[0];
  return (
    versions.find((v) => v.version === version) ??
    versions.find((v) => v.tag.split(":")[1]?.split(".")[0] === version)
  );
}

/**
 * The pinned image of a version: `repository:tag@sha256:…`, so a pull gets
 * exactly the reviewed image whatever the tag points at later.
 *
 * @param v - A registry version.
 * @returns The image reference.
 * @throws When `database-images.json` has no digest for the tag.
 */
export function databaseImage(v: DatabaseVersion): string {
  const digest = (IMAGE_DIGESTS as Record<string, string>)[v.tag];
  if (!digest) throw new Error(`no pinned digest for ${v.tag}`);
  return `${v.tag}@${digest}`;
}

/** Every `repository:tag` the registry pins, for the digest script. */
export function pinnedDatabaseTags(): string[] {
  return Object.values(DATABASE_ENGINE_SPECS).flatMap((s) => s.versions.map((v) => v.tag));
}

/** A variable a database service is created with. */
export interface DatabaseVariable {
  key: string;
  value: string;
  /** Stored write-only (`tier: secret`). */
  secret: boolean;
}

/** Everything {@link renderDatabaseService} decides. */
export interface RenderedDatabase {
  engine: ServiceDatabaseEngine;
  version: DatabaseVersion;
  image: string;
  /** Config version 1 of the service. */
  config: ServiceConfigSpec;
  volume: { mount_path: string; size_mb: number };
  variables: DatabaseVariable[];
}

/** Random bytes source; `crypto.getRandomValues` in the Worker. */
export type RandomBytes = (n: number) => Uint8Array;

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let j = 0; j < chars; j++) out += B64URL[(n >> (18 - 6 * j)) & 63];
  }
  return out;
}

/**
 * A credential: 32 random bytes as base64url (43 characters). The alphabet
 * needs no escaping in URLs, shells or ACL rules.
 *
 * @param randomBytes - Randomness source.
 * @returns A fresh password.
 */
export function generateDatabasePassword(randomBytes: RandomBytes): string {
  return base64url(randomBytes(32));
}

const ref = (key: string) => `\${{${key}}}`;
const HOST = ref("ROUNDHOUSE_PRIVATE_DOMAIN");

function engineVariables(
  engine: ServiceDatabaseEngine,
  port: number,
  secret: () => string,
): DatabaseVariable[] {
  const plain = (key: string, value: string): DatabaseVariable => ({ key, value, secret: false });
  const hidden = (key: string, value: string): DatabaseVariable => ({ key, value, secret: true });
  const ro = hidden(READONLY_PASSWORD_VARIABLE, secret());
  switch (engine) {
    case "postgres":
      return [
        plain("POSTGRES_USER", "postgres"),
        plain("POSTGRES_DB", "app"),
        hidden("POSTGRES_PASSWORD", secret()),
        ro,
        hidden(
          "DATABASE_URL",
          `postgresql://${ref("POSTGRES_USER")}:${ref("POSTGRES_PASSWORD")}@${HOST}:${port}/${ref("POSTGRES_DB")}`,
        ),
        plain("PGHOST", HOST),
        plain("PGPORT", String(port)),
        plain("PGUSER", ref("POSTGRES_USER")),
        hidden("PGPASSWORD", ref("POSTGRES_PASSWORD")),
        plain("PGDATABASE", ref("POSTGRES_DB")),
      ];
    case "mysql": {
      const url = `mysql://${ref("MYSQL_USER")}:${ref("MYSQL_PASSWORD")}@${HOST}:${port}/${ref("MYSQL_DATABASE")}`;
      return [
        plain("MYSQL_USER", "app"),
        plain("MYSQL_DATABASE", "app"),
        hidden("MYSQL_ROOT_PASSWORD", secret()),
        hidden("MYSQL_PASSWORD", secret()),
        ro,
        hidden("DATABASE_URL", url),
        hidden("MYSQL_URL", url),
      ];
    }
    case "redis":
      return [
        hidden("REDIS_PASSWORD", secret()),
        ro,
        hidden("REDIS_URL", `redis://default:${ref("REDIS_PASSWORD")}@${HOST}:${port}`),
      ];
    case "mongodb": {
      const url = `mongodb://${ref("MONGO_INITDB_ROOT_USERNAME")}:${ref("MONGO_INITDB_ROOT_PASSWORD")}@${HOST}:${port}/?authSource=admin`;
      return [
        plain("MONGO_INITDB_ROOT_USERNAME", "root"),
        hidden("MONGO_INITDB_ROOT_PASSWORD", secret()),
        ro,
        hidden("MONGO_URL", url),
        hidden("DATABASE_URL", url),
      ];
    }
  }
}

/**
 * The start command of the Redis-compatible images. The image has no
 * password variable, so the password comes from the environment through a
 * shell. Re-entering `docker-entrypoint.sh` with the server as `$1` keeps
 * the image's own chown of `/data` and its drop to the unprivileged user.
 * The read-only ACL user is declared here, so it needs no provisioning.
 *
 * NOTE: each ACL rule must be its own argument; the server reads a single
 * quoted string as the user name and refuses to start. `-@dangerous` also
 * strips INFO and `+@read` lacks SELECT, so both are granted back for the
 * data browser's namespace listing.
 */
function redisStartCommand(server: "valkey" | "redis"): string {
  return (
    `exec docker-entrypoint.sh ${server}-server --requirepass "$REDIS_PASSWORD"` +
    ` --user ${READONLY_DB_USER} on ">$${READONLY_PASSWORD_VARIABLE}" "~*" "&*"` +
    " +@read -@dangerous +info +select +ping --appendonly yes"
  );
}

/**
 * The exec health probe of a running database, as an argument vector for
 * the agent. Every probe connects over TCP to 127.0.0.1, so it fails while
 * the image's init step runs its socket-only temporary server.
 *
 * @param engine - The engine.
 * @param version - The version, for the Redis-compatible CLI name.
 * @returns The `exec` probe command.
 */
export function databaseHealthCommand(
  engine: ServiceDatabaseEngine,
  version: DatabaseVersion,
): string[] {
  switch (engine) {
    case "postgres":
      return ["sh", "-c", 'pg_isready -q -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'];
    case "mysql":
      return ["sh", "-c", "mysqladmin ping -h 127.0.0.1 --silent"];
    case "redis":
      return [
        "sh",
        "-c",
        `${version.server ?? "valkey"}-cli -h 127.0.0.1 -a "$REDIS_PASSWORD" --no-auth-warning ping | grep -q PONG`,
      ];
    case "mongodb":
      return [
        "sh",
        "-c",
        "mongosh --quiet --host 127.0.0.1 --eval 'quit(db.adminCommand({ ping: 1 }).ok ? 0 : 1)'",
      ];
  }
}

/**
 * Renders a database service (ADR 0004): a pinned image, one replica,
 * resources for the engine, its port on the private network only, a volume
 * at the engine's data directory, and freshly generated credentials with
 * the reference-valued connection variables built from them.
 *
 * The values here are what the service is created with; the API stores the
 * secret ones write-only, so nobody reads them back.
 *
 * @param engine - The engine.
 * @param version - A registry version; the default when omitted.
 * @param randomBytes - Randomness source for the credentials.
 * @param sizeMb - Volume size; {@link DEFAULT_DATABASE_VOLUME_MB} when omitted.
 * @returns The rendered service.
 * @throws When the version isn't in the registry.
 * @example
 * const db = renderDatabaseService("postgres", undefined, (n) => crypto.getRandomValues(new Uint8Array(n)));
 * db.variables.find((v) => v.key === "DATABASE_URL")?.secret; // true
 */
export function renderDatabaseService(
  engine: ServiceDatabaseEngine,
  version: string | null | undefined,
  randomBytes: RandomBytes,
  sizeMb = DEFAULT_DATABASE_VOLUME_MB,
): RenderedDatabase {
  const spec = DATABASE_ENGINE_SPECS[engine];
  const v = databaseVersion(engine, version);
  if (!v) throw new Error(`${spec.name} has no version ${version}`);
  const image = databaseImage(v);
  const config: ServiceConfigSpec = {
    source: { type: "image", image },
    build: { builder: "railpack", build_args: {} },
    deploy: {
      replicas: 1,
      restart_policy: "on_failure",
      max_retries: 10,
      drain_s: 0,
      ...(engine === "redis" ? { start_command: redisStartCommand(v.server ?? "valkey") } : {}),
    },
    resources: { cpu_millis: 1000, memory_mb: spec.memoryMb },
    // The agent gets the engine's exec probe instead; see databaseHealthCommand.
    healthcheck: null,
    networking: { port: spec.port, generated_domain: false },
    placement: { node_selector: {} },
  };
  return {
    engine,
    version: v,
    image,
    config,
    volume: { mount_path: v.mountPath, size_mb: sizeMb },
    variables: engineVariables(engine, spec.port, () => generateDatabasePassword(randomBytes)),
  };
}

/**
 * Credentials the agent connects with for a data-browser query: the
 * read-only principal, or the engine's admin for writes and provisioning.
 * Names are variables of the database service; the API resolves them and
 * seals the result to the node, never returning it.
 *
 * @param engine - The engine.
 * @param mode - `read` or `write`.
 * @returns Literal username or the variable holding it, and the password variable.
 */
export function databaseCredentialVariables(
  engine: ServiceDatabaseEngine,
  mode: "read" | "write",
): { username: { literal: string } | { variable: string }; passwordVariable: string } {
  if (mode === "read") {
    return {
      username: { literal: READONLY_DB_USER },
      passwordVariable: READONLY_PASSWORD_VARIABLE,
    };
  }
  switch (engine) {
    case "postgres":
      return { username: { variable: "POSTGRES_USER" }, passwordVariable: "POSTGRES_PASSWORD" };
    case "mysql":
      return { username: { literal: "root" }, passwordVariable: "MYSQL_ROOT_PASSWORD" };
    case "redis":
      return { username: { literal: "default" }, passwordVariable: "REDIS_PASSWORD" };
    case "mongodb":
      return {
        username: { variable: "MONGO_INITDB_ROOT_USERNAME" },
        passwordVariable: "MONGO_INITDB_ROOT_PASSWORD",
      };
  }
}
