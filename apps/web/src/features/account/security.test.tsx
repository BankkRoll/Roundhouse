import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { db, PASSWORD, signInAs, USERS, WORKSPACE_ID } from "../../mocks/db";
import { MOCK_BACKUP_CODES, MOCK_TOTP_CODE, MOCK_TOTP_URI } from "../../mocks/security-db";
import { expectPath, findPageHeading, renderApp } from "../../test/render";
import { manualEntryKey, normalizeCode } from "./codes";
import { describeUserAgent } from "./user-agent";

const SECURITY = `/w/${WORKSPACE_ID}/security`;

async function openPage() {
  const app = renderApp(SECURITY);
  await findPageHeading("Security");
  await screen.findByRole("heading", { name: "Two-factor authentication" });
  return app;
}

function section(name: string) {
  return screen.getByRole("region", { name });
}

function enroll(userId: string) {
  db.security.twoFactor[userId] = { backupCodes: [...MOCK_BACKUP_CODES] };
}

describe("security page", () => {
  it("is in the Account settings for everyone", async () => {
    signInAs(USERS.viewer.id);
    renderApp(`/w/${WORKSPACE_ID}/settings`);
    const nav = await screen.findByRole("navigation", { name: "Settings" });
    expect(within(nav).getByRole("link", { name: "Security" })).toHaveAttribute("href", SECURITY);
  });

  it("sets up two-factor: password, QR code drawn locally, code, backup codes", async () => {
    const { user } = await openPage();
    const twoFactor = section("Two-factor authentication");
    expect(within(twoFactor).getByText("Required")).toBeInTheDocument();
    expect(within(twoFactor).getByRole("status")).toHaveTextContent("requires two-factor");

    await user.click(within(twoFactor).getByRole("button", { name: "Set up" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Password"), "not it");
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Invalid password");

    await user.clear(within(dialog).getByLabelText("Password"));
    await user.type(within(dialog).getByLabelText("Password"), PASSWORD);
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    const qr = await within(dialog).findByRole("img", {
      name: "QR code for your authenticator app",
    });
    expect(qr.tagName.toLowerCase()).toBe("svg");
    expect(within(dialog).getByText(manualEntryKey(MOCK_TOTP_URI))).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText("Code from the app"), "000000");
    await user.click(within(dialog).getByRole("button", { name: "Turn on" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Invalid code");

    await user.clear(within(dialog).getByLabelText("Code from the app"));
    await user.type(within(dialog).getByLabelText("Code from the app"), "123 456");
    await user.click(within(dialog).getByRole("button", { name: "Turn on" }));
    const codes = await within(dialog).findByRole("list", { name: "Backup codes" });
    expect(within(codes).getAllByRole("listitem")).toHaveLength(10);
    expect(within(dialog).queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    for (const name of ["Copy", "Download", "Print"]) {
      expect(within(dialog).getByRole("button", { name })).toBeInTheDocument();
    }
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(within(dialog).getByLabelText("I've saved these codes somewhere safe"));
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await within(twoFactor).findByText("On")).toBeInTheDocument();
    expect(within(twoFactor).getByText(/10 codes left/)).toBeInTheDocument();
    expect(db.security.twoFactor[USERS.owner.id]).toBeDefined();
  });

  it("turns two-factor off only with the password and a code", async () => {
    enroll(USERS.owner.id);
    const { user } = await openPage();
    const twoFactor = section("Two-factor authentication");
    await user.click(await within(twoFactor).findByRole("button", { name: "Turn off" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Your role requires two-factor authentication");
    await user.type(within(dialog).getByLabelText("Password"), PASSWORD);
    await user.type(within(dialog).getByLabelText("Code"), "999999");
    await user.click(within(dialog).getByRole("button", { name: "Turn off" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Invalid code");
    await user.clear(within(dialog).getByLabelText("Code"));
    await user.type(within(dialog).getByLabelText("Code"), MOCK_TOTP_CODE);
    await user.click(within(dialog).getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(db.security.twoFactor[USERS.owner.id]).toBeUndefined());
    expect(await within(twoFactor).findByText("Required")).toBeInTheDocument();
  });

  it("replaces backup codes and shows the new ones once", async () => {
    enroll(USERS.owner.id);
    const { user } = await openPage();
    const twoFactor = section("Two-factor authentication");
    await user.click(await within(twoFactor).findByRole("button", { name: "Generate new codes" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Password"), PASSWORD);
    await user.type(within(dialog).getByLabelText("Code"), MOCK_BACKUP_CODES[2]!);
    await user.click(within(dialog).getByRole("button", { name: "Generate codes" }));
    const codes = await within(dialog).findByRole("list", { name: "Backup codes" });
    expect(within(codes).queryByText(MOCK_BACKUP_CODES[0]!)).not.toBeInTheDocument();
    expect(within(codes).getAllByRole("listitem")).toHaveLength(10);
    await user.click(within(dialog).getByLabelText("I've saved these codes somewhere safe"));
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("warns when few backup codes are left", async () => {
    db.security.twoFactor[USERS.owner.id] = { backupCodes: MOCK_BACKUP_CODES.slice(0, 1) };
    await openPage();
    expect(await screen.findByText(/1 code left/)).toHaveClass("text-warning");
  });

  it("lists sessions and signs other devices out", async () => {
    const { user } = await openPage();
    const sessions = section("Sessions");
    expect(await within(sessions).findByText("This device")).toBeInTheDocument();
    expect(within(sessions).getByText("Chrome on Windows")).toBeInTheDocument();
    expect(within(sessions).getByText(/198\.51\.100\.23/)).toBeInTheDocument();

    await user.click(within(sessions).getByRole("button", { name: "Sign out Chrome on Windows" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(within(sessions).queryByText("Chrome on Windows")).toBeNull());
    expect(db.security.otherSessions).toEqual([]);
    expect(
      within(sessions).queryByRole("button", { name: "Sign out other sessions" }),
    ).not.toBeInTheDocument();
  });

  it("signs out every other session at once", async () => {
    db.security.otherSessions.push({
      ...db.security.otherSessions[0]!,
      id: "ses_phone",
      user_agent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Safari/604.1",
    });
    const { user } = await openPage();
    const sessions = section("Sessions");
    await within(sessions).findByText("Safari on iOS");
    await user.click(within(sessions).getByRole("button", { name: "Sign out other sessions" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Sign out others" }));
    expect(await screen.findByText("2 sessions signed out")).toBeInTheDocument();
  });
});

describe("two-factor banner", () => {
  it("tells an unenrolled admin where to set it up, except on the security page", async () => {
    const { router, user } = renderApp(`/w/${WORKSPACE_ID}`);
    await user.click(await screen.findByRole("link", { name: "Set up two-factor" }));
    await expectPath(router, SECURITY);
    await findPageHeading("Security");
    expect(screen.queryByRole("link", { name: "Set up two-factor" })).not.toBeInTheDocument();
  });

  it("stays away from members and enrolled admins", async () => {
    signInAs(USERS.member.id);
    renderApp(`/w/${WORKSPACE_ID}`);
    await findPageHeading("Home");
    expect(screen.queryByRole("link", { name: "Set up two-factor" })).not.toBeInTheDocument();
  });
});

describe("helpers", () => {
  it.each([
    [null, "Unknown device"],
    ["roundhouse-cli/0.4.0 (linux; amd64)", "Roundhouse CLI"],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
      "Safari on macOS",
    ],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0", "Firefox on Linux"],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 Edg/131.0",
      "Edge on Windows",
    ],
    ["curl/8.5.0", "Unknown device"],
  ])("describes %j as %s", (agent, expected) => {
    expect(describeUserAgent(agent)).toBe(expected);
  });

  it("groups the manual key and strips spaces from codes", () => {
    expect(manualEntryKey("otpauth://totp/x?secret=ABCDEFGHIJ")).toBe("ABCD EFGH IJ");
    expect(manualEntryKey("not a uri")).toBe("");
    expect(normalizeCode(" 123 456\n")).toBe("123456");
  });
});
