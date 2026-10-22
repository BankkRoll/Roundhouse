import { Input, Label } from "@openrail/ui";
import { type ComponentProps, useId } from "react";

/** Props for {@link FormField}. */
export interface FormFieldProps extends Omit<ComponentProps<"input">, "id"> {
  /** Visible label. */
  label: string;
  /** Validation error; marks the input invalid and is announced. */
  error?: string | null;
  /** Helper text under the input. */
  hint?: string;
}

/**
 * Labelled input with hint and error text wired up through `aria-describedby`.
 *
 * @param props - Input props plus label, hint and error.
 * @returns The field.
 */
export function FormField({ label, error, hint, className, ...props }: FormFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");
  return (
    <div className={className ?? "grid gap-1.5"}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...props}
      />
      {hint && !error ? (
        <p id={hintId} className="text-xs text-subtle-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
