import { describe, expect, it } from "vitest";
import {
  databaseVariableNames,
  databaseVersionLabel,
  formatCell,
  privateHostname,
  toCsv,
  variableReference,
} from "./database-meta";

describe("database helpers", () => {
  it("lists a new database's variables by name and secrecy, never with values", () => {
    const postgres = databaseVariableNames("postgres");
    expect(postgres).toContainEqual({ key: "DATABASE_URL", secret: true });
    expect(postgres).toContainEqual({ key: "POSTGRES_USER", secret: false });
    expect(postgres.every((v) => Object.keys(v).sort().join() === "key,secret")).toBe(true);
    expect(databaseVariableNames("redis").map((v) => v.key)).toEqual([
      "REDIS_PASSWORD",
      "ROUNDHOUSE_RO_PASSWORD",
      "REDIS_URL",
    ]);
  });

  it("labels versions from the registry and falls back for retired ones", () => {
    expect(databaseVersionLabel("redis", "valkey-9")).toBe("Valkey 9.1");
    expect(databaseVersionLabel("postgres", "12")).toBe("PostgreSQL 12");
  });

  it("builds private hostnames and references", () => {
    expect(privateHostname("postgres", "production")).toBe("postgres.production.internal");
    expect(variableReference("postgres", "DATABASE_URL")).toBe(`\${{postgres.DATABASE_URL}}`);
  });

  it("shows NULL, binary sizes and JSON cells", () => {
    expect(formatCell(null)).toBe("NULL");
    expect(formatCell({ $b64: "AAEC" })).toBe("<binary 3 B>");
    expect(formatCell({ gift: true })).toBe('{"gift":true}');
    expect(formatCell("12345678901234567890")).toBe("12345678901234567890");
  });

  it("writes RFC 4180 CSV", () => {
    expect(
      toCsv(
        [{ name: "id" }, { name: "note" }, { name: "meta" }],
        [
          ["1", 'say "hi", twice', null],
          ["2", "line\nbreak", { a: 1 }],
        ],
      ),
    ).toBe('id,note,meta\r\n1,"say ""hi"", twice",\r\n2,"line\nbreak","{""a"":1}"');
  });
});
