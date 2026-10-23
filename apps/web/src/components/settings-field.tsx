import { Input, SettingsRow } from "@roundhouse/ui";
import { type ComponentProps, useId } from "react";

/** Props for {@link SettingsField}. */
export interface SettingsFieldProps extends Omit<ComponentProps<"input">, "id"> {
  /** The setting's name; labels the input. */
  label: string;
  /** What the setting does, beside the label. */
  description?: string;
  /** Validation error under the input; marks it invalid and is announced with it. */
  error?: string | null;
  /** A note under the input, hidden while there is an error. */
  hint?: string;
  /** Extra classes for the input, e.g. `font-mono` for hostnames and commands. */
  inputClassName?: string;
}

/**
 * A text input as a settings row: label and description on the left, the input on the
 * right, with its hint and error wired through `aria-describedby`.
 *
 * @param props - Input props plus label, description, hint and error.
 * @returns The row.
 */
export function SettingsField({
  label,
  description,
  error,
  hint,
  className,
  inputClassName,
  ...props
}: SettingsFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [
    description ? `${id}-description` : null,
    hint && !error ? hintId : null,
    error ? errorId : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <SettingsRow label={label} description={description} htmlFor={id} className={className}>
      <Input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={inputClassName}
        {...props}
      />
      {hint && !error ? (
        <p id={hintId} className="mt-1.5 text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </SettingsRow>
  );
}
