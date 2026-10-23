// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are variable references (`${{svc.VAR}}`), not template literals.
import { describe, expect, it } from "vitest";
import {
  isSecretTemplateVariable,
  renderTemplate,
  resolveTemplateInputs,
  TemplateInputError,
  type TemplateManifest,
  TemplateSchema,
  templateRequirements,
} from "./template";
import { parseReferences } from "./variables";

const base = (overrides: Partial<TemplateManifest> = {}): TemplateManifest => ({
  schema_version: 1,
  id: "stack",
  version: 1,
  name: "Stack",
  description: "Two services",
  category: "starter",
  services: [
    {
      ref: "api",
      name: "API",
      source: { type: "git", repo_url: "https://github.com/acme/api", branch: "main" },
      variables: {
        TOKEN: { generate: { bytes: 32, encoding: "base64url" } },
        WEB_URL: "http://${{web.ROUNDHOUSE_PRIVATE_DOMAIN}}:${{web.PORT}}",
      },
    },
    {
      ref: "web",
      name: "Web",
      source: { type: "image", image: "nginx:stable-alpine" },
      variables: { API_TOKEN: "${{api.TOKEN}}", GREETING: "${{input.GREETING}}" },
    },
  ],
  inputs: [{ key: "GREETING", label: "Greeting", type: "string", required: true }],
  ...overrides,
});

const issuesOf = (manifest: unknown) => {
  const result = TemplateSchema.safeParse(manifest);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

let counter = 0;
const bytes = (n: number) => Uint8Array.from({ length: n }, () => counter++ % 256);

describe("TemplateSchema", () => {
  it("accepts a valid stack and applies defaults", () => {
    const t = TemplateSchema.parse(base());
    expect(t.tags).toEqual([]);
    expect(t.services[0]!.kind).toBe("app");
    expect(t.services[0]!.source).toMatchObject({ root_dir: "." });
  });

  it("rejects unknown keys at every level", () => {
    expect(issuesOf({ ...base(), extra: 1 })).not.toEqual([]);
    const typo = base();
    (typo.services[0] as Record<string, unknown>).varibles = {};
    expect(issuesOf(typo)).not.toEqual([]);
  });

  it("rejects duplicate refs and reserved namespaces", () => {
    const dup = base();
    dup.services[1]!.ref = "api";
    expect(issuesOf(dup)).toContain("duplicate ref api");
    for (const ref of ["shared", "input"]) {
      const reserved = base();
      reserved.services[1]!.ref = ref;
      expect(issuesOf(reserved).join()).toContain("reference namespaces");
    }
  });

  it("checks every reference against the template", () => {
    const unknownService = base();
    unknownService.services[1]!.variables = { X: "${{db.URL}}" };
    expect(issuesOf(unknownService).join()).toContain('No service "db"');

    const unknownVar = base();
    unknownVar.services[1]!.variables = { X: "${{api.NOPE}}" };
    expect(issuesOf(unknownVar).join()).toContain("api.NOPE is not defined");

    const unknownInput = base();
    unknownInput.services[1]!.variables = { X: "${{input.NOPE}}" };
    expect(issuesOf(unknownInput).join()).toContain("names no declared input");

    const unknownShared = base({ shared_variables: { A: "${{shared.B}}" } });
    expect(issuesOf(unknownShared).join()).toContain("shared.B is not defined");

    const malformed = base();
    malformed.services[1]!.variables = { X: "${{ bad ref }}" };
    expect(issuesOf(malformed).join()).toContain("Invalid reference");
  });

  it("accepts built-ins, own variables and shared variables", () => {
    const ok = base({ shared_variables: { REGION: "eu", URL: "${{REGION}}-1" } });
    ok.services[1]!.variables = {
      A: "${{PORT}}",
      B: "${{A}}",
      C: "${{shared.URL}}",
      D: "$${{not.a.reference}}",
    };
    expect(issuesOf(ok)).toEqual([]);
  });

  it("rejects reference cycles, including through shared variables", () => {
    const cycle = base();
    cycle.services[0]!.variables = { A: "${{web.B}}" };
    cycle.services[1]!.variables = { B: "${{api.A}}" };
    expect(issuesOf(cycle).join()).toContain("loop");

    const sharedCycle = base({ shared_variables: { A: "${{B}}", B: "${{A}}" } });
    expect(issuesOf(sharedCycle).join()).toContain("loop");
  });

  it("validates inputs", () => {
    const select = base({
      inputs: [{ key: "SIZE", label: "Size", type: "select", required: false, default: "xl" }],
    });
    select.services[1]!.variables = {};
    expect(issuesOf(select).join()).toContain("options are required");
    expect(
      issuesOf(
        base({
          inputs: [
            { key: "GREETING", label: "G", type: "secret", required: true, default: "nope" },
          ],
        }),
      ).join(),
    ).toContain("secret inputs can't have a default");
    expect(
      issuesOf(
        base({
          inputs: [
            { key: "GREETING", label: "G", type: "string", required: true },
            { key: "GREETING", label: "G", type: "string", required: true },
          ],
        }),
      ),
    ).toContain("duplicate input GREETING");
  });

  it("requires exactly one of value and generate", () => {
    const both = base();
    both.services[0]!.variables = {
      X: { value: "a", generate: { bytes: 16, encoding: "hex" } },
    };
    expect(issuesOf(both).join()).toContain("exactly one of value and generate");
    const tooSmall = base();
    tooSmall.services[0]!.variables = { X: { generate: { bytes: 8, encoding: "hex" } } };
    expect(issuesOf(tooSmall)).not.toEqual([]);
  });

  it("ties database sources to the database kind and reports requirements", () => {
    const wrongKind = base();
    wrongKind.services.push({
      ref: "db",
      name: "Postgres",
      source: { type: "database", engine: "postgres" },
    });
    expect(issuesOf(wrongKind).join()).toContain("database sources are kind database");

    const stack = base();
    stack.services.push({
      ref: "db",
      name: "Postgres",
      kind: "database",
      source: { type: "database", engine: "postgres", version: "18" },
      volume: { mount_path: "/var/lib/postgresql", size_mb: 5120 },
    });
    const parsed = TemplateSchema.parse(stack);
    expect(templateRequirements(parsed)).toEqual(["databases", "volumes"]);
    expect(templateRequirements(TemplateSchema.parse(base()))).toEqual([]);
  });

  it("checks connects_to targets", () => {
    const bad = base();
    bad.services[0]!.connects_to = ["nope"];
    expect(issuesOf(bad).join()).toContain("connects_to names no other service");
    const self = base();
    self.services[0]!.connects_to = ["api"];
    expect(issuesOf(self)).not.toEqual([]);
    const ok = base();
    ok.services[0]!.connects_to = ["web"];
    expect(issuesOf(ok)).toEqual([]);
  });
});

describe("isSecretTemplateVariable", () => {
  it("marks generated, explicit and secret-input variables", () => {
    const t = TemplateSchema.parse(
      base({
        inputs: [
          { key: "GREETING", label: "G", type: "string", required: true },
          { key: "KEY", label: "Key", type: "secret", required: true },
        ],
      }),
    );
    expect(isSecretTemplateVariable(t, { generate: { bytes: 16, encoding: "hex" } })).toBe(true);
    expect(isSecretTemplateVariable(t, { value: "x", secret: true })).toBe(true);
    expect(isSecretTemplateVariable(t, "Bearer ${{input.KEY}}")).toBe(true);
    expect(isSecretTemplateVariable(t, "${{input.GREETING}}")).toBe(false);
    expect(isSecretTemplateVariable(t, "plain")).toBe(false);
  });
});

describe("resolveTemplateInputs", () => {
  const t = TemplateSchema.parse(
    base({
      inputs: [
        { key: "GREETING", label: "G", type: "string", required: true },
        { key: "COUNT", label: "C", type: "number", required: false, default: "3" },
        { key: "ON", label: "On", type: "boolean", required: false },
        { key: "SIZE", label: "S", type: "select", required: false, options: ["s", "m"] },
      ],
    }),
  );

  it("applies defaults and treats empty strings as absent", () => {
    expect(resolveTemplateInputs(t, { GREETING: "hi", COUNT: "" })).toEqual({
      GREETING: "hi",
      COUNT: "3",
      ON: "",
      SIZE: "",
    });
  });

  it("reports every problem at once", () => {
    try {
      resolveTemplateInputs(t, { COUNT: "lots", ON: "yes", SIZE: "xl", EXTRA: "1" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateInputError);
      expect((err as TemplateInputError).issues.map((i) => [i.key, i.code])).toEqual([
        ["EXTRA", "unknown_input"],
        ["GREETING", "required"],
        ["COUNT", "invalid"],
        ["ON", "invalid"],
        ["SIZE", "invalid"],
      ]);
    }
  });
});

describe("renderTemplate", () => {
  const t = TemplateSchema.parse(base());

  it("keeps refs as slugs when they are free", () => {
    const r = renderTemplate(t, {
      inputs: { GREETING: "hello" },
      existingSlugs: [],
      randomBytes: bytes,
    });
    expect(r.services.map((s) => s.slug)).toEqual(["api", "web"]);
    const web = r.services[1]!;
    expect(web.variables).toEqual([
      { key: "API_TOKEN", value: "${{api.TOKEN}}", secret: false, generated: false },
      { key: "GREETING", value: "hello", secret: false, generated: false },
    ]);
  });

  it("suffixes taken slugs and rewrites references to follow them", () => {
    const r = renderTemplate(t, {
      inputs: { GREETING: "hello" },
      existingSlugs: ["api", "web", "web-2"],
      randomBytes: bytes,
    });
    expect(r.services.map((s) => s.slug)).toEqual(["api-2", "web-3"]);
    expect(r.services[0]!.variables[1]!.value).toBe(
      "http://${{web-3.ROUNDHOUSE_PRIVATE_DOMAIN}}:${{web-3.PORT}}",
    );
    expect(r.services[1]!.variables[0]!.value).toBe("${{api-2.TOKEN}}");
  });

  it("mints generated secrets in the requested encoding", () => {
    const hex = TemplateSchema.parse(
      base({
        services: [
          {
            ref: "app",
            name: "App",
            source: { type: "image", image: "nginx" },
            variables: {
              HEX: { generate: { bytes: 32, encoding: "hex" } },
              B64: { generate: { bytes: 32, encoding: "base64url" } },
              ODD: { generate: { bytes: 17, encoding: "base64url" } },
            },
          },
        ],
        inputs: [],
      }),
    );
    const vars = renderTemplate(hex, { inputs: {}, existingSlugs: [], randomBytes: bytes })
      .services[0]!.variables;
    expect(vars.every((v) => v.secret && v.generated)).toBe(true);
    expect(vars[0]!.value).toMatch(/^[0-9a-f]{64}$/);
    expect(vars[1]!.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(vars[2]!.value).toMatch(/^[A-Za-z0-9_-]{23}$/);
  });

  it("encodes base64url like the platform does", () => {
    const one = TemplateSchema.parse(
      base({
        services: [
          {
            ref: "app",
            name: "App",
            source: { type: "image", image: "nginx" },
            variables: { K: { generate: { bytes: 16, encoding: "base64url" } } },
          },
        ],
        inputs: [],
      }),
    );
    const fixed = Uint8Array.from([0xfb, 0xff, 0xfe, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const value = renderTemplate(one, { inputs: {}, existingSlugs: [], randomBytes: () => fixed })
      .services[0]!.variables[0]!.value;
    expect(value).toBe("-__-AAECAwQFBgcICQoLDA");
  });

  it("escapes input text so it can't inject a reference", () => {
    const r = renderTemplate(t, {
      inputs: { GREETING: "hi ${{api.TOKEN}}" },
      existingSlugs: [],
      randomBytes: bytes,
    });
    const value = r.services[1]!.variables[1]!.value;
    expect(value).toBe("hi $${{api.TOKEN}}");
    expect(parseReferences(value).references).toEqual([]);
  });

  it("refuses missing required inputs", () => {
    expect(() => renderTemplate(t, { inputs: {}, existingSlugs: [], randomBytes: bytes })).toThrow(
      TemplateInputError,
    );
  });

  it("never puts a generated value anywhere but its own variable", () => {
    const r = renderTemplate(t, {
      inputs: { GREETING: "x" },
      existingSlugs: [],
      randomBytes: bytes,
    });
    const token = r.services[0]!.variables[0]!.value;
    const others = r.services.flatMap((s) => s.variables).filter((v) => v.key !== "TOKEN");
    expect(others.some((v) => v.value.includes(token))).toBe(false);
  });
});
