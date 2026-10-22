import { SearchIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "../lib/cn";
import { KbdHint } from "./kbd-hint";

/** An entry in the {@link CommandPalette}. */
export interface PaletteCommand {
  /** Stable unique id. */
  id: string;
  /** Visible label, e.g. "Go to Servers". */
  label: string;
  /** Heading the command is listed under, e.g. "Navigation". */
  group?: string;
  /** Extra search terms that do not appear in the label. */
  keywords?: readonly string[];
  /** Shortcut hint shown on the right, e.g. `["G", "S"]`. */
  hint?: readonly string[];
  /** Leading icon. */
  icon?: ReactNode;
  /** Runs after the palette closes. */
  onSelect: () => void;
}

function scoreCommand(command: PaletteCommand, query: string): number | null {
  const label = command.label.toLowerCase();
  if (label.startsWith(query)) return 0;
  if (label.split(/\s+/).some((word) => word.startsWith(query))) return 1;
  if (label.includes(query)) return 2;
  if (command.keywords?.some((keyword) => keyword.toLowerCase().includes(query))) return 3;
  let index = 0;
  for (const char of label) {
    if (char === query[index]) index++;
    if (index === query.length) return 4;
  }
  return null;
}

/**
 * Filters and ranks commands for a query: label prefix, then word prefix, substring,
 * keyword, and finally in-order character (fuzzy) matches. Ties keep their input order.
 *
 * @param commands - All available commands.
 * @param query - Raw text typed by the user.
 * @returns Matching commands, best first. An empty query returns every command.
 * @example
 * filterCommands(commands, "srv"); // matches "Go to Servers" fuzzily
 */
export function filterCommands(
  commands: readonly PaletteCommand[],
  query: string,
): PaletteCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...commands];
  return commands
    .map((command, order) => ({ command, order, score: scoreCommand(command, needle) }))
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .map((entry) => entry.command);
}

/**
 * Whether a keyboard event is the palette toggle: Cmd+K on macOS, Ctrl+K elsewhere.
 *
 * @param event - Keyboard event.
 * @returns `true` for Cmd/Ctrl+K without Shift or Alt, outside IME composition.
 */
export function isCommandPaletteHotkey(
  event: Pick<globalThis.KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> &
    Partial<Pick<globalThis.KeyboardEvent, "isComposing">>,
): boolean {
  return (
    !event.isComposing &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "k"
  );
}

/**
 * Toggles the palette on Cmd/Ctrl+K anywhere in the document, including inside inputs.
 *
 * @param onToggle - Called when the hotkey is pressed.
 */
export function useCommandPaletteHotkey(onToggle: () => void): void {
  const handler = useRef(onToggle);
  handler.current = onToggle;
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (!isCommandPaletteHotkey(event)) return;
      event.preventDefault();
      handler.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

interface CommandGroup {
  name: string;
  items: { command: PaletteCommand; index: number }[];
}

function groupCommands(commands: readonly PaletteCommand[]): CommandGroup[] {
  const groups = new Map<string, CommandGroup>();
  commands.forEach((command, index) => {
    const name = command.group ?? "";
    let group = groups.get(name);
    if (!group) {
      group = { name, items: [] };
      groups.set(name, group);
    }
    group.items.push({ command, index });
  });
  return [...groups.values()];
}

/** Props for {@link CommandPalette}. */
export interface CommandPaletteProps {
  /** Whether the palette is open. */
  open: boolean;
  /** Called to open or close the palette. */
  onOpenChange: (open: boolean) => void;
  /** Commands to search. */
  commands: readonly PaletteCommand[];
  /** Input placeholder. */
  placeholder?: string;
}

/**
 * Keyboard-first command palette (combobox + listbox). Arrow keys move the selection,
 * Enter runs it, Escape closes.
 *
 * @param props - Open state and the commands to offer.
 * @returns The palette dialog.
 */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
  placeholder = "Search or run a command",
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const groups = useMemo(() => groupCommands(results), [results]);
  const ordered = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  useEffect(() => {
    if (open) return;
    setQuery("");
    setActive(0);
  }, [open]);

  const activeEntry = ordered[Math.min(active, ordered.length - 1)];

  function run(command: PaletteCommand) {
    onOpenChange(false);
    command.onSelect();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (ordered.length === 0) return;
    const position = activeEntry ? ordered.indexOf(activeEntry) : -1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((position + 1) % ordered.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((position - 1 + ordered.length) % ordered.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(ordered.length - 1);
    } else if (event.key === "Enter" && activeEntry) {
      event.preventDefault();
      run(activeEntry.command);
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed top-[12vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-border-strong bg-surface-raised shadow-2xl shadow-black/50 outline-none"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <div className="flex items-center gap-2 border-b border-border px-3">
            <SearchIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            <input
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={
                activeEntry ? optionId(ordered.indexOf(activeEntry)) : undefined
              }
              aria-label="Search commands"
              placeholder={placeholder}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={onKeyDown}
              className="h-11 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-subtle-foreground"
            />
            <KbdHint keys={["esc"]} />
          </div>
          <div className="max-h-80 overflow-y-auto p-1.5">
            <div role="listbox" id={listId} aria-label="Commands">
              {groups.map((group) => (
                // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA combobox pattern; a fieldset cannot live inside a listbox
                <div key={group.name} role="group" aria-label={group.name || "Commands"}>
                  {group.name ? (
                    <div
                      aria-hidden="true"
                      className="px-2 pt-2 pb-1 font-mono text-[10px] uppercase tracking-[0.12em] text-subtle-foreground"
                    >
                      {group.name}
                    </div>
                  ) : null}
                  {group.items.map((entry) => {
                    const position = ordered.indexOf(entry);
                    const selected = entry === activeEntry;
                    return (
                      // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled by the combobox input
                      <div
                        key={entry.command.id}
                        id={optionId(position)}
                        role="option"
                        aria-selected={selected}
                        tabIndex={-1}
                        onMouseMove={() => setActive(position)}
                        onClick={() => run(entry.command)}
                        className={cn(
                          "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground",
                          selected && "bg-muted text-foreground",
                        )}
                      >
                        {entry.command.icon ? (
                          <span className="flex size-4 items-center justify-center [&_svg]:size-3.5">
                            {entry.command.icon}
                          </span>
                        ) : null}
                        <span className="flex-1 truncate">{entry.command.label}</span>
                        {entry.command.hint ? <KbdHint keys={entry.command.hint} /> : null}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            {ordered.length === 0 ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                No matching commands.
              </p>
            ) : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
