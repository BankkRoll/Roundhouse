import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { copyText } from "../lib/clipboard";
import { cn } from "../lib/cn";

/** Props for {@link CodeBlock}. */
export interface CodeBlockProps {
  /** Text shown and copied verbatim. */
  code: string;
  /** Optional caption above the code, e.g. "Run on your server". */
  label?: string;
  /** Prefix a `$` prompt, for shell commands. It is never copied. */
  prompt?: boolean;
  /** Called after a successful copy. */
  onCopy?: () => void;
  /**
   * Caps the code at about 16 lines and scrolls the rest, keeping the copy button in
   * view. For long files such as cloud-init user data.
   */
  scroll?: boolean;
  /** Tighter padding, for a single short value such as an id in a settings row. */
  dense?: boolean;
  /** Extra classes for the wrapper. */
  className?: string;
}

/**
 * Mono code/command block with a copy button. Long lines wrap so commands stay readable
 * in narrow dialogs.
 *
 * @param props - The code and presentation options.
 * @returns The rendered block.
 */
export function CodeBlock({
  code,
  label,
  prompt = false,
  onCopy,
  scroll = false,
  dense = false,
  className,
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function handleCopy() {
    if (!(await copyText(code))) return;
    setCopied(true);
    onCopy?.();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className={cn("overflow-hidden rounded-md border border-border bg-background", className)}>
      {label ? (
        <div className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          {label}
        </div>
      ) : null}
      <div className={cn("flex items-start gap-2", dense ? "py-1.5 pr-1.5 pl-2.5" : "p-3")}>
        <pre
          // NOTE: A capped region must be reachable by keyboard to be scrolled (WCAG 2.1.1).
          tabIndex={scroll ? 0 : undefined}
          className={cn(
            "min-w-0 flex-1 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap text-foreground",
            scroll &&
              "max-h-64 overflow-y-auto rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {prompt ? (
            <span className="text-subtle-foreground select-none" aria-hidden="true">
              ${" "}
            </span>
          ) : null}
          <code>{code}</code>
        </pre>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? "Copied" : "Copy to clipboard"}
          className="shrink-0 rounded-sm p-1 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {copied ? (
            <CheckIcon className="size-3.5 text-success" aria-hidden="true" />
          ) : (
            <CopyIcon className="size-3.5" aria-hidden="true" />
          )}
        </button>
        <span className="sr-only" aria-live="polite">
          {copied ? "Copied to clipboard" : ""}
        </span>
      </div>
    </div>
  );
}
