import { describe, expect, it } from "vitest";
import {
  buildUserData,
  CLOUD_INIT_USER_DATA_COPIES,
  HETZNER_USER_DATA_LIMIT,
  JOIN_SCRIPT_PATH,
  TOKEN_PATH,
  validateControlPlaneUrl,
  validateJoinToken,
  validateNodeName,
} from "../src/cloud-init";
import { ProvisionError } from "../src/errors";
import { JOIN_TOKEN } from "./fixtures";

const base = { controlPlaneUrl: "https://cp.example.com", joinToken: JOIN_TOKEN, name: "web-1" };

/** Splits the generated document into its parts without a YAML dependency. */
function parts(doc: string) {
  const lines = doc.split("\n");
  const runcmdAt = lines.indexOf("runcmd:");
  const scriptAt = lines.indexOf("    content: |");
  const script = lines
    .slice(scriptAt + 1, runcmdAt)
    .map((l) => l.slice(6))
    .join("\n");
  const tokenAt = lines.indexOf(`  - path: ${JSON.stringify(TOKEN_PATH)}`);
  const tokenEntry = lines.slice(tokenAt, tokenAt + 4);
  return {
    lines,
    runcmd: lines.slice(runcmdAt).join("\n"),
    script,
    tokenEntry,
    scriptBlock: lines.slice(scriptAt + 1, runcmdAt),
  };
}

describe("buildUserData", () => {
  const doc = buildUserData(base);
  const p = parts(doc);

  it("is a cloud-config document", () => {
    expect(doc.startsWith("#cloud-config\n")).toBe(true);
    expect(p.lines).toContain("write_files:");
  });

  it("writes the token to a root-only 0600 file and nowhere else", () => {
    expect(p.tokenEntry).toEqual([
      `  - path: "${TOKEN_PATH}"`,
      '    owner: "root:root"',
      '    permissions: "0600"',
      `    content: "${JOIN_TOKEN}\\n"`,
    ]);
    expect(doc.split(JOIN_TOKEN)).toHaveLength(2);
    expect(TOKEN_PATH.startsWith("/run/")).toBe(true);
  });

  it("keeps the token out of runcmd and the join script", () => {
    expect(p.runcmd).not.toContain(JOIN_TOKEN);
    expect(p.runcmd).not.toContain("njt_");
    expect(p.script).not.toContain(JOIN_TOKEN);
    expect(p.runcmd).toBe(`runcmd:\n  - ["/bin/bash", "${JOIN_SCRIPT_PATH}"]\n`);
  });

  it("indents the script as a literal block", () => {
    for (const line of p.scriptBlock) expect(line === "" || line.startsWith("      ")).toBe(true);
    expect(p.lines).toContain('    permissions: "0700"');
  });

  it("downloads install.sh over HTTPS only and runs it with --token-file and --name", () => {
    expect(p.script).toContain(
      `curl --proto '=https' --tlsv1.2 -fsSL --retry 5 --retry-delay 3 --retry-connrefused -o "$INSTALLER" 'https://cp.example.com/install.sh'`,
    );
    expect(p.script).toContain(
      `bash "$INSTALLER" --url 'https://cp.example.com' --token-file "$TOKEN_FILE" --name 'web-1'\n`,
    );
    expect(p.script).not.toContain("--builder");
    expect(p.script).not.toMatch(/curl[^\n]*\|\s*(sudo )?bash/);
  });

  it("passes --builder when requested", () => {
    const s = parts(buildUserData({ ...base, builder: true })).script;
    expect(s).toContain(`--name 'web-1' --builder\n`);
  });

  it("shreds the token file on every exit and scrubs cloud-init's copies before joining", () => {
    const s = p.script;
    expect(s).toContain("set -euo pipefail");
    expect(s).toContain("trap cleanup EXIT");
    expect(s).toContain(`TOKEN_FILE=${TOKEN_PATH}`);
    expect(s).toMatch(/cleanup\(\) \{\n {2}scrub "\$TOKEN_FILE"/);
    expect(s).toContain('shred -u "$1" 2>/dev/null || rm -f "$1"');
    for (const f of CLOUD_INIT_USER_DATA_COPIES) expect(s).toContain(f);
    expect(s.indexOf("/var/lib/cloud/instance/user-data.txt")).toBeLessThan(
      s.indexOf('bash "$INSTALLER"'),
    );
  });

  it("stays well under Hetzner's 32 KiB user_data limit", () => {
    expect(HETZNER_USER_DATA_LIMIT).toBe(32768);
    const longest = buildUserData({
      controlPlaneUrl: `https://${"a".repeat(63)}.${"b".repeat(63)}.example.com`,
      joinToken: "x".repeat(200),
      name: "n".repeat(63),
      builder: true,
    });
    expect(new TextEncoder().encode(longest).byteLength).toBeLessThan(HETZNER_USER_DATA_LIMIT);
  });

  it("normalises the URL to its origin", () => {
    const s = parts(
      buildUserData({ ...base, controlPlaneUrl: "https://CP.example.com:8443/" }),
    ).script;
    expect(s).toContain("'https://cp.example.com:8443/install.sh'");
  });

  it("uses plain HTTP only for loopback with the dev flag", () => {
    const s = parts(
      buildUserData({ ...base, controlPlaneUrl: "http://127.0.0.1:8787", allowLoopbackHttp: true }),
    ).script;
    expect(s).toContain("curl --proto '=http' ");
    expect(s).toContain("'http://127.0.0.1:8787/install.sh'");
    expect(() => buildUserData({ ...base, controlPlaneUrl: "http://127.0.0.1:8787" })).toThrow(
      ProvisionError,
    );
  });
});

describe("input validation", () => {
  it("accepts DNS-label node names only", () => {
    for (const ok of ["a", "web-1", "n".repeat(63), "0node"]) expect(validateNodeName(ok)).toBe(ok);
    for (const bad of [
      "",
      "-a",
      "a-",
      "Web",
      "a_b",
      "a.b",
      "n".repeat(64),
      "a b",
      "a;rm -rf /",
      "$(id)",
    ]) {
      expect(() => validateNodeName(bad), bad).toThrow(ProvisionError);
    }
  });

  it("accepts only well-formed join tokens", () => {
    expect(validateJoinToken(JOIN_TOKEN)).toBe(JOIN_TOKEN);
    for (const bad of [
      "short",
      `${JOIN_TOKEN}\n`,
      `${JOIN_TOKEN}"`,
      "a".repeat(201),
      "njt_abc def ghi jkl mno",
    ]) {
      expect(() => validateJoinToken(bad)).toThrow(ProvisionError);
    }
  });

  it("requires HTTPS origins", () => {
    expect(validateControlPlaneUrl("https://cp.example.com")).toBe("https://cp.example.com");
    const bad = [
      "http://cp.example.com",
      "ftp://cp.example.com",
      "cp.example.com",
      "https://user:pw@cp.example.com",
      "https://cp.example.com/sub",
      "https://cp.example.com/?a=1",
      "https://cp.example.com/#x",
      "http://10.0.0.1",
    ];
    for (const url of bad) {
      expect(() => validateControlPlaneUrl(url, { allowLoopbackHttp: true }), url).toThrow(
        ProvisionError,
      );
    }
  });

  it("allows loopback HTTP hosts only with the flag", () => {
    for (const url of ["http://localhost:8787", "http://127.0.0.1", "http://[::1]:8787"]) {
      expect(validateControlPlaneUrl(url, { allowLoopbackHttp: true })).toBe(new URL(url).origin);
      expect(() => validateControlPlaneUrl(url)).toThrow(ProvisionError);
    }
    expect(() =>
      validateControlPlaneUrl("http://127.evil.com", { allowLoopbackHttp: true }),
    ).toThrow(ProvisionError);
  });

  it("reports invalid_input", () => {
    const err = (() => {
      try {
        buildUserData({ ...base, name: "BAD" });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ProvisionError);
    expect((err as ProvisionError).reason).toBe("invalid_input");
  });
});
