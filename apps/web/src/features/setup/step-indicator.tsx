import { cn } from "@openrail/ui";
import { CheckIcon } from "lucide-react";

/**
 * Numbered progress indicator for the setup wizard.
 *
 * @param props - Step labels and the 1-based current step.
 * @returns The indicator.
 */
export function StepIndicator({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <ol aria-label="Setup progress" className="mb-4 flex items-center gap-2">
      {steps.map((label, index) => {
        const step = index + 1;
        const done = step < current;
        const active = step === current;
        return (
          <li
            key={label}
            aria-current={active ? "step" : undefined}
            className="flex flex-1 items-center gap-2"
          >
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full border font-mono text-[10px]",
                done && "border-accent-text bg-accent text-accent-foreground",
                active && "border-accent-text text-accent-text",
                !done && !active && "border-border-strong text-subtle-foreground",
              )}
            >
              {done ? <CheckIcon className="size-3" aria-hidden="true" /> : step}
            </span>
            <span
              className={cn(
                "truncate font-mono text-[10px] uppercase tracking-[0.1em]",
                active ? "text-foreground" : "text-subtle-foreground",
              )}
            >
              {label}
              {done ? <span className="sr-only"> (done)</span> : null}
            </span>
            {step < steps.length ? (
              <span className="h-px flex-1 bg-border" aria-hidden="true" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
