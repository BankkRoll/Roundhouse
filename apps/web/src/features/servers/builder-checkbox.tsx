import { Checkbox } from "@roundhouse/ui";
import { useId } from "react";

/** Props for {@link BuilderCheckbox}. */
export interface BuilderCheckboxProps {
  /** Whether the new server joins as a builder. */
  checked: boolean;
  /** Called with the new value. */
  onChange: (checked: boolean) => void;
  /** Overrides the hint under the label. */
  hint?: string;
}

/**
 * The "Builder node" toggle every way of adding a server shares.
 *
 * @param props - Value, change handler and optional hint.
 * @returns The checkbox with its label and hint.
 */
export function BuilderCheckbox({
  checked,
  onChange,
  hint = "Also builds images from git repositories. Give it a few spare CPU cores and disk.",
}: BuilderCheckboxProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        id={id}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-describedby={hintId}
        className="mt-0.5"
      />
      <div className="grid gap-0.5">
        <label htmlFor={id} className="cursor-pointer text-sm text-foreground">
          Builder node
        </label>
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      </div>
    </div>
  );
}
