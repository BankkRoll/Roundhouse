import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@roundhouse/ui";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { FormField } from "../../components/form-field";
import { errorMessage, isApiError, setReauthHandler } from "../../lib/api/client";
import { securityApi } from "../../lib/api/security-client";

/**
 * Confirms the user's password when the API refuses a dangerous action because the
 * session isn't fresh (ADR 0014 "Fresh sessions"). Mounted once at the root: it
 * registers itself with the API client, which retries the refused request once the
 * password (and a second-factor code, when the account has one) is confirmed.
 *
 * @returns The dialog, closed until the API asks for it.
 */
export function ReauthDialog() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const settle = useRef<((confirmed: boolean) => void) | null>(null);

  useEffect(
    () =>
      setReauthHandler(
        () =>
          new Promise<boolean>((resolve) => {
            settle.current = resolve;
            setPassword("");
            setCode("");
            setNeedsCode(false);
            setError(null);
            setOpen(true);
          }),
      ),
    [],
  );

  function finish(confirmed: boolean) {
    setOpen(false);
    setPassword("");
    setCode("");
    settle.current?.(confirmed);
    settle.current = null;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!password) {
      setError("Enter your password.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await securityApi.reauthenticate(password, needsCode ? code.trim() : undefined);
      finish(true);
    } catch (cause) {
      if (isApiError(cause) && cause.details.some((d) => d.field === "code")) {
        setNeedsCode(true);
        setError(needsCode ? errorMessage(cause) : null);
      } else {
        setError(errorMessage(cause, "Could not confirm your password."));
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : finish(false))}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Confirm it's you</DialogTitle>
          <DialogDescription>
            This change needs a recent sign-in. Enter your password to continue; you won't be asked
            again for 10 minutes.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void onSubmit(event)} noValidate className="grid gap-4">
          <FormField
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            error={needsCode ? null : error}
            autoFocus
          />
          {needsCode ? (
            <FormField
              label="Authentication code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              hint="From your authenticator app, or a backup code."
              error={error}
            />
          ) : null}
          <DialogFooter>
            <Button variant="secondary" onClick={() => finish(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              Confirm
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
