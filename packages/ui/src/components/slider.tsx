import { Slider as SliderPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/** Props for {@link Slider}. */
export interface SliderProps extends ComponentProps<typeof SliderPrimitive.Root> {
  /** Accessible name of the thumb, e.g. "CPU". */
  thumbLabel: string;
  /** Human-readable value for screen readers, e.g. "1.5 vCPU". */
  valueText?: string;
}

/**
 * Single-thumb range slider with arrow, Page and Home/End key support.
 *
 * @param props - Radix slider props plus the thumb's accessible name.
 * @returns The rendered slider.
 * @example
 * <Slider thumbLabel="Memory" min={64} max={8192} step={64} value={[512]} onValueChange={set} />
 */
export function Slider({ className, thumbLabel, valueText, ...props }: SliderProps) {
  return (
    <SliderPrimitive.Root
      className={cn(
        "relative flex h-5 w-full touch-none items-center select-none data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-1 grow overflow-hidden rounded-full bg-meter-track">
        <SliderPrimitive.Range className="absolute h-full bg-accent-text" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        aria-label={thumbLabel}
        aria-valuetext={valueText}
        className="block size-3.5 rounded-full border-2 border-accent-text bg-background shadow transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </SliderPrimitive.Root>
  );
}
