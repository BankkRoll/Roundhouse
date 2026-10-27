import { describe, expect, it } from "vitest";
import { parseDotenv } from "./dotenv";
import {
  applySuggestion,
  EMPTY_DRAFT,
  errorsFromDetails,
  lockedTier,
  mapApiError,
  mergeRows,
  type ReferenceCatalog,
  referenceContext,
  referenceSuggestions,
  stageDelete,
  stageSet,
  toPutBody,
  unstage,
} from "./variables-model";

const ref = (body: string) => `\${{${body}`;

describe("parseDotenv", () => {
  it("parses assignments, exports, comments and quotes", () => {
    const text = [
      "# comment",
      "PORT=8080",
      "export NAME='a # b'",
      'GREETING="hi\\nthere" # trailing',
      "URL=http://x # comment",
      "",
      'MULTI="one',
      'two"',
      "EMPTY=",
    ].join("\n");
    expect(parseDotenv(text)).toEqual({
      entries: [
        { key: "PORT", value: "8080", line: 2 },
        { key: "NAME", value: "a # b", line: 3 },
        { key: "GREETING", value: "hi\nthere", line: 4 },
        { key: "URL", value: "http://x", line: 5 },
        { key: "MULTI", value: "one\ntwo", line: 7 },
        { key: "EMPTY", value: "", line: 9 },
      ],
      errors: [],
    });
  });

  it("keeps the last value of a repeated key", () => {
    expect(parseDotenv("A=1\nA=2").entries).toEqual([{ key: "A", value: "2", line: 2 }]);
  });

  it("reports bad lines with their numbers", () => {
    expect(parseDotenv("no equals\n1BAD=x\nQ=\"open\nR='x' y").errors).toEqual([
      { line: 1, message: "Expected KEY=value" },
      { line: 2, message: '"1BAD" is not a valid variable name' },
      { line: 3, message: "Unterminated double quote" },
    ]);
  });
});

describe("staging", () => {
  const saved = [
    {
      key: "A",
      value: "1",
      tier: "plain" as const,
      version: 1,
      updated_at: 0,
      locked: false,
      fingerprint: null,
      available_at_build: false,
      mount_as_file: false,
      updated_by: null,
    },
    {
      key: "S",
      value: null,
      tier: "secret" as const,
      version: 2,
      updated_at: 0,
      locked: false,
      fingerprint: "0a1b2c3d",
      available_at_build: false,
      mount_as_file: false,
      updated_by: null,
    },
  ];

  it("keeps a saved secret's fingerprint until a new value is staged", () => {
    expect(mergeRows(saved, EMPTY_DRAFT).find((row) => row.key === "S")?.fingerprint).toBe(
      "0a1b2c3d",
    );
    const draft = stageSet(EMPTY_DRAFT, "S", { value: "new", isSecret: true });
    expect(mergeRows(saved, draft).find((row) => row.key === "S")?.fingerprint).toBeNull();
  });

  it("merges staged sets and deletes into rows", () => {
    let draft = stageSet(EMPTY_DRAFT, "A", { value: "2", isSecret: false });
    draft = stageSet(draft, "NEW", { value: "x", isSecret: true });
    draft = stageDelete(draft, "S", true);
    expect(mergeRows(saved, draft).map((row) => [row.key, row.change, row.value])).toEqual([
      ["A", "changed", "2"],
      ["NEW", "added", "x"],
      ["S", "deleted", null],
    ]);
    expect(toPutBody(draft)).toEqual({
      body: {
        set: [
          { key: "A", value: "2", tier: "plain" },
          { key: "NEW", value: "x", tier: "secret" },
        ],
        delete: ["S"],
        confirm_write_only: false,
      },
      setKeys: ["A", "NEW"],
    });
    expect(
      toPutBody(draft, { confirmWriteOnly: true, acknowledgePublic: ["VITE_X"] }).body,
    ).toMatchObject({ confirm_write_only: true, acknowledge_public: ["VITE_X"] });
  });

  it("sends the tier the classifier locks, whatever the switch says", () => {
    const draft = stageSet(
      stageSet(EMPTY_DRAFT, "VITE_API_URL", { value: "https://api.example.test", isSecret: true }),
      "DATABASE_URL",
      { value: "postgres://app:not-a-real-password@db.example.test/app", isSecret: false },
    );
    expect(toPutBody(draft).body.set).toEqual([
      {
        key: "DATABASE_URL",
        value: "postgres://app:not-a-real-password@db.example.test/app",
        tier: "secret",
      },
      { key: "VITE_API_URL", value: "https://api.example.test", tier: "plain" },
    ]);
    expect(lockedTier("API_URL", "https://api.example.test")).toBeNull();
  });

  it("drops unsaved additions instead of deleting them, and can undo", () => {
    const draft = stageDelete(
      stageSet(EMPTY_DRAFT, "NEW", { value: "x", isSecret: false }),
      "NEW",
      false,
    );
    expect(draft.set.size + draft.remove.size).toBe(0);
    expect(unstage(stageDelete(EMPTY_DRAFT, "A", true), "A").remove.size).toBe(0);
  });

  it("maps API errors back to keys", () => {
    expect(mapApiError("set.1.value: bad", ["A", "B"])).toEqual({
      key: "B",
      field: "value",
      message: "bad",
    });
    expect(mapApiError("delete.0: nope", [], ["OLD"])).toEqual({
      key: "OLD",
      field: "key",
      message: "nope",
    });
    expect(mapApiError("something else", ["A"])).toBeNull();
    expect(
      errorsFromDetails([
        { field: "B", message: "first", start: 0, end: 3 },
        { field: "B", message: "second" },
        { field: "C", message: "other" },
      ]),
    ).toEqual({
      B: { key: "B", field: "value", message: "first", start: 0, end: 3 },
      C: { key: "C", field: "value", message: "other", start: undefined, end: undefined },
    });
  });
});

describe("reference autocomplete", () => {
  const catalog: ReferenceCatalog = {
    services: ["api", "db"],
    ownKeys: ["NODE_ENV"],
    sharedKeys: ["REGION"],
    serviceKeys: { api: ["API_KEY"] },
  };

  it("detects an unfinished reference at the caret", () => {
    const value = `postgres://${ref("db.HO")}`;
    expect(referenceContext(value, value.length)).toEqual({ start: 14, query: "db.HO" });
    expect(referenceContext(`${ref("a}}")} after`, 12)).toBeNull();
    expect(referenceContext(`$${ref("x")}`, 6)).toBeNull();
    expect(referenceContext("plain", 5)).toBeNull();
  });

  it("suggests namespaces, own keys and built-ins first", () => {
    const labels = referenceSuggestions("", catalog, 20).map((s) => s.label);
    expect(labels.slice(0, 3)).toEqual(["shared.", "api.", "db."]);
    expect(labels).toContain("NODE_ENV");
    expect(labels).toContain("PORT");
    expect(referenceSuggestions("a", catalog).map((s) => s.insert)).toEqual(["api."]);
  });

  it("suggests a namespace's keys and built-ins after the dot", () => {
    expect(referenceSuggestions("shared.", catalog).map((s) => s.insert)).toEqual([
      "shared.REGION",
    ]);
    const api = referenceSuggestions("api.", catalog, 20).map((s) => s.insert);
    expect(api[0]).toBe("api.API_KEY");
    expect(api).toContain("api.ROUNDHOUSE_PRIVATE_DOMAIN");
    expect(referenceSuggestions("nope.", catalog)).toEqual([]);
  });

  it("completes keys with the closing braces and keeps namespaces open", () => {
    const value = `x ${ref("ap")} y`;
    const caret = 7;
    const context = referenceContext(value, caret)!;
    const [namespace] = referenceSuggestions(context.query, catalog);
    expect(applySuggestion(value, caret, context, namespace!)).toEqual({
      value: `x ${ref("api.")} y`,
      caret: 9,
    });
    const full = applySuggestion(value, caret, context, {
      insert: "api.API_KEY",
      label: "API_KEY",
      detail: "",
      complete: true,
    });
    expect(full.value).toBe(`x ${ref("api.API_KEY}}")} y`);
  });
});
