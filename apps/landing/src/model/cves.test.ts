import { describe, expect, it } from "vitest";
import {
  ADVISORIES,
  CLASS_ORDER,
  CLASSES,
  countByClass,
  SEVERITY_RANK,
  sortAdvisories,
} from "./cves";
import { DEFENCES } from "./defences";

describe("advisories", () => {
  it("have well-formed identifiers, dates and official https links", () => {
    const ids = new Set<string>();
    for (const advisory of ADVISORIES) {
      expect(advisory.id).toMatch(/^CVE-\d{4}-\d{4,}$/);
      if (advisory.ghsa) expect(advisory.ghsa).toMatch(/^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/);
      expect(advisory.published).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(advisory.url).toMatch(
        /^https:\/\/(github\.com\/[^/]+\/[^/]+\/security\/advisories\/GHSA-|nvd\.nist\.gov\/vuln\/detail\/CVE-)/,
      );
      expect(advisory.nvdUrl).toBe(`https://nvd.nist.gov/vuln/detail/${advisory.id}`);
      expect(ids.has(advisory.id)).toBe(false);
      ids.add(advisory.id);
    }
  });

  it("map every kind of flaw to defences that exist", () => {
    const known = new Set(DEFENCES.map((defence) => defence.id));
    expect(new Set(CLASS_ORDER)).toEqual(new Set(Object.keys(CLASSES)));
    for (const kind of CLASS_ORDER) {
      expect(CLASSES[kind].defences.length).toBeGreaterThan(0);
      for (const id of CLASSES[kind].defences) expect(known.has(id)).toBe(true);
    }
    expect([...countByClass(ADVISORIES).values()].reduce((a, b) => a + b, 0)).toBe(
      ADVISORIES.length,
    );
  });

  it("sort newest first, or most severe first", () => {
    const byDate = sortAdvisories(ADVISORIES, "date").map((a) => a.published);
    expect(byDate).toEqual([...byDate].sort().reverse());
    const bySeverity = sortAdvisories(ADVISORIES, "severity");
    const ranks = bySeverity.map((a) => SEVERITY_RANK[a.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(bySeverity[0]?.score).toBe(10);
  });
});
