import { cn, Input } from "@roundhouse/ui";
import {
  type ComponentProps,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  applySuggestion,
  type ReferenceCatalog,
  referenceContext,
  referenceSuggestions,
} from "./variables-model";

/** Props for {@link ReferenceInput}. */
export interface ReferenceInputProps
  extends Omit<ComponentProps<"input">, "value" | "onChange" | "role"> {
  value: string;
  onValueChange: (value: string) => void;
  /** Services and keys to suggest inside `${{ … }}`. */
  catalog: ReferenceCatalog;
  /** Called when the user types `slug.`, so the caller can load that service's keys. */
  onNamespace?: (slug: string) => void;
}

/**
 * Text input for variable values with autocomplete for `${{ … }}` references: typing
 * `${{` lists services, `shared` and this service's keys; `api.` then lists `api`'s
 * keys and built-ins. Follows the ARIA combobox pattern: arrows move, Enter or Tab
 * accepts, Escape closes.
 *
 * @param props - Input props, value, catalog and namespace callback.
 * @returns The input with its suggestion list.
 */
export function ReferenceInput({
  value,
  onValueChange,
  catalog,
  onNamespace,
  className,
  onKeyDown,
  onBlur,
  ...props
}: ReferenceInputProps) {
  const input = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const listId = useId();

  const context = caret === null ? null : referenceContext(value, caret);
  const suggestions = useMemo(
    () => (context ? referenceSuggestions(context.query, catalog) : []),
    [context, catalog],
  );
  const open = !dismissed && context !== null && suggestions.length > 0;
  const namespace = context?.query.includes(".") ? context.query.split(".")[0] : undefined;

  useEffect(() => {
    if (namespace) onNamespace?.(namespace);
  }, [namespace, onNamespace]);

  function syncCaret() {
    setCaret(input.current?.selectionStart ?? null);
  }

  function accept(index: number) {
    const suggestion = suggestions[index];
    if (!context || caret === null || !suggestion) return;
    const next = applySuggestion(value, caret, context, suggestion);
    onValueChange(next.value);
    setActive(0);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      input.current?.setSelectionRange(next.caret, next.caret);
      input.current?.focus();
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (open) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((index) => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => (index - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        accept(Math.min(active, suggestions.length - 1));
        return;
      }
      if (event.key === "Escape") {
        // NOTE: Stop here so Escape closes the list, not the dialog around the input.
        event.preventDefault();
        event.stopPropagation();
        setDismissed(true);
        return;
      }
    }
    onKeyDown?.(event);
  }

  const activeIndex = Math.min(active, Math.max(0, suggestions.length - 1));

  return (
    <div className="relative">
      <Input
        ref={input}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
        value={value}
        onChange={(event) => {
          onValueChange(event.target.value);
          setCaret(event.target.selectionStart);
          setDismissed(false);
          setActive(0);
        }}
        onKeyDown={handleKeyDown}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onBlur={(event) => {
          setDismissed(true);
          onBlur?.(event);
        }}
        onFocus={() => setDismissed(false)}
        spellCheck={false}
        autoComplete="off"
        className={cn("font-mono text-xs", className)}
        {...props}
      />
      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Reference suggestions"
          className="absolute top-full left-0 z-50 mt-1 max-h-56 w-full min-w-64 overflow-y-auto rounded-md border border-border-strong bg-surface-raised p-1 shadow-xl shadow-black/30"
        >
          {suggestions.map((suggestion, index) => (
            <div
              key={suggestion.insert}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              tabIndex={-1}
              // NOTE: mousedown, not click: the input's blur would close the list first.
              onMouseDown={(event) => {
                event.preventDefault();
                accept(index);
              }}
              onMouseMove={() => setActive(index)}
              className={cn(
                "flex cursor-pointer items-center justify-between gap-3 rounded-sm px-2 py-1 font-mono text-xs text-muted-foreground",
                index === activeIndex && "bg-muted text-foreground",
              )}
            >
              <span className="truncate">{suggestion.label}</span>
              <span className="shrink-0 font-sans text-[11px] text-muted-foreground">
                {suggestion.detail}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
