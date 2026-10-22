import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Joins class names and resolves conflicting Tailwind utilities so the last one wins.
 *
 * @param inputs - Class values accepted by `clsx` (strings, arrays, conditional objects).
 * @returns A single class string.
 * @example
 * cn("px-2 text-sm", isActive && "text-accent", "px-3"); // "text-sm text-accent px-3"
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
