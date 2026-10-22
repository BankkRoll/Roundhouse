import { ToggleGroup } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/** One choice in a {@link SegmentedControl}. */
export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Accessible name when `label` is an icon. */
  ariaLabel?: string;
}

/** Props for {@link SegmentedControl}. */
export interface SegmentedControlProps<T extends string> {
  /** Accessible name of the group. */
  label: string;
  /** Selected value. */
  value: T;
  /** Called with the newly selected value. Deselecting is not allowed. */
  onValueChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  /** Extra classes. */
  className?: string;
}

/**
 * Compact single-choice toggle row, e.g. "Build | Runtime". Arrow keys move between
 * options.
 *
 * @param props - Options, value and change handler.
 * @returns The rendered control.
 */
export function SegmentedControl<T extends string>({
  label,
  value,
  onValueChange,
  options,
  className,
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroup.Root
      type="single"
      aria-label={label}
      value={value}
      onValueChange={(next) => {
        if (next) onValueChange(next as T);
      }}
      className={cn(
        "inline-flex h-7 items-center rounded-md border border-border-strong bg-surface p-0.5",
        className,
      )}
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          aria-label={option.ariaLabel}
          className="inline-flex h-full items-center gap-1 rounded-sm px-2 font-mono text-[11px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:bg-muted data-[state=on]:text-foreground [&_svg]:size-3"
        >
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
