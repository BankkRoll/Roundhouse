import { describe, expect, it } from "vitest";
import {
  isFreshSession,
  LOGIN_FAILURE_WINDOW_MS,
  LOGIN_FREE_ATTEMPTS,
  LOGIN_LOCKOUT_MAX_MS,
  loginLockedForMs,
  loginLockoutMs,
  REAUTH_WINDOW_MS,
  recordLoginFailure,
  SECURITY_ERROR_CODES,
} from "./auth-policy";

describe("loginLockoutMs", () => {
  it("allows the free attempts, then backs off exponentially up to the cap", () => {
    for (let i = 0; i < LOGIN_FREE_ATTEMPTS; i++) expect(loginLockoutMs(i)).toBe(0);
    expect(loginLockoutMs(5)).toBe(30_000);
    expect(loginLockoutMs(6)).toBe(60_000);
    expect(loginLockoutMs(7)).toBe(120_000);
    expect(loginLockoutMs(12)).toBe(LOGIN_LOCKOUT_MAX_MS);
    expect(loginLockoutMs(10_000)).toBe(LOGIN_LOCKOUT_MAX_MS);
  });
});

describe("recordLoginFailure", () => {
  it("counts failures inside the window and locks after the free attempts", () => {
    let state = null as ReturnType<typeof recordLoginFailure> | null;
    let now = 1_000_000;
    for (let i = 1; i < LOGIN_FREE_ATTEMPTS; i++) {
      state = recordLoginFailure(state, now);
      expect(state).toEqual({ failures: i, lastFailureAt: now, lockedUntil: null });
      now += 1000;
    }
    state = recordLoginFailure(state, now);
    expect(state).toEqual({ failures: 5, lastFailureAt: now, lockedUntil: now + 30_000 });
    expect(loginLockedForMs(state, now + 10_000)).toBe(20_000);
    expect(loginLockedForMs(state, now + 30_000)).toBe(0);
  });

  it("forgets failures older than the window", () => {
    const old = { failures: 9, lastFailureAt: 0, lockedUntil: 1 };
    expect(recordLoginFailure(old, LOGIN_FAILURE_WINDOW_MS + 1).failures).toBe(1);
    expect(recordLoginFailure(old, LOGIN_FAILURE_WINDOW_MS).failures).toBe(10);
  });

  it("is unlocked with no state", () => {
    expect(loginLockedForMs(null, 5)).toBe(0);
  });
});

describe("isFreshSession", () => {
  it("accepts sign-ins within the window only", () => {
    expect(isFreshSession(1000, 1000)).toBe(true);
    expect(isFreshSession(1000, 1000 + REAUTH_WINDOW_MS)).toBe(true);
    expect(isFreshSession(1000, 1001 + REAUTH_WINDOW_MS)).toBe(false);
    expect(isFreshSession(2000, 1000)).toBe(false);
  });
});

it("has unique security error codes", () => {
  expect(new Set(SECURITY_ERROR_CODES).size).toBe(SECURITY_ERROR_CODES.length);
});
