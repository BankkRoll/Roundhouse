import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { forgetInviteToken, type InviteTokenEnv, takeInviteToken } from "./invite-token";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    size: () => map.size,
  };
}

function env(hash: string, storage: InviteTokenEnv["storage"] = memoryStorage()): InviteTokenEnv {
  return { hash, dropHash: vi.fn(), storage };
}

describe("invite token", () => {
  it("reads the fragment, drops it from the address bar, and remembers it for the tab", () => {
    const storage = memoryStorage();
    const first = env("#token=inv_abc", storage);
    expect(takeInviteToken(first)).toBe("inv_abc");
    expect(first.dropHash).toHaveBeenCalledTimes(1);

    const reload = env("", storage);
    expect(takeInviteToken(reload)).toBe("inv_abc");
    expect(reload.dropHash).not.toHaveBeenCalled();

    forgetInviteToken(storage);
    expect(takeInviteToken(env("", storage))).toBeNull();
  });

  it("accepts the fragment with or without its #, and ignores other fragments", () => {
    expect(takeInviteToken(env("token=inv_x"))).toBe("inv_x");
    const other = env("#section");
    expect(takeInviteToken(other)).toBeNull();
    expect(other.dropHash).not.toHaveBeenCalled();
  });

  it("still works once when storage is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(takeInviteToken(env("#token=inv_y", blocked))).toBe("inv_y");
    expect(takeInviteToken(env("", blocked))).toBeNull();
    expect(() => forgetInviteToken(blocked)).not.toThrow();
    expect(takeInviteToken(env("#token=inv_z", null))).toBe("inv_z");
  });

  it("is served with no referrer, so the page never leaks its URL", () => {
    const headers = readFileSync(resolve(import.meta.dirname, "../../../public/_headers"), "utf8");
    const all = headers.split(/\n(?=\S)/).find((block) => block.startsWith("/*"));
    expect(all).toMatch(/^\s+Referrer-Policy: no-referrer$/m);
  });
});
