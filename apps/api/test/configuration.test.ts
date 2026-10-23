/**
 * Keeps the Worker's configuration surfaces in agreement: the `Env` type,
 * the bindings in `wrangler.jsonc`, `.dev.vars.example` and
 * `docs/configuration.md`. A setting added to one and forgotten in another
 * fails here instead of surprising a self-hoster.
 *
 * @module
 */
import { describe, expect, it } from "vitest";
import configurationDoc from "../../../docs/configuration.md?raw";
import devVarsExample from "../.dev.vars.example?raw";
import envSource from "../src/env.ts?raw";
import wranglerConfig from "../wrangler.jsonc?raw";

interface EnvMember {
  name: string;
  type: string;
}

function envMembers(): EnvMember[] {
  const body = envSource.match(/export interface Env \{([\s\S]*?)\n\}/)?.[1];
  if (!body) throw new Error("interface Env not found in src/env.ts");
  return [...body.matchAll(/^ {2}([A-Z][A-Z0-9_]*)\??: ([^;]+);/gm)].map(([, name, type]) => ({
    name: name as string,
    type: (type as string).trim(),
  }));
}

/** Settings are the string members: secrets and plain-text variables. */
const settings = envMembers()
  .filter((m) => m.type === "string")
  .map((m) => m.name)
  .sort();
const bindings = envMembers()
  .filter((m) => m.type !== "string")
  .map((m) => m.name)
  .sort();

describe("configuration surfaces", () => {
  it("finds the settings and bindings it checks", () => {
    expect(settings).toContain("MASTER_KEY");
    expect(bindings).toContain("DB");
  });

  it(".dev.vars.example lists every setting in Env, and nothing else", () => {
    const keys = [...devVarsExample.matchAll(/^(?:# )?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
    expect([...new Set(keys)].sort()).toEqual(settings);
  });

  it("wrangler.jsonc declares exactly the bindings Env types", () => {
    const declared = [
      ...wranglerConfig.matchAll(/"(?:binding|name)"\s*:\s*"([A-Z][A-Z0-9_]*)"/g),
    ].map((m) => m[1]);
    expect([...new Set(declared)].sort()).toEqual(bindings);
  });

  it("wrangler.jsonc leaves settings to the operator", () => {
    expect(wranglerConfig).not.toMatch(/"vars"\s*:/);
    expect(wranglerConfig).toMatch(/"keep_vars"\s*:\s*true/);
  });

  it("docs/configuration.md documents every setting and binding", () => {
    const missing = [...settings, ...bindings].filter(
      (name) => !configurationDoc.includes(`\`${name}\``),
    );
    expect(missing).toEqual([]);
  });
});
