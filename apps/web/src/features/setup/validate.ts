import { type FormErrors, isValidEmail, validatePassword } from "../../lib/validation";

/** Values collected by the admin account step. */
export interface AccountFormValues {
  masterKey: string;
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
  workspaceName: string;
}

/**
 * Validates the setup wizard's account step.
 *
 * @param values - Form values.
 * @returns Errors keyed by field; empty when the form can be submitted.
 */
export function validateAccountForm(values: AccountFormValues): FormErrors<AccountFormValues> {
  const errors: FormErrors<AccountFormValues> = {};
  if (!values.masterKey.trim()) errors.masterKey = "Paste the MASTER_KEY you stored on the Worker.";
  if (!values.name.trim()) errors.name = "Enter your name.";
  if (!isValidEmail(values.email)) errors.email = "Enter a valid email address.";
  if (!values.workspaceName.trim()) errors.workspaceName = "Name your workspace.";
  return { ...errors, ...validatePassword(values.password, values.confirmPassword) };
}
