import { describe, expect, it } from "vitest";
import { freeSlug, slugify } from "./slug";

describe("slugify", () => {
  it.each([
    ["Acme Corp", "acme-corp"],
    ["Acme Corp — Prod!", "acme-corp-prod"],
    ["  leading and trailing  ", "leading-and-trailing"],
    ["Café Münchën", "cafe-munchen"],
    ["UPPER_snake_Case", "upper-snake-case"],
    ["---", "workspace"],
    ["日本語", "workspace"],
    ["", "workspace"],
  ])("%j → %j", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it("uses the given fallback", () => {
    expect(slugify("!!!", 40, "service")).toBe("service");
  });

  it("truncates without leaving a trailing dash", () => {
    expect(slugify("aaaa bbbb", 5)).toBe("aaaa");
    expect(slugify("a".repeat(100))).toHaveLength(40);
  });
});

describe("freeSlug", () => {
  it("keeps a free slug and suffixes a taken or reserved one", () => {
    expect(freeSlug(new Set(), "api")).toBe("api");
    expect(freeSlug(new Set(["api", "api-2"]), "api")).toBe("api-3");
    expect(freeSlug(new Set(), "shared", ["shared"])).toBe("shared-2");
  });

  it("shortens the base so the suffix fits", () => {
    const base = "a".repeat(40);
    expect(freeSlug(new Set([base]), base)).toBe(`${"a".repeat(38)}-2`);
    expect(freeSlug(new Set(["abc-"]), "abc-", [], 4)).toBe("ab-2");
  });
});
