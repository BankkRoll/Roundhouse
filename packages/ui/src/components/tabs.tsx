/**
 * Tabs: the underline class for router links that act as tabs, and an in-page tab set
 * following the WAI-ARIA tabs pattern (roving tab stop, arrow keys, Home/End, automatic
 * activation). A disabled tab stays focusable so assistive tech can still read why it
 * is unavailable (a tooltip, say), but it can never be selected.
 *
 * @module
 */
import {
  type ComponentProps,
  createContext,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useId,
} from "react";
import { cn } from "../lib/cn";

/**
 * Class string for an underlined tab, for router links that act as tabs. The active
 * underline uses `accent-text` because the lime `accent` fails 3:1 against the light
 * background.
 */
export const tabTriggerClasses =
  "-mb-px inline-flex h-9 items-center gap-1.5 border-b-2 border-transparent text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:underline aria-[current=page]:border-accent-text aria-[current=page]:text-foreground";

/** Same look as {@link tabTriggerClasses}, keyed on `aria-selected` for {@link TabsTrigger}. */
const tabsTriggerClasses =
  "-mb-px inline-flex h-9 shrink-0 items-center gap-1.5 border-b-2 border-transparent text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:underline aria-selected:border-accent-text aria-selected:text-foreground aria-disabled:cursor-not-allowed aria-disabled:hover:text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0";

interface TabsContextValue {
  baseId: string;
  value: string;
  select: (value: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs(component: string): TabsContextValue {
  const context = useContext(TabsContext);
  if (!context) throw new Error(`<${component}> must be rendered inside <Tabs>`);
  return context;
}

function tabId(baseId: string, value: string) {
  return `${baseId}-tab-${value}`;
}

function panelId(baseId: string, value: string) {
  return `${baseId}-panel-${value}`;
}

/** Props for {@link Tabs}. */
export interface TabsProps {
  /** Value of the selected tab. */
  value: string;
  /** Called with the value of the tab the user selects. */
  onValueChange: (value: string) => void;
  children: ReactNode;
  /** Extra classes for the wrapper. */
  className?: string;
}

/**
 * A controlled set of tabs. Put one {@link TabsList} of {@link TabsTrigger}s and one
 * {@link TabsContent} per tab inside.
 *
 * @param props - Selected value, change handler and children.
 * @returns The tab set.
 * @example
 * <Tabs value={tab} onValueChange={setTab}>
 *   <TabsList label="Install method">
 *     <TabsTrigger value="linux">Linux</TabsTrigger>
 *     <TabsTrigger value="cloud">Cloud-init</TabsTrigger>
 *   </TabsList>
 *   <TabsContent value="linux">…</TabsContent>
 *   <TabsContent value="cloud">…</TabsContent>
 * </Tabs>
 */
export function Tabs({ value, onValueChange, children, className }: TabsProps) {
  const baseId = useId();
  return (
    <TabsContext.Provider value={{ baseId, value, select: onValueChange }}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

/** Props for {@link TabsList}. */
export interface TabsListProps {
  /** Accessible name of the tab list. */
  label: string;
  children: ReactNode;
  /** Extra classes. */
  className?: string;
}

const NAVIGATION_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

/**
 * The row of tabs. Left/Right move between tabs (wrapping), Home/End jump to the ends,
 * and moving onto an enabled tab selects it.
 *
 * @param props - Accessible name and the triggers.
 * @returns The tab list.
 */
export function TabsList({ label, children, className }: TabsListProps) {
  const { select } = useTabs("TabsList");

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!NAVIGATION_KEYS.has(event.key)) return;
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
    const current = tabs.indexOf(document.activeElement as HTMLElement);
    if (current === -1 || tabs.length === 0) return;
    event.preventDefault();
    const last = tabs.length - 1;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? last
          : event.key === "ArrowRight"
            ? current === last
              ? 0
              : current + 1
            : current === 0
              ? last
              : current - 1;
    const target = tabs[next];
    if (!target) return;
    target.focus();
    if (target.getAttribute("aria-disabled") !== "true" && target.dataset.value) {
      select(target.dataset.value);
    }
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      className={cn("flex gap-5 overflow-x-auto border-b border-border", className)}
    >
      {children}
    </div>
  );
}

/** Props for {@link TabsTrigger}. */
export interface TabsTriggerProps extends Omit<ComponentProps<"button">, "value"> {
  /** Value selected by this tab. */
  value: string;
  /**
   * Shown but not selectable. Unlike a native `disabled` button it stays focusable, so
   * a tooltip attached to it still opens on hover and focus.
   */
  disabled?: boolean;
}

/**
 * One tab. Extra props (for example from a `Tooltip` trigger) are passed to the button,
 * and its own handlers run after them.
 *
 * @param props - Value, disabled flag and button props.
 * @returns The tab.
 */
export function TabsTrigger({
  value,
  disabled = false,
  className,
  children,
  onClick,
  ...props
}: TabsTriggerProps) {
  const { baseId, value: selected, select } = useTabs("TabsTrigger");
  const active = selected === value;
  return (
    <button
      {...props}
      type="button"
      role="tab"
      id={tabId(baseId, value)}
      aria-controls={active ? panelId(baseId, value) : undefined}
      aria-selected={active}
      aria-disabled={disabled || undefined}
      tabIndex={active ? 0 : -1}
      data-value={value}
      data-state={active ? "active" : "inactive"}
      onClick={(event) => {
        onClick?.(event);
        if (!disabled && !event.defaultPrevented) select(value);
      }}
      className={cn(tabsTriggerClasses, className)}
    >
      {children}
    </button>
  );
}

/** Props for {@link TabsContent}. */
export interface TabsContentProps {
  /** Value of the tab this panel belongs to. */
  value: string;
  children: ReactNode;
  /** Extra classes. */
  className?: string;
}

/**
 * The panel of one tab. Only the selected tab's panel is rendered.
 *
 * @param props - The tab's value and the panel content.
 * @returns The panel, or nothing when its tab isn't selected.
 */
export function TabsContent({ value, children, className }: TabsContentProps) {
  const { baseId, value: selected } = useTabs("TabsContent");
  if (selected !== value) return null;
  return (
    <div
      role="tabpanel"
      id={panelId(baseId, value)}
      aria-labelledby={tabId(baseId, value)}
      className={className}
    >
      {children}
    </div>
  );
}
