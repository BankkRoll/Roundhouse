/**
 * Prints the control plane's OpenAPI document, as served at
 * `/v1/openapi.json`, with keys sorted so the snapshot diffs cleanly.
 *
 * Run through `cli/scripts/gen-openapi.sh`.
 */
import { app } from "../../../apps/api/src/index";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

const doc = app.getOpenAPI31Document({
  openapi: "3.1.0",
  info: { title: "OpenAPI snapshot for the CLI contract test", version: "snapshot" },
});
process.stdout.write(`${JSON.stringify(sortKeys(doc), null, 2)}\n`);
