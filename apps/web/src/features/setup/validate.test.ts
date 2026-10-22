import { describe, expect, it } from "vitest";
import { isValidEmail, validatePassword } from "../../lib/validation";
import { type AccountFormValues, validateAccountForm } from "./validate";

const valid: AccountFormValues = {
  masterKey: "abc",
  name: "Ada",
  email: "ada@example.com",
  password: "correct-horse-battery",
  confirmPassword: "correct-horse-battery",
  workspaceName: "Acme",
};

describe("validatePassword", () => {
  it("accepts exactly 12 characters", () => {
    expect(validatePassword("a".repeat(12), "a".repeat(12))).toEqual({});
  });

  it("rejects 11 characters", () => {
    expect(validatePassword("a".repeat(11), "a".repeat(11)).password).toMatch(/12/);
  });

  it("requires the confirmation to match", () => {
    expect(validatePassword("a".repeat(12), "b".repeat(12))).toEqual({
      confirmPassword: "Passwords do not match.",
    });
  });
});

describe("isValidEmail", () => {
  it("accepts addresses with surrounding whitespace", () => {
    expect(isValidEmail("  ada@example.com ")).toBe(true);
  });

  it.each(["", "ada", "ada@example", "a da@example.com"])("rejects %j", (email) => {
    expect(isValidEmail(email)).toBe(false);
  });
});

describe("validateAccountForm", () => {
  it("passes a complete form", () => {
    expect(validateAccountForm(valid)).toEqual({});
  });

  it("flags every empty field", () => {
    const errors = validateAccountForm({
      masterKey: " ",
      name: " ",
      email: "",
      password: "",
      confirmPassword: "",
      workspaceName: "",
    });
    expect(Object.keys(errors).sort()).toEqual([
      "email",
      "masterKey",
      "name",
      "password",
      "workspaceName",
    ]);
  });

  it.each(["ada", "ada@", "@example.com", "ada@example", "a da@example.com"])(
    "rejects email %j",
    (email) => {
      expect(validateAccountForm({ ...valid, email }).email).toBeDefined();
    },
  );

  it("trims the email before checking it", () => {
    expect(validateAccountForm({ ...valid, email: "  ada@example.com " })).toEqual({});
  });
});
