import { CircleAlertIcon, CircleCheckIcon, InfoIcon, XIcon } from "lucide-react";
import { Toast as ToastPrimitive } from "radix-ui";
import { type ReactElement, useSyncExternalStore } from "react";
import { cn } from "../lib/cn";

/** Visual tone of a toast. */
export type ToastTone = "info" | "success" | "error";

/** Options accepted by {@link toast}. */
export interface ToastOptions {
  /** Short headline. */
  title: string;
  /** Optional detail line. */
  description?: string;
  /** Defaults to `info`. */
  tone?: ToastTone;
  /** Auto-dismiss delay in ms. Defaults to 5000. */
  durationMs?: number;
}

/** A toast currently queued for display. */
export interface ToastRecord extends Required<Omit<ToastOptions, "description">> {
  id: number;
  description?: string;
}

let nextId = 1;
let queue: ToastRecord[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Shows a toast through the mounted {@link Toaster}. Callable from anywhere, including
 * mutation callbacks outside React.
 *
 * @param options - Title, description, tone and duration.
 * @returns The toast id, for {@link dismissToast}.
 * @example
 * toast({ title: "Server removed", tone: "success" });
 */
export function toast(options: ToastOptions): number {
  const id = nextId++;
  queue = [
    ...queue,
    {
      id,
      title: options.title,
      description: options.description,
      tone: options.tone ?? "info",
      durationMs: options.durationMs ?? 5000,
    },
  ];
  emit();
  return id;
}

/**
 * Removes a toast.
 *
 * @param id - Id returned by {@link toast}.
 */
export function dismissToast(id: number): void {
  queue = queue.filter((item) => item.id !== id);
  emit();
}

/**
 * Removes every toast. Mainly useful between tests.
 */
export function clearToasts(): void {
  queue = [];
  emit();
}

const toneIcon = {
  info: <InfoIcon className="size-4 text-info" aria-hidden="true" />,
  success: <CircleCheckIcon className="size-4 text-success" aria-hidden="true" />,
  error: <CircleAlertIcon className="size-4 text-danger" aria-hidden="true" />,
} satisfies Record<ToastTone, ReactElement>;

/**
 * Renders queued toasts in the bottom-right corner. Mount once near the app root.
 * Errors are announced assertively; everything else politely.
 *
 * @returns The toast viewport.
 */
export function Toaster() {
  const items = useSyncExternalStore(
    subscribe,
    () => queue,
    () => queue,
  );
  return (
    <ToastPrimitive.Provider swipeDirection="right">
      {items.map((item) => (
        <ToastPrimitive.Root
          key={item.id}
          duration={item.durationMs}
          type={item.tone === "error" ? "foreground" : "background"}
          onOpenChange={(open) => {
            if (!open) dismissToast(item.id);
          }}
          className={cn(
            "flex items-start gap-2.5 rounded-lg border border-border-strong bg-surface-raised p-3 pr-8 shadow-xl shadow-black/30",
            "relative data-[swipe=move]:translate-x-(--radix-toast-swipe-move-x)",
          )}
        >
          <span className="mt-px">{toneIcon[item.tone]}</span>
          <div className="grid gap-0.5">
            <ToastPrimitive.Title className="text-sm font-medium">
              {item.title}
            </ToastPrimitive.Title>
            {item.description ? (
              <ToastPrimitive.Description className="text-xs text-muted-foreground">
                {item.description}
              </ToastPrimitive.Description>
            ) : null}
          </div>
          <ToastPrimitive.Close
            aria-label="Dismiss notification"
            className="absolute top-2.5 right-2.5 rounded-sm p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon className="size-3.5" aria-hidden="true" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport className="fixed right-0 bottom-0 z-[100] flex w-full max-w-sm flex-col gap-2 p-4 outline-none" />
    </ToastPrimitive.Provider>
  );
}
