import { describe, expect, it } from "vitest";
import {
  AVAILABLE_METHODS,
  cloudInitUserData,
  defaultNodeName,
  INSTALL_METHOD_STORAGE_KEY,
  isLocalOrigin,
  linuxInstallCommand,
  localNodeCommand,
  offeredMethods,
  readStoredMethod,
} from "./install-methods";

const TOKEN = "njt_0123456789abcdefABCDEF";

describe("install methods", () => {
  it.each([
    ["http://localhost:5173", true],
    ["http://127.0.0.1:8787", true],
    ["http://127.4.5.6", true],
    ["http://[::1]:8787", true],
    ["https://cp.example.com", false],
    ["http://10.0.0.5:8787", false],
    ["not a url", false],
  ])("%s is local: %s", (origin, local) => {
    expect(isLocalOrigin(origin)).toBe(local);
  });

  it("appends --builder to the one-liner only when asked", () => {
    const command = `curl -fsSL https://cp.example.com/install.sh | sudo bash -s -- --token ${TOKEN}`;
    expect(linuxInstallCommand(command, false)).toBe(command);
    expect(linuxInstallCommand(command, true)).toBe(`${command} --builder`);
  });

  it("runs the local node through the repository script", () => {
    expect(localNodeCommand(TOKEN)).toBe(`pnpm dev:node ${TOKEN}`);
  });

  it("names nodes as valid lowercase DNS labels", () => {
    expect(defaultNodeName(() => 0)).toBe("server-aaaa");
    expect(defaultNodeName()).toMatch(/^server-[a-z2-9]{4}$/);
  });

  it("builds user data for https origins and refuses plain HTTP or this machine", () => {
    const ok = cloudInitUserData({
      origin: "https://cp.example.com",
      token: TOKEN,
      name: "web-1",
      builder: true,
    });
    expect(ok.ok && ok.userData.startsWith("#cloud-config\n")).toBe(true);
    expect(ok.ok && ok.userData.includes("--builder")).toBe(true);
    for (const origin of ["http://cp.example.com", "https://localhost:8443"]) {
      expect(cloudInitUserData({ origin, token: TOKEN, name: "web-1", builder: false })).toEqual({
        ok: false,
        reason: "unreachable_origin",
      });
    }
    expect(
      cloudInitUserData({
        origin: "https://cp.example.com",
        token: TOKEN,
        name: "-bad",
        builder: false,
      }),
    ).toMatchObject({ ok: false, reason: "invalid", message: expect.stringContaining("-bad") });
  });

  it("offers the cloud provider everywhere and the local node only on this machine", () => {
    expect(AVAILABLE_METHODS).toEqual(["linux", "cloud", "cloud-init", "local"]);
    expect(offeredMethods("https://cp.example.com")).toEqual(["linux", "cloud", "cloud-init"]);
    expect(offeredMethods("http://localhost:5173")).toEqual(AVAILABLE_METHODS);
  });

  it("restores a stored method only when it is offered", () => {
    localStorage.setItem(INSTALL_METHOD_STORAGE_KEY, "cloud");
    expect(readStoredMethod(offeredMethods("https://cp.example.com"))).toBe("cloud");
    localStorage.setItem(INSTALL_METHOD_STORAGE_KEY, "local");
    expect(readStoredMethod(offeredMethods("https://cp.example.com"))).toBe("linux");
    localStorage.setItem(INSTALL_METHOD_STORAGE_KEY, "hetzner");
    expect(readStoredMethod(AVAILABLE_METHODS)).toBe("linux");
  });
});
