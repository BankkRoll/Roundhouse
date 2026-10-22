import { Button } from "@openrail/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { AuthLayout } from "../../components/auth-layout";
import { FormField } from "../../components/form-field";
import { api, errorMessage, isApiError } from "../../lib/api/client";
import { MASTER_KEY_COMMAND } from "../../lib/master-key";
import { queryKeys } from "../../queries/keys";

/**
 * Turns a failed sign-in into something the person can act on. Only a 401 means the
 * credentials were wrong; rate limits, a missing MASTER_KEY and blocked requests each
 * need a different next step.
 *
 * @param error - Whatever `api.signIn` threw.
 * @returns A user-facing message.
 */
export function signInErrorMessage(error: unknown): string {
  if (!isApiError(error)) return errorMessage(error);
  if (error.status === 0) return error.message;
  if (error.status === 401) return "Invalid email or password.";
  if (error.status === 429) return "Too many attempts, try again in a minute.";
  if (error.code === "master_key_missing") {
    return `This install has no MASTER_KEY yet, so nobody can sign in. Set it with \`${MASTER_KEY_COMMAND}\`, then try again.`;
  }
  if (error.status === 403) {
    return "The server refused this sign-in request. Reload the page and try again.";
  }
  return errorMessage(error, "Could not sign in. Try again in a moment.");
}

/**
 * Email and password sign-in.
 *
 * @param props - Same-origin path to continue to after signing in (already validated).
 * @returns The page.
 */
export function LoginPage({ redirectTo }: { redirectTo: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.signIn({ email: email.trim(), password });
    } catch (cause) {
      setError(signInErrorMessage(cause));
      setPending(false);
      return;
    }
    queryClient.removeQueries({ queryKey: queryKeys.me });
    await navigate({ href: redirectTo });
    setPending(false);
  }

  return (
    <AuthLayout
      title="Sign in"
      description="Use the account you created during setup or from an invite."
    >
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        <FormField
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoFocus
        />
        <FormField
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="primary" loading={pending}>
          Sign in
        </Button>
      </form>
    </AuthLayout>
  );
}
