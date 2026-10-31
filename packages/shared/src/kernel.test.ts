import { describe, expect, it } from "vitest";
import {
  compareKernelVersions,
  isKernelSensitiveDatabase,
  isMongoRseqAffectedKernel,
  mongoKernelRefusal,
  parseKernelRelease,
} from "./kernel";

describe("parseKernelRelease", () => {
  it.each([
    ["6.8.0-45-generic", { major: 6, minor: 8, patch: 0 }],
    ["7.0.0-14-generic", { major: 7, minor: 0, patch: 0 }],
    ["6.19.2-arch1-1", { major: 6, minor: 19, patch: 2 }],
    ["7.0.14", { major: 7, minor: 0, patch: 14 }],
    ["6.1.0-28-amd64", { major: 6, minor: 1, patch: 0 }],
    ["6.6.87.2-microsoft-standard-WSL2", { major: 6, minor: 6, patch: 87 }],
    ["6.10.14-linuxkit", { major: 6, minor: 10, patch: 14 }],
    ["5.14.0-427.13.1.el9_4.x86_64", { major: 5, minor: 14, patch: 0 }],
    ["6.19", { major: 6, minor: 19, patch: 0 }],
    ["6.19-rc3", { major: 6, minor: 19, patch: 0 }],
    ["7.0.13+deb13-amd64", { major: 7, minor: 0, patch: 13 }],
    [" 6.19.1 ", { major: 6, minor: 19, patch: 1 }],
  ])("parses %s", (release, want) => {
    expect(parseKernelRelease(release)).toEqual(want);
  });

  it.each([null, undefined, "", "6", "linux", "v6.19.0", "unknown", "6.x.0", "-6.19.0"])(
    "rejects %s",
    (release) => {
      expect(parseKernelRelease(release)).toBeNull();
    },
  );
});

describe("compareKernelVersions", () => {
  it("orders by major, then minor, then patch", () => {
    const v = (major: number, minor: number, patch: number) => ({ major, minor, patch });
    expect(compareKernelVersions(v(6, 19, 0), v(7, 0, 0))).toBeLessThan(0);
    expect(compareKernelVersions(v(6, 20, 0), v(6, 19, 9))).toBeGreaterThan(0);
    expect(compareKernelVersions(v(7, 0, 13), v(7, 0, 14))).toBeLessThan(0);
    expect(compareKernelVersions(v(7, 0, 14), v(7, 0, 14))).toBe(0);
  });
});

describe("isMongoRseqAffectedKernel", () => {
  it.each([
    "6.19.0",
    "6.19",
    "6.19-rc1",
    "6.19.2-arch1-1",
    "6.19.12-200.fc43.x86_64",
    "6.20.1",
    "7.0",
    "7.0.0-14-generic",
    "7.0.0-1004-azure",
    "7.0.13",
    "7.0.13-zen1-1-zen",
  ])("flags %s", (release) => {
    expect(isMongoRseqAffectedKernel(release)).toBe(true);
  });

  it.each([
    "6.8.0-45-generic",
    "6.1.0-28-amd64",
    "6.18.9",
    "6.18.99-lts",
    "6.10.14-linuxkit",
    "6.6.87.2-microsoft-standard-WSL2",
    "5.15.0-122-generic",
    "7.0.14",
    "7.0.14-1-generic",
    "7.0.15-arch1-1",
    "7.1.0",
    "8.0.0",
  ])("passes %s", (release) => {
    expect(isMongoRseqAffectedKernel(release)).toBe(false);
  });

  it("treats an unknown kernel as unaffected", () => {
    expect(isMongoRseqAffectedKernel(null)).toBe(false);
    expect(isMongoRseqAffectedKernel(undefined)).toBe(false);
    expect(isMongoRseqAffectedKernel("")).toBe(false);
    expect(isMongoRseqAffectedKernel("not-a-kernel")).toBe(false);
  });
});

describe("isKernelSensitiveDatabase", () => {
  it("flags MongoDB 8.0 and later", () => {
    expect(isKernelSensitiveDatabase("mongodb", "8.0")).toBe(true);
    expect(isKernelSensitiveDatabase("mongodb", "9.0")).toBe(true);
    expect(isKernelSensitiveDatabase("mongodb", "8")).toBe(true);
  });

  it("passes older MongoDB, other engines and non-databases", () => {
    expect(isKernelSensitiveDatabase("mongodb", "7.0")).toBe(false);
    expect(isKernelSensitiveDatabase("mongodb", null)).toBe(false);
    expect(isKernelSensitiveDatabase("mongodb", "latest")).toBe(false);
    expect(isKernelSensitiveDatabase("postgres", "18")).toBe(false);
    expect(isKernelSensitiveDatabase("redis", "valkey-9")).toBe(false);
    expect(isKernelSensitiveDatabase(null, null)).toBe(false);
  });
});

describe("mongoKernelRefusal", () => {
  it("names the kernel, the range and both ways out", () => {
    expect(mongoKernelRefusal("7.0.0-14-generic")).toBe(
      "MongoDB 8.0 and later cannot start on Linux kernel 7.0.0-14-generic (6.19 to 7.0.13). " +
        "Upgrade the server's kernel to 7.0.14 or later, or place the service on another server.",
    );
  });
});
