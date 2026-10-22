/** A key sequence bound to a handler, such as `["g", "s"]` for "G then S". */
export interface ShortcutBinding {
  /** Lowercase keys pressed one after another. A single key is a plain shortcut. */
  keys: readonly string[];
  /** Runs when the full sequence is typed. */
  run: () => void;
}

/** Options for {@link createShortcutHandler}. */
export interface ShortcutHandlerOptions {
  /** Max delay between keys of a sequence before it resets. Defaults to 1000ms. */
  timeoutMs?: number;
  /** Clock override for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Returns `true` while shortcuts should be ignored, e.g. when an overlay is open. */
  isSuspended?: () => boolean;
}

/** Minimal shape of a keyboard event the handler needs. */
export interface ShortcutKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
  defaultPrevented: boolean;
  /** `true` while an input method editor is composing text. */
  isComposing?: boolean;
  preventDefault(): void;
}

const OVERLAY_SELECTOR = [
  "[role=dialog]",
  "[role=alertdialog]",
  "[role=menu]",
  "[role=listbox]",
].join(",");

/**
 * Whether a modal surface the user is working in (dialog, menu or listbox) is open.
 * Radix only mounts these while open, so presence in the DOM means open.
 *
 * @param root - Where to look. Defaults to `document`.
 * @returns `true` when any dialog, alert dialog, menu or listbox is rendered.
 */
export function isOverlayOpen(root: ParentNode = document): boolean {
  return root.querySelector(OVERLAY_SELECTOR) !== null;
}

/**
 * Whether a key event originated somewhere the user is typing text.
 *
 * @param target - The event target.
 * @returns `true` for inputs, textareas, selects and contenteditable elements.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== "string") return false;
  const element = target as HTMLElement;
  const tag = element.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    element.isContentEditable ||
    element.getAttribute("contenteditable") === "true"
  );
}

/**
 * Builds a keydown handler that matches Linear-style key sequences ("G then S").
 *
 * Keys typed into form fields, during IME composition, or with Cmd/Ctrl/Alt held are
 * ignored so shortcuts never fight with text entry or browser/OS bindings. A sequence
 * resets after `timeoutMs` without a keypress, or when a key does not continue any
 * binding.
 *
 * @param bindings - Sequences to listen for.
 * @param options - Timing options.
 * @returns A function to attach as a `keydown` listener.
 * @example
 * const onKeyDown = createShortcutHandler([{ keys: ["g", "s"], run: goToServers }]);
 * window.addEventListener("keydown", onKeyDown);
 */
export function createShortcutHandler(
  bindings: readonly ShortcutBinding[],
  options: ShortcutHandlerOptions = {},
): (event: ShortcutKeyEvent) => void {
  const timeoutMs = options.timeoutMs ?? 1000;
  const now = options.now ?? Date.now;
  let buffer: string[] = [];
  let lastAt = 0;

  return (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    // COMPAT: Some browsers report keys confirming an IME candidate as "Process" without
    // setting isComposing.
    if (event.isComposing || event.key === "Process") return;
    if (isEditableTarget(event.target)) return;
    if (options.isSuspended?.()) return;
    if (event.key.length !== 1) return;

    const key = event.key.toLowerCase();
    const at = now();
    if (at - lastAt > timeoutMs) buffer = [];
    lastAt = at;

    const attempt = (candidate: string[]) =>
      bindings.filter((binding) => candidate.every((k, i) => binding.keys[i] === k));

    let sequence = [...buffer, key];
    let matches = attempt(sequence);
    if (matches.length === 0 && buffer.length > 0) {
      sequence = [key];
      matches = attempt(sequence);
    }

    const complete = matches.find((binding) => binding.keys.length === sequence.length);
    if (complete) {
      buffer = [];
      event.preventDefault();
      complete.run();
      return;
    }
    buffer = matches.length > 0 ? sequence : [];
  };
}
