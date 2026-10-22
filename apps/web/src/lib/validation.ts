/**
 * Client-side form checks shared by setup, invites and sign-up. The API validates the
 * same rules; these only give faster, friendlier feedback.
 *
 * @module
 */

/** Minimum password length enforced by the API. */
export const MIN_PASSWORD_LENGTH = 12;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Field-keyed validation messages; absent keys are valid. */
export type FormErrors<T> = Partial<Record<keyof T, string>>;

/** A new password and its confirmation. */
export interface PasswordFields {
  password: string;
  confirmPassword: string;
}

/**
 * Loose email check: something@something.tld, no whitespace. Surrounding whitespace is
 * ignored.
 *
 * @param value - Raw input.
 * @returns `true` when it looks like an email address.
 * @example
 * isValidEmail(" ada@example.com "); // true
 * isValidEmail("ada@example");       // false
 */
export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value.trim());
}

/**
 * Validates a new password and its confirmation.
 *
 * @param password - Chosen password.
 * @param confirm - Repeated password.
 * @returns Errors for `password` and/or `confirmPassword`.
 */
export function validatePassword(password: string, confirm: string): FormErrors<PasswordFields> {
  const errors: FormErrors<PasswordFields> = {};
  if (password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (confirm !== password) errors.confirmPassword = "Passwords do not match.";
  return errors;
}
