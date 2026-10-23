/**
 * Settings system: the layout, sub-navigation, sections, rows, save bar, danger zone and
 * choice cards that every settings view is built from.
 *
 * - {@link SettingsLayout}: a left sub-nav beside the content; below 1024px the nav becomes
 *   a row of tabs that scrolls sideways inside itself.
 * - {@link SettingsNav}, {@link SettingsNavGroup}, {@link SettingsNavItem}: the sub-nav,
 *   with collapsible groups on desktop. Items are links supplied by the app (`asChild`).
 * - {@link SettingsStack} and {@link SettingsSection}: sections separated by a hairline and
 *   space, never boxed in cards.
 * - {@link SettingsRow}: label and description on the left, the control on the right; it
 *   stacks on phones (a switch stays beside its label).
 * - {@link SaveBar}: "Unsaved changes · Discard · Save" that sticks to the bottom of the
 *   viewport while its form has edits.
 * - {@link DangerZone}: the last section, for destructive actions.
 * - {@link ChoiceCards}: a radio group of cards with previews (theme, density).
 *
 * @module
 */
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Slot } from "radix-ui";
import { type ComponentProps, type ReactNode, useId, useState } from "react";
import { cn } from "../lib/cn";
import { Button } from "./button";

// -----------------------------------------------------------------------------
// Layout and navigation
// -----------------------------------------------------------------------------

/** Props for {@link SettingsLayout}. */
export interface SettingsLayoutProps {
  /** The sub-navigation, usually a {@link SettingsNav}. */
  nav: ReactNode;
  /** The current settings view. */
  children: ReactNode;
  /** Extra classes for the grid. */
  className?: string;
}

/**
 * Two-column settings frame: the sub-nav in a 13rem column on the left (sticky while the
 * view scrolls) and the view in a readable column on the right. Below 1024px the nav sits
 * above the view as a scrolling tab row.
 *
 * @param props - Navigation and content.
 * @returns The layout.
 * @example
 * <SettingsLayout nav={<SettingsNav label="Settings">…</SettingsNav>}>
 *   <SettingsStack>…</SettingsStack>
 * </SettingsLayout>
 */
export function SettingsLayout({ nav, children, className }: SettingsLayoutProps) {
  return (
    <div
      className={cn("grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-12 xl:gap-16", className)}
    >
      <div className="min-w-0 lg:sticky lg:top-20 lg:self-start">{nav}</div>
      <div className="min-w-0 max-w-[50rem]">{children}</div>
    </div>
  );
}

/** Props for {@link SettingsNav}. */
export interface SettingsNavProps extends Omit<ComponentProps<"nav">, "aria-label"> {
  /** Accessible name of the navigation landmark, e.g. "Settings". */
  label: string;
}

/**
 * The settings sub-navigation landmark. A vertical list of groups on desktop; a single
 * row of tabs on smaller screens, scrolling inside its own box.
 *
 * @param props - Accessible name and groups.
 * @returns The navigation.
 */
export function SettingsNav({ label, children, className, ...props }: SettingsNavProps) {
  return (
    <nav
      {...props}
      aria-label={label}
      className={cn(
        "overflow-x-auto border-b border-border [scrollbar-width:none] lg:overflow-visible lg:border-0",
        className,
      )}
    >
      <div className="flex gap-5 lg:grid lg:gap-5">{children}</div>
    </nav>
  );
}

/** Props for {@link SettingsNavGroup}. */
export interface SettingsNavGroupProps {
  /** Group heading, e.g. "Workspace". */
  label: string;
  /** {@link SettingsNavItem}s. */
  children: ReactNode;
  /** Whether the group starts expanded. Defaults to `true`. */
  defaultOpen?: boolean;
}

/**
 * A titled, collapsible group of nav items. On small screens the heading hides and the
 * items join the single tab row, so collapsing only applies on desktop.
 *
 * @param props - Heading, items and initial state.
 * @returns The group.
 */
export function SettingsNavGroup({ label, children, defaultOpen = true }: SettingsNavGroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  const listId = useId();
  return (
    <div className="contents lg:block">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className="hidden w-full items-center justify-between gap-2 rounded-md px-2.5 py-1 text-left text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring lg:flex"
      >
        {label}
        <ChevronDownIcon
          className={cn("size-3.5 transition-transform", !open && "-rotate-90")}
          aria-hidden="true"
        />
      </button>
      <ul id={listId} className={cn("contents lg:mt-1 lg:grid lg:gap-0.5", !open && "lg:hidden")}>
        {children}
      </ul>
    </div>
  );
}

/** Props for {@link SettingsNavItem}. */
export interface SettingsNavItemProps extends ComponentProps<"a"> {
  /** Render the single child (a router link) instead of an `<a>`, merging props onto it. */
  asChild?: boolean;
}

/**
 * One settings destination. Marks itself current through `aria-current="page"`, which
 * router links set when active: an underline in the tab row, a neutral pill on desktop.
 *
 * @param props - Anchor props plus `asChild`.
 * @returns The list item and its link.
 */
export function SettingsNavItem({ asChild = false, className, ...props }: SettingsNavItemProps) {
  const Comp = asChild ? Slot.Root : "a";
  return (
    <li className="shrink-0">
      <Comp
        className={cn(
          "-mb-px flex h-10 items-center gap-2 border-b-2 border-transparent text-sm whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:border-accent-text aria-[current=page]:text-foreground lg:mb-0 lg:h-8 lg:rounded-md lg:border-b-0 lg:px-2.5 lg:hover:bg-muted lg:aria-[current=page]:bg-muted [&_svg]:size-4 [&_svg]:shrink-0",
          className,
        )}
        {...props}
      />
    </li>
  );
}

// -----------------------------------------------------------------------------
// Sections and rows
// -----------------------------------------------------------------------------

/**
 * Vertical stack of settings sections (or forms wrapping them), each separated from the
 * one above by a full-width hairline with equal space on both sides.
 *
 * @param props - Div props.
 * @returns The stack.
 */
export function SettingsStack({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("grid gap-8 [&>*+*]:border-t [&>*+*]:border-border [&>*+*]:pt-8", className)}
      {...props}
    />
  );
}

/** Props for {@link SettingsSection}. */
export interface SettingsSectionProps extends Omit<ComponentProps<"section">, "title"> {
  /** Section heading, rendered as an `h2`. */
  title: ReactNode;
  /** One or two sentences on what the section controls. */
  description?: ReactNode;
  /** Controls on the heading's right, e.g. a status badge or an "Add" button. */
  actions?: ReactNode;
}

/**
 * A titled group of {@link SettingsRow}s. Rows are split by hairlines; the section itself
 * has no box around it.
 *
 * @param props - Title, description, actions and rows.
 * @returns The section.
 */
export function SettingsSection({
  title,
  description,
  actions,
  children,
  className,
  ...props
}: SettingsSectionProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cn("min-w-0", className)} {...props}>
      <header className="mb-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 max-w-[42rem]">
          <h2 id={headingId} className="text-[15px] font-semibold text-foreground">
            {title}
          </h2>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      <div className="divide-y divide-border/70">{children}</div>
    </section>
  );
}

/** Props for {@link SettingsRow}. */
export interface SettingsRowProps {
  /** The setting's name. */
  label: ReactNode;
  /** What it does, in grey under the label. Its id is `${htmlFor}-description`. */
  description?: ReactNode;
  /** Id of the control the label names; renders the label as a `<label>`. */
  htmlFor?: string;
  /**
   * How the control sits: `field` (default) in a right-hand column that stacks under the
   * label on phones; `switch` beside the label at every width; `wide` under the label at
   * full width (lists, editors, tables).
   */
  control?: "field" | "switch" | "wide";
  /** The control. */
  children?: ReactNode;
  /** Extra classes. */
  className?: string;
}

/**
 * One setting: label and description on the left, its control on the right.
 *
 * @param props - Label, description, control id and layout.
 * @returns The row.
 * @example
 * <SettingsRow label="Replicas" description="0 stops the service." htmlFor={id}>
 *   <Input id={id} aria-describedby={`${id}-description`} />
 * </SettingsRow>
 */
export function SettingsRow({
  label,
  description,
  htmlFor,
  control = "field",
  children,
  className,
}: SettingsRowProps) {
  const Label = htmlFor ? "label" : "p";
  return (
    <div
      className={cn(
        "grid gap-x-8 gap-y-3 py-4",
        control === "field" && "md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-start",
        control === "switch" && "grid-cols-[minmax(0,1fr)_auto] items-center",
        className,
      )}
    >
      <div className="min-w-0">
        <Label htmlFor={htmlFor} className="block text-sm font-medium text-foreground">
          {label}
        </Label>
        {description ? (
          <p
            id={htmlFor ? `${htmlFor}-description` : undefined}
            className="mt-0.5 text-[13px] leading-snug text-muted-foreground"
          >
            {description}
          </p>
        ) : null}
      </div>
      {children !== undefined ? <div className="min-w-0">{children}</div> : null}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Save bar and danger zone
// -----------------------------------------------------------------------------

/** Props for {@link SaveBar}. */
export interface SaveBarProps {
  /** Whether the form has edits. Enables Save and shows the bar. */
  dirty: boolean;
  /** Shows a spinner on Save. */
  saving?: boolean;
  /** Throws the edits away. Without it there is no Discard button. */
  onDiscard?: () => void;
  /** Label of the submit button. Defaults to "Save". */
  saveLabel?: string;
  /** Extra classes. */
  className?: string;
}

/**
 * The footer of a settings form. At rest it is a disabled Save aligned right; once the
 * form has edits it becomes a raised bar, "Unsaved changes · Discard · Save", that sticks
 * to the bottom of the viewport until the form is saved or discarded. Put it inside the
 * `<form>`; Save is its submit button.
 *
 * @param props - Dirty and saving state, discard handler and label.
 * @returns The bar.
 */
export function SaveBar({
  dirty,
  saving = false,
  onDiscard,
  saveLabel = "Save",
  className,
}: SaveBarProps) {
  return (
    <div
      data-dirty={dirty || undefined}
      className={cn(
        "mt-4 flex items-center justify-end gap-2",
        dirty &&
          "sticky bottom-3 z-10 rounded-lg border border-border-strong bg-surface-raised py-2 pr-2 pl-3.5 shadow-lg shadow-black/25",
        className,
      )}
    >
      {dirty ? (
        <p className="mr-auto flex items-center gap-2 text-sm text-foreground">
          <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />
          Unsaved changes
        </p>
      ) : null}
      {dirty && onDiscard ? (
        <Button variant="ghost" onClick={onDiscard}>
          Discard
        </Button>
      ) : null}
      <Button
        type="submit"
        variant={dirty ? "primary" : "secondary"}
        disabled={!dirty}
        loading={saving}
      >
        {saveLabel}
      </Button>
    </div>
  );
}

/** Props for {@link DangerZone}. */
export interface DangerZoneProps {
  /** Heading. Defaults to "Danger zone". */
  title?: string;
  /** Optional line under the heading. */
  description?: ReactNode;
  /** {@link SettingsRow}s, each with a `danger-outline` button as its control. */
  children: ReactNode;
}

/**
 * The last section of a settings view, holding actions that can't be undone. Each row
 * states the consequence on the left and carries an outlined button in the negative
 * colour; the confirmation that names the object is the caller's.
 *
 * @param props - Heading, description and rows.
 * @returns The section.
 */
export function DangerZone({ title = "Danger zone", description, children }: DangerZoneProps) {
  return (
    <SettingsSection title={title} description={description}>
      {children}
    </SettingsSection>
  );
}

// -----------------------------------------------------------------------------
// Choice cards
// -----------------------------------------------------------------------------

/** One option of {@link ChoiceCards}. */
export interface ChoiceCardOption<T extends string> {
  value: T;
  label: string;
  /** A short line under the label. */
  description?: string;
  /** A small picture of the result, e.g. a miniature of the theme. Decorative. */
  preview?: ReactNode;
}

/** Props for {@link ChoiceCards}. */
export interface ChoiceCardsProps<T extends string> {
  /** Accessible name of the group (its legend). */
  label: string;
  /** Show the legend visibly instead of only to assistive tech. */
  showLabel?: boolean;
  /** Selected value. */
  value: T;
  /** Called with the chosen value. */
  onValueChange: (value: T) => void;
  options: readonly ChoiceCardOption<T>[];
  /** Extra classes for the grid. */
  className?: string;
}

/**
 * A radio group drawn as cards with previews. Native radio inputs keep arrow-key
 * movement and form semantics; the selected card takes a 1px accent edge and a check.
 *
 * @param props - Label, value, handler and options.
 * @returns The group.
 * @example
 * <ChoiceCards label="Theme" value={theme} onValueChange={setTheme}
 *   options={[{ value: "dark", label: "Dark", preview: <DarkPreview /> }]} />
 */
export function ChoiceCards<T extends string>({
  label,
  showLabel = false,
  value,
  onValueChange,
  options,
  className,
}: ChoiceCardsProps<T>) {
  const name = useId();
  return (
    <fieldset className="min-w-0">
      <legend className={showLabel ? "mb-2 text-sm font-medium text-foreground" : "sr-only"}>
        {label}
      </legend>
      <div className={cn("grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3", className)}>
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label
              key={option.value}
              className={cn(
                "group relative grid cursor-pointer content-start gap-2.5 rounded-lg border border-border bg-surface p-2 transition-colors hover:border-border-strong has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                checked && "border-accent-text hover:border-accent-text",
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                onChange={() => onValueChange(option.value)}
                className="sr-only"
              />
              {option.preview ? (
                <div aria-hidden="true" className="overflow-hidden rounded-md border border-border">
                  {option.preview}
                </div>
              ) : null}
              <span className="flex items-center justify-between gap-2 px-1 text-sm font-medium text-foreground">
                {option.label}
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex size-4 items-center justify-center rounded-full border border-border-strong",
                    checked && "border-accent-text bg-accent-text text-background",
                  )}
                >
                  {checked ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
                </span>
              </span>
              {option.description ? (
                <span className="-mt-1.5 px-1 pb-0.5 text-xs text-muted-foreground">
                  {option.description}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
