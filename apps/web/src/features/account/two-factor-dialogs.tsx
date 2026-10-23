/**
 * The dialogs that change two-factor authentication:
 *
 * - {@link TwoFactorSetupDialog}: password → scan the QR code (drawn locally) or type the
 *   key → confirm with a code → save the backup codes.
 * - {@link TwoFactorChangeDialog}: turn two-factor off, or replace the backup codes; both
 *   need the password and a current code, so a stolen session alone can't weaken the
 *   account.
 *
 * SECURITY: The TOTP URI, the key and the backup codes live only in this component's
 * state and disappear when the dialog closes.
 *
 * @module
 */
import {
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
} from "@roundhouse/ui";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { FormField } from "../../components/form-field";
import { errorMessage } from "../../lib/api/client";
import {
  useConfirmTwoFactor,
  useDisableTwoFactor,
  useEnableTwoFactor,
  useRegenerateBackupCodes,
} from "../../queries/security";
import { BackupCodes } from "./backup-codes";
import { manualEntryKey, normalizeCode } from "./codes";
import { QrCode } from "./qr-code";

function CodeField({
  value,
  onChange,
  label = "Code",
  hint,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  hint?: string;
  autoFocus?: boolean;
}) {
  return (
    <FormField
      label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      autoComplete="one-time-code"
      inputMode="text"
      spellCheck={false}
      autoCapitalize="off"
      inputClassName="font-mono tracking-wider"
      hint={hint}
      autoFocus={autoFocus}
    />
  );
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-danger">
      {children}
    </p>
  );
}

// -----------------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------------

/** Props for {@link TwoFactorSetupDialog}. */
export interface TwoFactorSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The account's email, for the saved backup codes. */
  email: string;
  /** Runs once two-factor is on and the codes were acknowledged. */
  onDone?: () => void;
}

type SetupStep =
  | { name: "password" }
  | { name: "scan"; uri: string; codes: string[] }
  | { name: "codes"; codes: string[] };

/**
 * Turns on two-factor authentication.
 *
 * @param props - Open state, the account's email and a completion callback.
 * @returns The dialog.
 */
export function TwoFactorSetupDialog({
  open,
  onOpenChange,
  email,
  onDone,
}: TwoFactorSetupDialogProps) {
  const [step, setStep] = useState<SetupStep>({ name: "password" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState(false);
  const enable = useEnableTwoFactor();
  const confirm = useConfirmTwoFactor();
  const savedId = useId();

  function reset() {
    setStep({ name: "password" });
    setPassword("");
    setCode("");
    setSaved(false);
    enable.reset();
    confirm.reset();
  }

  async function onPassword(event: FormEvent) {
    event.preventDefault();
    if (!password) return;
    try {
      const enrollment = await enable.mutateAsync(password);
      setPassword("");
      setStep({ name: "scan", uri: enrollment.totpURI, codes: enrollment.backupCodes });
    } catch {
      // Shown from the mutation's error below.
    }
  }

  async function onCode(event: FormEvent) {
    event.preventDefault();
    if (step.name !== "scan" || !normalizeCode(code)) return;
    try {
      await confirm.mutateAsync(normalizeCode(code));
      setStep({ name: "codes", codes: step.codes });
    } catch {
      // Shown from the mutation's error below.
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing before the codes were acknowledged would lose them for good.
        if (!next && step.name === "codes" && !saved) return;
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="max-w-md" hideClose={step.name === "codes"}>
        {step.name === "password" ? (
          <form onSubmit={onPassword} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Set up two-factor authentication</DialogTitle>
              <DialogDescription>
                After your password, signing in will ask for a code from an authenticator app such
                as 1Password, Google Authenticator or Authy. Confirm your password to start.
              </DialogDescription>
            </DialogHeader>
            <FormField
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
            />
            {enable.isError ? <ErrorLine>{errorMessage(enable.error)}</ErrorLine> : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="secondary">Cancel</Button>
              </DialogClose>
              <Button type="submit" variant="primary" loading={enable.isPending}>
                Continue
              </Button>
            </DialogFooter>
          </form>
        ) : step.name === "scan" ? (
          <form onSubmit={onCode} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Scan the QR code</DialogTitle>
              <DialogDescription>
                Scan it with your authenticator app, then enter the 6-digit code the app shows.
              </DialogDescription>
            </DialogHeader>
            <div className="flex justify-center">
              <QrCode value={step.uri} label="QR code for your authenticator app" />
            </div>
            <div className="grid gap-1 text-sm">
              <p className="text-muted-foreground">Can't scan it? Enter this key instead:</p>
              <p className="select-all break-all font-mono text-foreground">
                {manualEntryKey(step.uri)}
              </p>
            </div>
            <CodeField value={code} onChange={setCode} label="Code from the app" autoFocus />
            {confirm.isError ? <ErrorLine>{errorMessage(confirm.error)}</ErrorLine> : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="secondary">Cancel</Button>
              </DialogClose>
              <Button type="submit" variant="primary" loading={confirm.isPending}>
                Turn on
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Save your backup codes</DialogTitle>
              <DialogDescription>
                Two-factor authentication is on. If you lose your phone, each of these codes signs
                you in once. They won't be shown again.
              </DialogDescription>
            </DialogHeader>
            <BackupCodes codes={step.codes} email={email} />
            <div className="flex items-center gap-2">
              <Checkbox
                id={savedId}
                checked={saved}
                onChange={(event) => setSaved(event.target.checked)}
              />
              <Label htmlFor={savedId}>I've saved these codes somewhere safe</Label>
            </div>
            <DialogFooter>
              <Button
                variant="primary"
                disabled={!saved}
                onClick={() => {
                  onOpenChange(false);
                  reset();
                  onDone?.();
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// -----------------------------------------------------------------------------
// Turning off and new backup codes
// -----------------------------------------------------------------------------

/** Props for {@link TwoFactorChangeDialog}. */
export interface TwoFactorChangeDialogProps {
  /** `disable` turns two-factor off; `regenerate` replaces the backup codes. */
  mode: "disable" | "regenerate" | null;
  onClose: () => void;
  /** The account's email, for the saved backup codes. */
  email: string;
  /** Two-factor is required for this account, so turning it off blocks changes. */
  required: boolean;
}

/**
 * Turns two-factor off or replaces the backup codes, after the password and a current
 * code.
 *
 * @param props - Mode, close callback, email and whether 2FA is required.
 * @returns The dialog.
 */
export function TwoFactorChangeDialog({
  mode,
  onClose,
  email,
  required,
}: TwoFactorChangeDialogProps) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const disable = useDisableTwoFactor();
  const regenerate = useRegenerateBackupCodes();
  const mutation = mode === "disable" ? disable : regenerate;
  const savedId = useId();

  function close() {
    setPassword("");
    setCode("");
    setCodes(null);
    setSaved(false);
    disable.reset();
    regenerate.reset();
    onClose();
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!password || !normalizeCode(code)) return;
    const input = { password, code: normalizeCode(code) };
    try {
      if (mode === "disable") {
        await disable.mutateAsync(input);
        close();
      } else {
        const result = await regenerate.mutateAsync(input);
        setPassword("");
        setCode("");
        setCodes(result.backupCodes);
      }
    } catch {
      // Shown from the mutation's error below.
    }
  }

  return (
    <Dialog
      open={mode !== null}
      onOpenChange={(next) => {
        if (!next && codes && !saved) return;
        if (!next) close();
      }}
    >
      <DialogContent className="max-w-md" hideClose={codes !== null}>
        {codes ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Your new backup codes</DialogTitle>
              <DialogDescription>
                Your old codes no longer work. Each of these signs you in once; they won't be shown
                again.
              </DialogDescription>
            </DialogHeader>
            <BackupCodes codes={codes} email={email} />
            <div className="flex items-center gap-2">
              <Checkbox
                id={savedId}
                checked={saved}
                onChange={(event) => setSaved(event.target.checked)}
              />
              <Label htmlFor={savedId}>I've saved these codes somewhere safe</Label>
            </div>
            <DialogFooter>
              <Button variant="primary" disabled={!saved} onClick={close}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>
                {mode === "disable"
                  ? "Turn off two-factor authentication?"
                  : "Generate new backup codes?"}
              </DialogTitle>
              <DialogDescription>
                {mode === "disable"
                  ? required
                    ? "Your role requires two-factor authentication: until you turn it on again you can look around but not change anything."
                    : "Signing in will only ask for your password."
                  : "Your current backup codes stop working."}{" "}
                Confirm with your password and a code from your app or a backup code.
              </DialogDescription>
            </DialogHeader>
            <FormField
              label="Password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
            />
            <CodeField
              value={code}
              onChange={setCode}
              hint="6 digits from the app, or a backup code"
            />
            {mutation.isError ? <ErrorLine>{errorMessage(mutation.error)}</ErrorLine> : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="secondary">Cancel</Button>
              </DialogClose>
              <Button
                type="submit"
                variant={mode === "disable" ? "danger" : "primary"}
                loading={mutation.isPending}
              >
                {mode === "disable" ? "Turn off" : "Generate codes"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
