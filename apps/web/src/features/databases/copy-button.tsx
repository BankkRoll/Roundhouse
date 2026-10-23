import { Button, copyText, toast } from "@roundhouse/ui";
import { CopyIcon } from "lucide-react";

/** Props for {@link CopyButton}. */
export interface CopyButtonProps {
  /** Text put on the clipboard. */
  value: string;
  /** What it is, for the button's name and the toast, e.g. "DATABASE_URL reference". */
  label: string;
}

/**
 * An icon button that copies a value and confirms with a toast.
 *
 * @param props - Value and label.
 * @returns The button.
 */
export function CopyButton({ value, label }: CopyButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Copy ${label}`}
      onClick={() =>
        void copyText(value).then((ok) =>
          toast({
            title: ok ? `${label} copied` : "Could not copy",
            tone: ok ? "success" : "error",
          }),
        )
      }
    >
      <CopyIcon />
    </Button>
  );
}
