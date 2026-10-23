import { Button } from "@roundhouse/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { AuthLayout } from "../../components/auth-layout";
import { FormField } from "../../components/form-field";
import { api, errorMessage, isApiError } from "../../lib/api/client";
import { securityApi } from "../../lib/api/security-client";
import { MASTER_KEY_COMMAND } from "../../lib/master-key";
import { queryKeys } from "../../queries/keys";
import { normalizeCode } from "../account/codes";

/**
 * Turns a failed sign-in into something the person can act on. Only a 401 means the
 * credentials were wrong; a locked account, rate limits, a missing MASTER_KEY or
 * PUBLIC_ORIGIN and blocked requests each need a different next step.
 *
 * @param error - Whatever `api.signIn` threw.
 * @returns A user-facing message.
 */
export function signInErrorMessage(error: unknown): string {
  if (!isApiError(error)) return errorMessage(error);
  if (error.status === 0) return error.message;
  if (error.code === "account_locked") {
    return `${error.message} Signing in is paused after repeated failed attempts; an instance admin can lift it sooner.`;
  }
  if (error.status === 401) return "Invalid email or password.";
  if (error.status === 429) return "Too many attempts, try again in a minute.";
  if (error.code === "master_key_missing") {
    return `This install has no MASTER_KEY yet, so nobody can sign in. Set it with \`${MASTER_KEY_COMMAND}\`, then try again.`;
  }
  if (error.code === "public_origin_missing") return error.message;
  if (error.status === 403) {
    return "The server refused this sign-in request. Reload the page and try again.";
  }
  return errorMessage(error, "Could not sign in. Try again in a moment.");
}

/** Whether a second-factor failure means the sign-in itself must start over. */
function challengeExpired(error: unknown): boolean {
  return (
    isApiError(error, "invalid_two_factor_cookie") ||
    isApiError(error, "too_many_attempts_request_new_code")
  );
}

/**
 * Turns a failed second-factor check into a message.
 *
 * @param error - Whatever the verification threw.
 * @param backup - Whether a backup code was entered.
 * @returns A user-facing message.
 */
export function secondFactorErrorMessage(error: unknown, backup: boolean): string {
  if (!isApiError(error)) return errorMessage(error);
  if (error.code === "account_locked" || error.status === 429) return signInErrorMessage(error);
  if (challengeExpired(error)) return "This sign-in expired. Enter your password again.";
  if (error.status === 401) {
    return backup
      ? "That backup code didn't work. Each code works only once."
      : "That code didn't work. Codes change every 30 seconds; check that your phone's clock is right.";
  }
  return errorMessage(error, "Could not check the code. Try again in a moment.");
}

/**
 * Email and password sign-in, followed by an authenticator or backup code when the
 * account has two-factor authentication.
 *
 * @param props - Same-origin path to continue to after signing in (already validated).
 * @returns The page.
 */
export function LoginPage({ redirectTo }: { redirectTo: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<"password" | "code">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function finish() {
    queryClient.removeQueries({ queryKey: queryKeys.me });
    await navigate({ href: redirectTo });
  }

  async function onPassword(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await api.signIn({ email: email.trim(), password });
      setPassword("");
      if (result?.twoFactorRedirect) {
        setStep("code");
        setPending(false);
        return;
      }
    } catch (cause) {
      setError(signInErrorMessage(cause));
      setPending(false);
      return;
    }
    await finish();
    setPending(false);
  }

  async function onCode(event: FormEvent) {
    event.preventDefault();
    const entered = normalizeCode(code);
    if (!entered) {
      setError(backup ? "Enter one of your backup codes." : "Enter the code from your app.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      if (backup) await securityApi.verifyBackupCode(entered);
      else await securityApi.verifyTotp(entered);
    } catch (cause) {
      setError(secondFactorErrorMessage(cause, backup));
      setCode("");
      if (challengeExpired(cause)) setStep("password");
      setPending(false);
      return;
    }
    await finish();
    setPending(false);
  }

  if (step === "code") {
    return (
      <AuthLayout
        title="Two-factor authentication"
        description={
          backup
            ? "Enter one of the backup codes you saved when you set up two-factor authentication."
            : "Enter the 6-digit code from your authenticator app."
        }
      >
        <form onSubmit={onCode} className="grid gap-4" noValidate>
          <FormField
            key={backup ? "backup" : "totp"}
            label={backup ? "Backup code" : "Authentication code"}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            autoComplete="one-time-code"
            inputMode={backup ? "text" : "numeric"}
            spellCheck={false}
            autoCapitalize="off"
            inputClassName="font-mono tracking-wider"
            autoFocus
          />
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" loading={pending}>
            Verify
          </Button>
          <div className="flex flex-wrap justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setBackup((value) => !value);
                setCode("");
                setError(null);
              }}
            >
              {backup ? "Use your authenticator app" : "Use a backup code"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setStep("password");
                setCode("");
                setBackup(false);
                setError(null);
              }}
            >
              Start over
            </Button>
          </div>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Sign in"
      description="Use the account you created during setup or from an invite."
    >
      <form onSubmit={onPassword} className="grid gap-4" noValidate>
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
