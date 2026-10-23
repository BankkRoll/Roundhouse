import { Button, CodeBlock } from "@roundhouse/ui";
import { RefreshCwIcon } from "lucide-react";
import { MASTER_KEY_COMMAND } from "../../lib/master-key";

/** Props for {@link MasterKeyStep}. */
export interface MasterKeyStepProps {
  /** Key generated in the browser to suggest as the secret's value. */
  suggestedKey: string;
  /** Re-checks `GET /v1/setup`. */
  onCheckAgain: () => void;
  /** Whether a re-check is in flight. */
  checking: boolean;
  /** True after a check that still found no key. */
  stillMissing: boolean;
}

/**
 * Step 1: explains the MASTER_KEY secret and how to set it.
 *
 * @param props - Suggested key and re-check handler.
 * @returns The step.
 */
export function MasterKeyStep({
  suggestedKey,
  onCheckAgain,
  checking,
  stillMissing,
}: MasterKeyStepProps) {
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        The Worker encrypts secrets with a{" "}
        <span className="font-mono text-foreground">MASTER_KEY</span> it does not have yet. You will
        also paste it in the next step to prove you own this install. We generated a random 32-byte
        key in your browser; it never leaves this page unless you copy it.
      </p>
      <CodeBlock code={suggestedKey} label="Suggested key" />
      <div className="grid gap-1.5">
        <p className="text-sm text-muted-foreground">
          From your deployment directory, run this and paste the key when prompted:
        </p>
        <CodeBlock code={MASTER_KEY_COMMAND} prompt />
      </div>
      <p className="text-xs text-subtle-foreground">
        Store the key somewhere safe, such as a password manager. Losing it means losing access to
        encrypted secrets.
      </p>
      {stillMissing ? (
        <p role="alert" className="text-sm text-warning">
          Still no MASTER_KEY. Secrets can take a few seconds to reach the Worker.
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button variant="primary" onClick={onCheckAgain} loading={checking}>
          {checking ? null : <RefreshCwIcon />}
          Check again
        </Button>
      </div>
    </div>
  );
}
