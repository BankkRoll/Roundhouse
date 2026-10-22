import { describe, expect, it } from "vitest";
import { slugify } from "./slug";

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
