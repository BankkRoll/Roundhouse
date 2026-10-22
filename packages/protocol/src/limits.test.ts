import { describe, expect, it } from "vitest";
import {
  HOSTNAME_RE,
  IMAGE_REPOSITORY_RE,
  isSafeRelativePath,
  localImageRepository,
  MAX_LOG_LINE_BYTES,
  projectNetworkName,
  truncateLogLine,
  utf8ByteLength,
} from "./index";

const encoder = new TextEncoder();

describe("utf8ByteLength", () => {
  it.each(["", "abc", "é", "日本語", "🚀", "a🚀b", "\ud800", "x\udc00y", "\ud800\ud800"])(
    "matches TextEncoder for %j",
    (s) => {
      expect(utf8ByteLength(s)).toBe(encoder.encode(s).byteLength);
    },
  );
});

describe("truncateLogLine", () => {
  it("leaves short lines alone", () => {
    expect(truncateLogLine("hello")).toBe("hello");
    const exact = "x".repeat(MAX_LOG_LINE_BYTES);
    expect(truncateLogLine(exact)).toBe(exact);
  });

  it("cuts long lines to the byte limit", () => {
    expect(utf8ByteLength(truncateLogLine("x".repeat(MAX_LOG_LINE_BYTES + 10)))).toBe(
      MAX_LOG_LINE_BYTES,
    );
  });

  it.each([
    ["a 2-byte character", "aé", 2, "a"],
    ["a 3-byte character", "a日", 3, "a"],
    ["a surrogate pair", "a🚀", 4, "a"],
    ["a surrogate pair at the boundary", "🚀🚀", 4, "🚀"],
  ])("never splits %s", (_name, input, max, expected) => {
    expect(truncateLogLine(input, max)).toBe(expected);
  });
});

describe("isSafeRelativePath", () => {
  it.each([".", "Dockerfile", "apps/web", "docker/Dockerfile.prod", "a/./b", "..foo", "foo.."])(
    "accepts %s",
    (p) => {
      expect(isSafeRelativePath(p)).toBe(true);
    },
  );

  it.each(["", "/etc", "..", "../x", "a/../b", "a/..", "a\\b", "a b", "~/x"])("rejects %j", (p) => {
    expect(isSafeRelativePath(p)).toBe(false);
  });
});

describe("formats", () => {
  it("lowercases ids into valid local repositories", () => {
    const repo = localImageRepository("prj_01JABC", "svc_01JXYZ");
    expect(repo).toBe("127.0.0.1:5000/prj_01jabc/svc_01jxyz");
    expect(IMAGE_REPOSITORY_RE.test(repo)).toBe(true);
  });

  it("names project networks", () => {
    expect(projectNetworkName("prj_1")).toBe("openrail-prj_1");
  });

  it.each(["a.b", "api-production-x7k2.127.0.0.1.nip.io", `${"a".repeat(63)}.com`])(
    "accepts hostname %s",
    (h) => {
      expect(HOSTNAME_RE.test(h)).toBe(true);
    },
  );

  it.each(["localhost", "-a.com", "a-.com", "a..com", "A.com", "a_b.com", `${"a".repeat(64)}.com`])(
    "rejects hostname %s",
    (h) => {
      expect(HOSTNAME_RE.test(h)).toBe(false);
    },
  );
});
