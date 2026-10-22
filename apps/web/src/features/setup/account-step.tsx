import { Button } from "@openrail/ui";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { FormField } from "../../components/form-field";
import { errorMessage, isApiError } from "../../lib/api/client";
import { type FormErrors, MIN_PASSWORD_LENGTH } from "../../lib/validation";
import { useCompleteSetup } from "../../queries/setup";
import { type AccountFormValues, validateAccountForm } from "./validate";

/** Props for {@link AccountStep}. */
export interface AccountStepProps {
  /** Pre-fills the master key field with the key suggested in step 1. */
  initialMasterKey: string;
  /** Called with the new workspace id once setup succeeds. */
  onComplete: (workspaceId: string) => void;
  /** Called when the API reports MASTER_KEY is not configured after all. */
  onMasterKeyMissing: () => void;
}

/**
 * Step 2: master key proof, first admin account and workspace name.
 *
 * @param props - Initial key and completion callbacks.
 * @returns The form.
 */
export function AccountStep({
  initialMasterKey,
  onComplete,
  onMasterKeyMissing,
}: AccountStepProps) {
  const navigate = useNavigate();
  const complete = useCompleteSetup();
  const [values, setValues] = useState<AccountFormValues>({
    masterKey: initialMasterKey,
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
    workspaceName: "",
  });
  const [errors, setErrors] = useState<FormErrors<AccountFormValues>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const bind = (field: keyof AccountFormValues) => ({
    value: values[field],
    error: errors[field],
    onChange: (event: { target: { value: string } }) =>
      setValues((current) => ({ ...current, [field]: event.target.value })),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const found = validateAccountForm(values);
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;

    complete.mutate(
      {
        master_key: values.masterKey.trim(),
        name: values.name.trim(),
        email: values.email.trim(),
        password: values.password,
        workspace_name: values.workspaceName.trim(),
      },
      {
        onSuccess: (result) => onComplete(result.workspace_id),
        onError: (error) => {
          if (isApiError(error, "forbidden")) {
            setErrors({ masterKey: "This does not match the MASTER_KEY secret on the Worker." });
          } else if (isApiError(error, "master_key_missing")) {
            onMasterKeyMissing();
          } else if (isApiError(error, "already_setup")) {
            void navigate({ to: "/login" });
          } else {
            setFormError(errorMessage(error));
          }
        },
      },
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <FormField
        label="Master key"
        hint="Proves you control this deployment. It is sent once to verify and never stored by the dashboard."
        autoComplete="off"
        spellCheck={false}
        className="grid gap-1.5 [&_input]:font-mono [&_input]:text-xs"
        {...bind("masterKey")}
      />
      <div className="h-px bg-border" />
      <FormField label="Your name" autoComplete="name" {...bind("name")} />
      <FormField label="Email" type="email" autoComplete="email" {...bind("email")} />
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Password"
          type="password"
          autoComplete="new-password"
          hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          {...bind("password")}
        />
        <FormField
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          {...bind("confirmPassword")}
        />
      </div>
      <FormField label="Workspace name" placeholder="Acme" {...bind("workspaceName")} />
      {formError ? (
        <p role="alert" className="text-sm text-danger">
          {formError}
        </p>
      ) : null}
      <Button type="submit" variant="primary" loading={complete.isPending}>
        Create admin account
      </Button>
    </form>
  );
}
