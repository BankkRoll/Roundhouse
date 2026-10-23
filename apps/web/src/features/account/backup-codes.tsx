import { PRODUCT_NAME } from "@roundhouse/shared";
import { Button, copyText, toast } from "@roundhouse/ui";
import { CopyIcon, DownloadIcon, PrinterIcon } from "lucide-react";

/** Props for {@link BackupCodes}. */
export interface BackupCodesProps {
  /** The plain codes, shown this once. */
  codes: readonly string[];
  /** The account they belong to, written into the saved file. */
  email: string;
}

function asText(codes: readonly string[], email: string): string {
  return [
    `${PRODUCT_NAME} backup codes for ${email}`,
    "Each code signs you in once if you lose your authenticator app.",
    "",
    ...codes,
    "",
  ].join("\n");
}

/**
 * Prints the codes from a hidden frame holding only them, so the printout carries no
 * page chrome and the codes never reach the address bar or history.
 */
function printCodes(text: string) {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.position = "fixed";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  document.body.append(frame);
  const doc = frame.contentDocument;
  const view = frame.contentWindow;
  if (!doc || !view) {
    frame.remove();
    return;
  }
  const pre = doc.createElement("pre");
  pre.textContent = text;
  pre.style.font = "14px/1.6 ui-monospace, monospace";
  doc.body.append(pre);
  view.addEventListener("afterprint", () => frame.remove(), { once: true });
  view.focus();
  view.print();
}

/**
 * Backup codes as a grid of monospace codes with copy, download and print. The codes are
 * the user's only way in without their authenticator app, and the server keeps just
 * hashes, so this is the one time they can be saved.
 *
 * @param props - The codes and the account's email.
 * @returns The codes and their actions.
 */
export function BackupCodes({ codes, email }: BackupCodesProps) {
  const text = asText(codes, email);
  return (
    <div className="grid gap-3">
      <ul
        aria-label="Backup codes"
        className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-md border border-border bg-surface px-4 py-3 font-mono text-sm text-foreground"
      >
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={async () => {
            const copied = await copyText(codes.join("\n"));
            toast({
              tone: copied ? "success" : "error",
              title: copied ? "Backup codes copied" : "Couldn't copy; select them instead",
            });
          }}
        >
          <CopyIcon aria-hidden="true" />
          Copy
        </Button>
        <Button
          size="sm"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = `${PRODUCT_NAME.toLowerCase()}-backup-codes.txt`;
            link.click();
            URL.revokeObjectURL(url);
          }}
        >
          <DownloadIcon aria-hidden="true" />
          Download
        </Button>
        <Button size="sm" onClick={() => printCodes(text)}>
          <PrinterIcon aria-hidden="true" />
          Print
        </Button>
      </div>
    </div>
  );
}
