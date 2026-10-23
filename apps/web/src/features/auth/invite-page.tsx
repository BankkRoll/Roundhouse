import { Badge, Button, Skeleton } from "@roundhouse/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { AuthLayout } from "../../components/auth-layout";
import { FormField } from "../../components/form-field";
import { errorMessage, isApiError } from "../../lib/api/client";
import type { InvitePreview } from "../../lib/api/types";
import { type FormErrors, type PasswordFields, validatePassword } from "../../lib/validation";
import { useAcceptInvite, useInvitePreview } from "../../queries/invites";
import { useMe, useSignOut } from "../../queries/me";

interface SignUpValues extends PasswordFields {
  name: string;
}

function SignUpAndAccept({
  token,
  invite,
  onJoiningChange,
}: {
  token: string;
  invite: InvitePreview;
  onJoiningChange: (joining: boolean) => void;
}) {
  const navigate = useNavigate();
  const accept = useAcceptInvite(token);
  const [values, setValues] = useState<SignUpValues>({
    name: "",
    password: "",
    confirmPassword: "",
  });
  const [errors, setErrors] = useState<FormErrors<SignUpValues>>({});

  const bind = (field: keyof SignUpValues) => ({
    value: values[field],
    error: errors[field],
    onChange: (event: { target: { value: string } }) =>
      setValues((current) => ({ ...current, [field]: event.target.value })),
  });

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const found: FormErrors<SignUpValues> = {
      ...(values.name.trim() ? {} : { name: "Enter your name." }),
      ...validatePassword(values.password, values.confirmPassword),
    };
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    // NOTE: Accepting signs the new account in and refreshes /v1/me, which would swap
    // this form for the signed-in view while navigation is still pending. The parent
    // keeps this form on screen until then.
    onJoiningChange(true);
    accept
      .mutateAsync({ name: values.name.trim(), password: values.password })
      .then(({ workspace_id }) =>
        navigate({ to: "/w/$workspaceId", params: { workspaceId: workspace_id } }),
      )
      .catch(() => onJoiningChange(false));
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4" noValidate>
      <FormField label="Email" value={invite.email} readOnly disabled />
      <FormField label="Your name" autoComplete="name" autoFocus {...bind("name")} />
      <FormField
        label="Password"
        type="password"
        autoComplete="new-password"
        hint="At least 12 characters."
        {...bind("password")}
      />
      <FormField
        label="Confirm password"
        type="password"
        autoComplete="new-password"
        {...bind("confirmPassword")}
      />
      {accept.isError ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(accept.error)}
        </p>
      ) : null}
      <Button type="submit" variant="primary" loading={accept.isPending}>
        Create account and join
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        Already have an account?{" "}
        <Link
          to="/login"
          search={{ redirect: `/invite/${token}` }}
          className="text-accent-text underline-offset-4 hover:underline"
        >
          Sign in first
        </Link>
      </p>
    </form>
  );
}

function AcceptAsCurrentUser({ token, email }: { token: string; email: string }) {
  const navigate = useNavigate();
  const accept = useAcceptInvite(token);
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        Signed in as <span className="font-mono text-foreground">{email}</span>.
      </p>
      {accept.isError ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(accept.error)}
        </p>
      ) : null}
      <Button
        variant="primary"
        loading={accept.isPending}
        onClick={() =>
          accept.mutate(
            {},
            {
              onSuccess: ({ workspace_id }) =>
                void navigate({ to: "/w/$workspaceId", params: { workspaceId: workspace_id } }),
            },
          )
        }
      >
        Accept invite
      </Button>
    </div>
  );
}

function WrongAccount({
  signedInAs,
  invitedEmail,
  signingOut,
  onSignOut,
}: {
  signedInAs: string;
  invitedEmail: string;
  signingOut: boolean;
  onSignOut: () => void;
}) {
  return (
    <div className="grid gap-4">
      <p role="alert" className="text-sm text-muted-foreground">
        You're signed in as <span className="font-mono text-foreground">{signedInAs}</span>; this
        invite is for <span className="font-mono text-foreground">{invitedEmail}</span>.
      </p>
      <Button variant="primary" loading={signingOut} onClick={onSignOut}>
        Sign out to continue
      </Button>
    </div>
  );
}

/**
 * Invite landing page. A visitor signed in as the invited address accepts with one click;
 * one signed in as someone else is asked to sign out first (the API refuses the
 * mismatch); everyone else creates an account for the invited address and joins in the
 * same step.
 *
 * @param props - Invite token from the URL.
 * @returns The page.
 */
export function InvitePage({ token }: { token: string }) {
  const preview = useInvitePreview(token);
  const me = useMe();
  // NOTE: Owned here rather than by WrongAccount so this component re-renders, and so
  // re-reads the emptied cache, once signing out succeeds.
  const signOut = useSignOut({ redirectToLogin: false });
  const [joining, setJoining] = useState(false);

  if (preview.isPending || (me.isPending && !joining)) {
    return (
      <AuthLayout title="Loading invite">
        <Skeleton className="h-32" />
      </AuthLayout>
    );
  }

  if (preview.isError) {
    const gone = isApiError(preview.error, 404);
    return (
      <AuthLayout
        title={gone ? "Invite unavailable" : "Could not load invite"}
        description={
          gone
            ? "This invite link is invalid, already used, or expired. Ask whoever invited you for a new one."
            : errorMessage(preview.error)
        }
      >
        <Button asChild variant="secondary" className="w-full">
          <Link to="/login">Go to sign in</Link>
        </Button>
      </AuthLayout>
    );
  }

  const invite = preview.data;
  const signedIn = joining ? undefined : me.data;
  let body: ReactNode;
  if (!signedIn) {
    body = <SignUpAndAccept token={token} invite={invite} onJoiningChange={setJoining} />;
  } else if (signedIn.user.email.toLowerCase() !== invite.email.toLowerCase()) {
    body = (
      <WrongAccount
        signedInAs={signedIn.user.email}
        invitedEmail={invite.email}
        signingOut={signOut.isPending}
        onSignOut={() => signOut.mutate()}
      />
    );
  } else {
    body = <AcceptAsCurrentUser token={token} email={signedIn.user.email} />;
  }

  return (
    <AuthLayout
      title={`Join ${invite.workspace_name}`}
      description={
        <span className="inline-flex flex-wrap items-center gap-1.5">
          You have been invited as <Badge>{invite.role}</Badge>
        </span>
      }
    >
      {body}
    </AuthLayout>
  );
}
