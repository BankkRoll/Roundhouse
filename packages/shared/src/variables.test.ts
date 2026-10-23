// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are variable references (`${{svc.VAR}}`), not template literals.
import { describe, expect, it } from "vitest";
import {
  MAX_RESOLVED_VALUE_BYTES,
  parseReferences,
  type ResolveVariablesInput,
  resolveVariables,
  variableDependencies,
} from "./variables";

describe("parseReferences", () => {
  it("returns plain text untouched", () => {
    expect(parseReferences("hello $HOME {{x}} $")).toEqual({
      segments: [{ type: "text", text: "hello $HOME {{x}} $" }],
      references: [],
      errors: [],
    });
  });

  it("returns nothing for an empty value", () => {
    expect(parseReferences("")).toEqual({ segments: [], references: [], errors: [] });
  });

  it("finds qualified, shared and unqualified references with positions", () => {
    const value = "a${{api.URL}}b${{ shared.REGION }}${{PORT}}";
    const { segments, references, errors } = parseReferences(value);
    expect(errors).toEqual([]);
    expect(references).toEqual([
      { namespace: "api", name: "URL", start: 1, end: 13 },
      { namespace: "shared", name: "REGION", start: 14, end: 34 },
      { namespace: null, name: "PORT", start: 34, end: 43 },
    ]);
    for (const r of references) expect(value.slice(r.start, r.end).startsWith("${{")).toBe(true);
    expect(segments.map((s) => s.type)).toEqual([
      "text",
      "reference",
      "text",
      "reference",
      "reference",
    ]);
  });

  it("accepts dashed service slugs", () => {
    expect(parseReferences("${{my-api-2.X_1}}").references[0]).toMatchObject({
      namespace: "my-api-2",
      name: "X_1",
    });
  });

  it("unescapes $${{ to a literal ${{", () => {
    expect(parseReferences("$${{api.URL}}")).toEqual({
      segments: [{ type: "text", text: "${{api.URL}}" }],
      references: [],
      errors: [],
    });
    expect(parseReferences("$$${{X}}").references).toEqual([]);
    // A lone $ before an escape stays literal.
    expect(parseReferences("$ $${{X}}").segments).toEqual([{ type: "text", text: "$ ${{X}}" }]);
  });

  it.each([
    ["${{}}", 0, 5],
    ["x${{api.}}", 1, 10],
    ["${{Api.URL}}", 0, 12],
    ["${{api.1URL}}", 0, 13],
    ["${{a.b.c}}", 0, 10],
    ["${{-api.X}}", 0, 11],
    ["${{api-.X}}", 0, 11],
    ["${{api URL}}", 0, 12],
  ])("reports %s as malformed at [%i, %i)", (value, start, end) => {
    const parsed = parseReferences(value);
    expect(parsed.references).toEqual([]);
    expect(parsed.errors).toEqual([
      expect.objectContaining({ code: "malformed_reference", start, end }),
    ]);
    expect(parsed.segments).toEqual([{ type: "text", text: value }]);
  });

  it("reports an unclosed reference to the end of the value", () => {
    expect(parseReferences("ok ${{api.URL").errors).toEqual([
      expect.objectContaining({ code: "unclosed_reference", start: 3, end: 13 }),
    ]);
  });

  it("keeps parsing after a malformed reference", () => {
    const parsed = parseReferences("${{bad name}}-${{GOOD}}");
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.references).toEqual([{ namespace: null, name: "GOOD", start: 14, end: 23 }]);
  });
});

function input(overrides: Partial<ResolveVariablesInput> = {}): ResolveVariablesInput {
  return {
    service: "api",
    services: { api: {}, db: {} },
    shared: {},
    builtins: {
      api: { PORT: "8080", ROUNDHOUSE_PRIVATE_DOMAIN: "api.internal" },
      db: { PORT: "5432", ROUNDHOUSE_PRIVATE_DOMAIN: "db.internal" },
    },
    ...overrides,
  };
}

describe("resolveVariables", () => {
  it("returns built-ins overlaid with the service's own variables", () => {
    const result = resolveVariables(input({ services: { api: { PORT: "3000", A: "x" }, db: {} } }));
    expect(result).toEqual({
      ok: true,
      env: { PORT: "3000", ROUNDHOUSE_PRIVATE_DOMAIN: "api.internal", A: "x" },
    });
  });

  it("substitutes references to other services, shared values and built-ins", () => {
    const result = resolveVariables(
      input({
        services: {
          api: {
            DATABASE_URL:
              "postgres://${{db.USER}}@${{db.ROUNDHOUSE_PRIVATE_DOMAIN}}:${{db.PORT}}/app",
            LISTEN: ":${{PORT}}",
            REGION: "${{shared.REGION}}",
          },
          db: { USER: "${{shared.DB_USER}}" },
        },
        shared: { REGION: "eu", DB_USER: "app" },
      }),
    );
    expect(result).toEqual({
      ok: true,
      env: {
        PORT: "8080",
        ROUNDHOUSE_PRIVATE_DOMAIN: "api.internal",
        DATABASE_URL: "postgres://app@db.internal:5432/app",
        LISTEN: ":8080",
        REGION: "eu",
      },
    });
  });

  it("prefers a service's own variable over its built-in", () => {
    const result = resolveVariables(
      input({ services: { api: { URL: "${{db.PORT}}" }, db: { PORT: "6543" } } }),
    );
    expect(result).toMatchObject({ ok: true, env: { URL: "6543" } });
  });

  it("resolves unqualified references inside shared values against shared", () => {
    const result = resolveVariables(
      input({
        services: { api: { HOST: "${{shared.HOST}}" }, db: {} },
        shared: { HOST: "${{SUB}}.example.com", SUB: "eu" },
      }),
    );
    expect(result).toMatchObject({ ok: true, env: { HOST: "eu.example.com" } });
  });

  it("does not parse built-in values", () => {
    const result = resolveVariables(
      input({
        services: { api: { X: "${{ROUNDHOUSE_GIT_COMMIT_SHA}}" }, db: {} },
        builtins: { api: { ROUNDHOUSE_GIT_COMMIT_SHA: "${{nope}}" }, db: {} },
      }),
    );
    expect(result).toMatchObject({ ok: true, env: { X: "${{nope}}" } });
  });

  it("keeps escaped references literal", () => {
    const result = resolveVariables(input({ services: { api: { T: "$${{db.PORT}}" }, db: {} } }));
    expect(result).toMatchObject({ ok: true, env: { T: "${{db.PORT}}" } });
  });

  it("ignores broken variables the service does not reference", () => {
    const result = resolveVariables(
      input({ services: { api: { A: "1" }, db: { BROKEN: "${{nowhere.X}}" } } }),
    );
    expect(result.ok).toBe(true);
  });

  it("reports unknown services and variables with positions", () => {
    const result = resolveVariables(
      input({
        services: { api: { A: "x${{web.URL}}", B: "${{db.NOPE}} ${{shared.NOPE}}" }, db: {} },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      expect.objectContaining({
        code: "unknown_service",
        variable: { namespace: "api", name: "A" },
        start: 1,
        end: 13,
      }),
      expect.objectContaining({
        code: "unknown_variable",
        variable: { namespace: "api", name: "B" },
        start: 0,
        end: 12,
      }),
      expect.objectContaining({
        code: "unknown_variable",
        variable: { namespace: "api", name: "B" },
        start: 13,
        end: 29,
      }),
    ]);
  });

  it("reports syntax errors against the variable that contains them", () => {
    const result = resolveVariables(
      input({ services: { api: { A: "${{shared.X}}" }, db: {} }, shared: { X: "${{oops" } }),
    );
    expect(result).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          code: "unclosed_reference",
          variable: { namespace: "shared", name: "X" },
          start: 0,
          end: 7,
        }),
      ],
    });
  });

  it("detects self references", () => {
    const result = resolveVariables(input({ services: { api: { A: "${{A}}" }, db: {} } }));
    expect(result).toMatchObject({
      ok: false,
      errors: [{ code: "cycle", cycle: ["api.A", "api.A"] }],
    });
  });

  it("detects cycles across services and shared", () => {
    const result = resolveVariables(
      input({
        services: { api: { A: "${{db.B}}" }, db: { B: "${{shared.C}}" } },
        shared: { C: "${{api.A}}" },
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      errors: [
        {
          code: "cycle",
          variable: { namespace: "shared", name: "C" },
          cycle: ["api.A", "db.B", "shared.C", "api.A"],
        },
      ],
    });
  });

  it("resolves shared dependencies once (diamonds are not cycles)", () => {
    const result = resolveVariables(
      input({
        services: { api: { A: "${{B}}-${{C}}", B: "${{D}}", C: "${{D}}", D: "d" }, db: {} },
      }),
    );
    expect(result).toMatchObject({ ok: true, env: { A: "d-d" } });
  });

  it("fails fast on values that grow past the limit", () => {
    const services: Record<string, string> = { V0: "x".repeat(64) };
    for (let i = 1; i <= 40; i++) services[`V${i}`] = `\${{V${i - 1}}}\${{V${i - 1}}}`;
    const result = resolveVariables(input({ services: { api: services, db: {} } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.code === "value_too_large")).toBe(true);
  });

  it("counts the limit in UTF-8 bytes", () => {
    const fits = "é".repeat(MAX_RESOLVED_VALUE_BYTES / 2);
    expect(resolveVariables(input({ services: { api: { A: fits }, db: {} } })).ok).toBe(true);
    const over = resolveVariables(
      input({ services: { api: { A: "${{B}}", B: `${fits}é` }, db: {} } }),
    );
    expect(over.ok).toBe(false);
  });

  it("treats prototype names as unknown, not inherited", () => {
    const result = resolveVariables(
      input({ services: { api: { A: "${{constructor}} ${{__proto__.X}}" }, db: {} } }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("variableDependencies", () => {
  it("lists one sorted edge per service pair", () => {
    expect(
      variableDependencies({
        web: { API: "${{api.URL}}", REGION: "${{shared.REGION}}" },
        api: {
          DB: "${{db.URL}}:${{db.PORT}}",
          ALSO: "${{db.URL}}",
          SELF: "${{api.X}}",
          X: "${{Y}}",
        },
        db: {},
      }),
    ).toEqual([
      { from: "api", to: "db", variables: ["db.PORT", "db.URL"] },
      { from: "web", to: "api", variables: ["api.URL"] },
      { from: "web", to: "shared", variables: ["shared.REGION"] },
    ]);
  });

  it("ignores escaped and malformed references", () => {
    expect(variableDependencies({ a: { X: "$${{b.Y}} ${{B.Y}}" } })).toEqual([]);
  });
});
