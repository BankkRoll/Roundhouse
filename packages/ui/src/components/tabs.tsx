/**
 * Class string for an underlined tab, for router links that act as tabs. The active
 * underline uses `accent-text` because the lime `accent` fails 3:1 against the light
 * background.
 */
export const tabTriggerClasses =
  "-mb-px inline-flex h-9 items-center gap-1.5 border-b-2 border-transparent text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:underline aria-[current=page]:border-accent-text aria-[current=page]:text-foreground";
