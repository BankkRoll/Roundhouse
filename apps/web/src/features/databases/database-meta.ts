/**
 * Presentation helpers for database services: engine and version labels, the variables
 * a database is created with (names only), its private hostname, and how the data
 * browser shows and exports cells.
 *
 * @module
 */
import {
  DATABASE_ENGINE_SPECS,
  databaseVersion,
  renderDatabaseService,
  type ServiceDatabaseEngine,
} from "@roundhouse/shared";

/** A database variable's name and whether it is stored write-only. */
export interface DatabaseVariableName {
  key: string;
  secret: boolean;
}

/**
 * The variables a new database of `engine` gets, in creation order. Only names and
 * secrecy leave this function.
 *
 * @param engine - The engine.
 * @returns Keys with `secret` set for write-only ones.
 * @example
 * databaseVariableNames("redis").map((v) => v.key); // ["REDIS_PASSWORD", "ROUNDHOUSE_RO_PASSWORD", "REDIS_URL"]
 */
export function databaseVariableNames(engine: ServiceDatabaseEngine): DatabaseVariableName[] {
  // SECURITY: rendered with zero bytes so no credential is ever generated in the browser;
  // the values are dropped here and the API generates the real ones.
  const rendered = renderDatabaseService(engine, undefined, (n) => new Uint8Array(n));
  return rendered.variables.map(({ key, secret }) => ({ key, secret }));
}

/**
 * The label of an engine's version, e.g. "PostgreSQL 18".
 *
 * @param engine - The engine.
 * @param version - Registry version.
 * @returns The registry's label, or `engine version` for a version it no longer offers.
 */
export function databaseVersionLabel(engine: ServiceDatabaseEngine, version: string): string {
  return (
    DATABASE_ENGINE_SPECS[engine].versions.find((v) => v.version === version)?.label ??
    `${DATABASE_ENGINE_SPECS[engine].name} ${version}`
  );
}

/**
 * The data directory a version mounts its volume at.
 *
 * @param engine - The engine.
 * @param version - Registry version; the default when omitted.
 * @returns The mount path.
 */
export function databaseMountPath(engine: ServiceDatabaseEngine, version?: string): string {
  return databaseVersion(engine, version)?.mountPath ?? "/data";
}

/**
 * A service's hostname on the project's private network.
 *
 * @param serviceSlug - Service slug.
 * @param environmentSlug - Environment slug.
 * @returns e.g. `postgres.production.internal`.
 */
export function privateHostname(serviceSlug: string, environmentSlug: string): string {
  return `${serviceSlug}.${environmentSlug}.internal`;
}

/**
 * A reference other services put in their variables to read one of this service's.
 *
 * @param serviceSlug - Service slug.
 * @param key - Variable key.
 * @returns e.g. `${{postgres.DATABASE_URL}}`.
 */
export function variableReference(serviceSlug: string, key: string): string {
  return `\${{${serviceSlug}.${key}}}`;
}

function isBinary(value: unknown): value is { $b64: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { $b64?: unknown }).$b64 === "string"
  );
}

/**
 * How the data browser shows one cell: `NULL`, binary as its size, objects as JSON.
 *
 * @param value - A JSON cell from a query result.
 * @returns Display text.
 * @example
 * formatCell(null); // "NULL"
 * formatCell({ $b64: "AAEC" }); // "<binary 3 B>"
 */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (isBinary(value)) {
    const bytes = Math.floor((value.$b64.replace(/=+$/, "").length * 3) / 4);
    return `<binary ${bytes} B>`;
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = isBinary(value)
    ? value.$b64
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Serialises a result as RFC 4180 CSV: a header row, then one line per row. `NULL` is
 * an empty field and binary stays base64.
 *
 * @param columns - Result columns.
 * @param rows - Result rows.
 * @returns CSV text with CRLF line ends.
 * @example
 * toCsv([{ name: "a" }, { name: "b" }], [[1, "x,y"]]); // 'a,b\r\n1,"x,y"'
 */
export function toCsv(columns: readonly { name: string }[], rows: readonly unknown[][]): string {
  return [columns.map((c) => csvField(c.name)), ...rows.map((row) => row.map(csvField))]
    .map((fields) => fields.join(","))
    .join("\r\n");
}
