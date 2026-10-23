import { Button } from "@roundhouse/ui";
import { ShieldCheckIcon } from "lucide-react";
import { useState } from "react";
import { useMe } from "../../queries/me";
import { TwoFactorSetupDialog } from "../account/two-factor-dialogs";

/** Props for {@link TwoFactorStep}. */
export interface TwoFactorStepProps {
  /** Runs once two-factor authentication is on. */
  onDone: () => void;
}

/**
 * Step 3: the admin turns on two-factor authentication. Instance admins can't change
 * anything until they do, adding the first server included.
 *
 * @param props - Completion callback.
 * @returns The step.
 */
export function TwoFactorStep({ onDone }: TwoFactorStepProps) {
  const [open, setOpen] = useState(false);
  const { data: me } = useMe();
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        This account controls every server and secret of the install, so it needs a second factor: a
        code from an authenticator app such as 1Password, Google Authenticator or Authy, asked for
        after your password. You'll also get backup codes in case you lose your phone.
      </p>
      <div className="flex justify-end">
        <Button variant="primary" onClick={() => setOpen(true)}>
          <ShieldCheckIcon />
          Set up two-factor
        </Button>
      </div>
      <TwoFactorSetupDialog
        open={open}
        onOpenChange={setOpen}
        email={me?.user.email ?? ""}
        onDone={onDone}
      />
    </div>
  );
}
