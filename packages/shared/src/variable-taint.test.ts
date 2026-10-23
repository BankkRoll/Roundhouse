// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these are variable references (`${{svc.VAR}}`), not template literals.
import { describe, expect, it } from "vitest";
import { secretDerivedVariables } from "./variable-taint";

describe("secretDerivedVariables", () => {
  it("returns nothing when no plain value references a secret", () => {
    expect(
      secretDerivedVariables({
        services: { api: { A: "x", B: "${{A}}" } },
        shared: { R: "eu" },
        secretServiceKeys: {},
        secretSharedKeys: [],
      }),
    ).toEqual({ services: {}, shared: [] });
  });

  it("taints direct, transitive, cross-service and shared references", () => {
    const result = secretDerivedVariables({
      services: {
        api: {
          URL: "pg://u:${{db.PASSWORD}}@db",
          ALIAS: "${{URL}}",
          SAFE: "${{db.HOST}}",
          FROM_SHARED: "${{shared.ALIAS}}",
          PORT_REF: "${{PORT}}",
        },
        db: { PASSWORD: "hunter22", HOST: "db.internal" },
      },
      shared: { TOKEN: "t0k3n-value", ALIAS: "Bearer ${{TOKEN}}", REGION: "eu" },
      secretServiceKeys: { db: ["PASSWORD"] },
      secretSharedKeys: ["TOKEN"],
    });
    expect(result).toEqual({
      services: { api: ["ALIAS", "FROM_SHARED", "URL"] },
      shared: ["ALIAS"],
    });
  });

  it("never lists secret keys themselves", () => {
    const result = secretDerivedVariables({
      services: { api: { S: "${{T}}", T: "x" } },
      shared: {},
      secretServiceKeys: { api: ["S", "T"] },
      secretSharedKeys: [],
    });
    expect(result.services).toEqual({});
  });

  it("does not loop on cycles or unknown references", () => {
    const result = secretDerivedVariables({
      services: { api: { A: "${{B}}", B: "${{A}}", C: "${{nope.X}}", D: "${{MISSING}}" } },
      shared: {},
      secretServiceKeys: {},
      secretSharedKeys: [],
    });
    expect(result).toEqual({ services: {}, shared: [] });
  });

  it("resolves unqualified shared references within shared", () => {
    const result = secretDerivedVariables({
      services: {},
      shared: { A: "${{B}}", B: "s3cret-shared" },
      secretServiceKeys: {},
      secretSharedKeys: ["B"],
    });
    expect(result.shared).toEqual(["A"]);
  });
});
