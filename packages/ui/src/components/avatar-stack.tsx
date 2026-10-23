import { cn } from "../lib/cn";
import { Avatar } from "./avatar";
import { Tooltip } from "./tooltip";

/** A person shown in an {@link AvatarStack}. */
export interface AvatarStackPerson {
  /** Stable id; seeds the avatar color. */
  id: string;
  name: string;
}

/** Props for {@link AvatarStack}. */
export interface AvatarStackProps {
  people: readonly AvatarStackPerson[];
  /** Avatars drawn before collapsing the rest into "+N". Defaults to 4. */
  max?: number;
  /** Accessible summary, e.g. "Viewing now". */
  label: string;
  /** Pixel size of each avatar. Defaults to 24. */
  size?: number;
  /** Extra classes. */
  className?: string;
}

/**
 * Overlapping avatars for "who is here", with every name in a tooltip and in the
 * accessible label.
 *
 * @param props - People, limit and label.
 * @returns The rendered stack, or nothing when empty.
 */
export function AvatarStack({ people, max = 4, label, size = 24, className }: AvatarStackProps) {
  if (people.length === 0) return null;
  const shown = people.slice(0, max);
  const hidden = people.length - shown.length;
  const names = people.map((person) => person.name).join(", ");
  return (
    <Tooltip content={names}>
      {/* NOTE: A button so keyboard users can focus it and get the same tooltip. It is named
          by hidden text rather than aria-label: checkers count the initials as visible text,
          which an aria-label would have to contain (WCAG 2.5.3). */}
      <button
        type="button"
        className={cn(
          "flex cursor-default items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        {shown.map((person, index) => (
          <Avatar
            key={person.id}
            name={person.name}
            seed={person.id}
            size={size}
            className={cn("ring-2 ring-background", index > 0 && "-ml-1.5")}
          />
        ))}
        <span className="sr-only">{`${label}: ${names}`}</span>
        {hidden > 0 ? (
          <span
            aria-hidden="true"
            className="-ml-1.5 inline-flex items-center justify-center rounded-full bg-muted font-mono text-[11px] text-muted-foreground ring-2 ring-background"
            style={{ width: size, height: size }}
          >
            +{hidden}
          </span>
        ) : null}
      </button>
    </Tooltip>
  );
}
