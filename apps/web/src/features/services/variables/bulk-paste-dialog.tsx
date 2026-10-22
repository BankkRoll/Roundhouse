import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Textarea,
} from "@openrail/ui";
import { Switch } from "@openrail/ui/controls";
import { useId, useMemo, useState } from "react";
import { type DotenvEntry, parseDotenv } from "./dotenv";

/** Props for {@link BulkPasteDialog}. */
export interface BulkPasteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Keys that already exist, to show which entries overwrite. */
  existingKeys: ReadonlySet<string>;
  /** Stages the parsed entries. */
  onApply: (entries: DotenvEntry[], secret: boolean) => void;
}

/**
 * Paste a `.env` file to stage many variables at once. Shows what will be added or
 * overwritten and every line that couldn't be parsed before anything is staged.
 *
 * @param props - Open state, existing keys and the apply callback.
 * @returns The dialog.
 */
export function BulkPasteDialog({
  open,
  onOpenChange,
  existingKeys,
  onApply,
}: BulkPasteDialogProps) {
  const [text, setText] = useState("");
  const [secret, setSecret] = useState(false);
  const textId = useId();
  const secretId = useId();
  const parsed = useMemo(() => parseDotenv(text), [text]);
  const overwrites = parsed.entries.filter((entry) => existingKeys.has(entry.key)).length;

  function close(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setText("");
      setSecret(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Paste .env</DialogTitle>
          <DialogDescription>
            Each KEY=value line is staged. Nothing is saved until you press Save.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor={textId}>.env contents</Label>
          <Textarea
            id={textId}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={"DATABASE_URL=postgres://…\nLOG_LEVEL=info\n# comments are ignored"}
            className="min-h-48"
            spellCheck={false}
            autoFocus
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch id={secretId} checked={secret} onCheckedChange={setSecret} />
          <Label htmlFor={secretId}>Mark all as secret</Label>
        </div>
        <div className="grid gap-1 text-xs" aria-live="polite">
          <p className="text-muted-foreground">
            {parsed.entries.length} {parsed.entries.length === 1 ? "variable" : "variables"}
            {overwrites > 0 ? ` · ${overwrites} will overwrite existing values` : ""}
          </p>
          {parsed.errors.length > 0 ? (
            <ul className="grid gap-0.5 text-danger">
              {parsed.errors.slice(0, 5).map((error) => (
                <li key={error.line}>
                  Line {error.line}: {error.message}
                </li>
              ))}
              {parsed.errors.length > 5 ? <li>…and {parsed.errors.length - 5} more</li> : null}
            </ul>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={parsed.entries.length === 0 || parsed.errors.length > 0}
            onClick={() => {
              onApply(parsed.entries, secret);
              close(false);
            }}
          >
            Stage {parsed.entries.length || ""}{" "}
            {parsed.entries.length === 1 ? "variable" : "variables"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
