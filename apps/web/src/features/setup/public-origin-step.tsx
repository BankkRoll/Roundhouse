import { Button, CodeBlock } from "@roundhouse/ui";
import { RefreshCwIcon } from "lucide-react";

/** The command that sets the control plane's public URL. */
export const PUBLIC_ORIGIN_COMMAND = "npx wrangler secret put PUBLIC_ORIGIN";

/** Props for {@link PublicOriginStep}. */
export interface PublicOriginStepProps {
  /** Re-checks `GET /v1/setup`. */
  onCheckAgain: () => void;
  /** Whether a re-check is in flight. */
  checking: boolean;
  /** True after a check that still found no origin. */
  stillMissing: boolean;
}

/**
 * Explains `PUBLIC_ORIGIN`: the control plane builds every link, cookie and same-origin
 * check from it, never from the request's Host, and refuses to sign anyone in until it
 * is set.
 *
 * @param props - Re-check handler and state.
 * @returns The step.
 */
export function PublicOriginStep({ onCheckAgain, checking, stillMissing }: PublicOriginStepProps) {
  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">
        The control plane needs to know the URL people and servers use to reach it. Links, cookies
        and security checks are built from{" "}
        <span className="font-mono text-foreground">PUBLIC_ORIGIN</span>, never from whatever
        address a request claims. If this page is that address, use:
      </p>
      <CodeBlock code={window.location.origin} label="This page's origin" />
      <div className="grid gap-1.5">
        <p className="text-sm text-muted-foreground">
          From your deployment directory, run this and paste the URL when prompted:
        </p>
        <CodeBlock code={PUBLIC_ORIGIN_COMMAND} prompt />
      </div>
      <p className="text-xs text-subtle-foreground">
        Use an https:// address with no path, such as https://cp.example.com.
      </p>
      {stillMissing ? (
        <p role="alert" className="text-sm text-warning">
          Still no PUBLIC_ORIGIN. Secrets can take a few seconds to reach the Worker.
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
