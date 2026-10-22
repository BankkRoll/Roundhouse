import { cn } from "../lib/cn";

const PALETTE = [
  "bg-[#3b4cca] text-white",
  "bg-[#0f8b8d] text-white",
  "bg-[#b4446c] text-white",
  "bg-[#c77a0a] text-white",
  "bg-[#5b7400] text-white",
  "bg-[#6d4fc2] text-white",
  "bg-[#2f7de1] text-white",
  "bg-[#a33f2f] text-white",
] as const;

/**
 * Up to two initials for a name or email.
 *
 * @param name - Display name or email address.
 * @returns Uppercase initials, or `?` when nothing usable is given.
 * @example
 * initials("Ada Lovelace"); // "AL"
 * initials("ops@example.com"); // "OP"
 */
export function initials(name: string): string {
  const base = name.includes("@") ? (name.split("@")[0] ?? "") : name;
  const words = base
    .split(/[\s._-]+/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return (words[0] ?? "").slice(0, 2).toUpperCase();
  return `${words[0]?.[0] ?? ""}${words[words.length - 1]?.[0] ?? ""}`.toUpperCase();
}

/**
 * Picks a stable palette index for a seed string so a person keeps the same color.
 *
 * @param seed - Usually a user or workspace id.
 * @returns Index into the avatar palette.
 */
export function avatarColorIndex(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash % PALETTE.length;
}

/** Props for {@link Avatar}. */
export interface AvatarProps {
  /** Name the initials are derived from. */
  name: string;
  /** Seed for the background color. Defaults to `name`. */
  seed?: string;
  /** Square (workspaces) or round (people). Defaults to `round`. */
  shape?: "round" | "square";
  /** Pixel size. Defaults to 24. */
  size?: number;
  /** Extra classes. */
  className?: string;
}

/**
 * Initials avatar with a deterministic background. Decorative: the name should be visible
 * next to it.
 *
 * @param props - Name, seed, shape and size.
 * @returns The rendered avatar.
 */
export function Avatar({ name, seed, shape = "round", size = 24, className }: AvatarProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-mono font-semibold select-none",
        shape === "round" ? "rounded-full" : "rounded-md",
        PALETTE[avatarColorIndex(seed ?? name)],
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.38)) }}
    >
      {initials(name)}
    </span>
  );
}
