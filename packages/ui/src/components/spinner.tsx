import { cn } from "../lib/cn";

/** Props for {@link Spinner}. */
export interface SpinnerProps {
  /** Extra classes; size and color come from the parent by default. */
  className?: string;
  /** When set, the spinner is announced as a status with this label. */
  label?: string;
}

/**
 * Small indeterminate spinner. Decorative unless a `label` is given.
 *
 * @param props - Classes and optional accessible label.
 * @returns The rendered spinner.
 */
export function Spinner({ className, label }: SpinnerProps) {
  const svg = (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={cn("size-3.5 shrink-0 animate-spin", className)}
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14.5 8a6.5 6.5 0 0 0-6.5-6.5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
  if (!label) return svg;
  return (
    <span role="status" aria-label={label} className="inline-flex">
      {svg}
    </span>
  );
}
