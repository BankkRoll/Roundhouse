import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// The protocol package doesn't depend on shared; redaction lives there and
// this suite only pins its parity with the Go mirror in ./go/redact.go.
import { redact, redactionNeedles } from "../../shared/src/redaction";

interface RedactionFixture {
  cases: { secrets: string[]; line: string; needles: string[]; redacted: string }[];
}

describe("redaction parity", () => {
  it("matches fixtures/redaction.json, which the Go tests also check", () => {
    const f = JSON.parse(
      readFileSync(join(__dirname, "..", "fixtures", "redaction.json"), "utf8"),
    ) as RedactionFixture;
    expect(f.cases.length).toBeGreaterThan(0);
    for (const c of f.cases) {
      const needles = redactionNeedles(c.secrets);
      expect(needles).toEqual(c.needles);
      expect(redact(c.line, needles)).toBe(c.redacted);
    }
  });
});
