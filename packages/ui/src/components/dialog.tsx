import { XIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../lib/cn";

/** Dialog root. Controls open state; see Radix Dialog for props. */
export const Dialog = DialogPrimitive.Root;

/** Element that opens the dialog. Use `asChild` to wrap a {@link Button}. */
export const DialogTrigger = DialogPrimitive.Trigger;

/** Element that closes the dialog. Use `asChild` to wrap a {@link Button}. */
export const DialogClose = DialogPrimitive.Close;

/** Props for {@link DialogContent}. */
export interface DialogContentProps extends ComponentProps<typeof DialogPrimitive.Content> {
  /** Hide the top-right close button, e.g. for a blocking confirmation. */
  hideClose?: boolean;
}

/**
 * Modal panel rendered in a portal over a dimmed overlay. Traps focus and closes on Escape.
 * Always include a {@link DialogTitle}.
 *
 * @param props - Radix content props plus `hideClose`.
 * @returns The rendered dialog.
 */
export function DialogContent({ className, children, hideClose, ...props }: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px]" />
      <DialogPrimitive.Content
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-lg border border-border-strong bg-surface p-5 shadow-2xl shadow-black/40 outline-none",
          className,
        )}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close
            className="absolute top-3 right-3 rounded-sm p-1 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Close"
          >
            <XIcon className="size-4" aria-hidden="true" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/**
 * Full-height panel that slides in from the left edge, e.g. the mobile navigation drawer.
 * Use inside {@link Dialog} and include a {@link DialogTitle} (it may be `sr-only`).
 *
 * @param props - Radix content props.
 * @returns The rendered sheet.
 */
export function SheetContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <DialogPrimitive.Content
        aria-describedby={undefined}
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border-strong bg-background shadow-2xl outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

/**
 * Title and description stack at the top of a dialog.
 *
 * @param props - Div props.
 * @returns The rendered header.
 */
export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1 pr-6", className)} {...props} />;
}

/**
 * Right-aligned action row at the bottom of a dialog.
 *
 * @param props - Div props.
 * @returns The rendered footer.
 */
export function DialogFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

/**
 * Accessible dialog title.
 *
 * @param props - Radix title props.
 * @returns The rendered title.
 */
export function DialogTitle({ className, ...props }: ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-base font-semibold text-foreground", className)}
      {...props}
    />
  );
}

/**
 * Accessible dialog description.
 *
 * @param props - Radix description props.
 * @returns The rendered description.
 */
export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}
