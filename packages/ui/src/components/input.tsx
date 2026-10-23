import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/** Shared field chrome for text-like controls. */
const fieldClasses =
  "h-8 w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-sm text-foreground transition-colors outline-none placeholder:text-subtle-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger aria-invalid:ring-danger/20";

/**
 * Text input.
 *
 * @param props - Native input props.
 * @returns The rendered input.
 */
export function Input({ className, type = "text", ...props }: ComponentProps<"input">) {
  return <input type={type} className={cn(fieldClasses, className)} {...props} />;
}

/**
 * Native `<select>` styled like {@link Input}. Native keeps keyboard and screen reader
 * behaviour correct for short option lists such as roles.
 *
 * @param props - Native select props.
 * @returns The rendered select.
 */
export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(fieldClasses, "cursor-pointer pr-7", className)} {...props} />;
}

/**
 * Native checkbox in the accent colour. Native keeps it a real form control (Space
 * toggles it, `<label>` clicks reach it); pair it with a `<label>` or `aria-label`.
 *
 * @param props - Native input props except `type`.
 * @returns The rendered checkbox.
 * @example
 * <label className="flex items-center gap-2">
 *   <Checkbox checked={on} onChange={(e) => setOn(e.target.checked)} /> Builder node
 * </label>
 */
export function Checkbox({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  return (
    <input
      type="checkbox"
      className={cn(
        "size-3.5 shrink-0 cursor-pointer rounded-sm accent-accent-text outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Multi-line text input styled like {@link Input}, in mono for pasted config such as
 * `.env` files.
 *
 * @param props - Native textarea props.
 * @returns The rendered textarea.
 */
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        fieldClasses,
        "h-auto min-h-24 resize-y py-2 font-mono text-xs leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}
