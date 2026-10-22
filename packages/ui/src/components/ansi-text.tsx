import { type CSSProperties, memo } from "react";
import { type AnsiSegment, ansiColorCss, parseAnsi } from "../lib/ansi";
import { cn } from "../lib/cn";

function segmentStyle({ style }: AnsiSegment): CSSProperties | undefined {
  let fg = style.fg ? ansiColorCss(style.fg) : undefined;
  let bg = style.bg ? ansiColorCss(style.bg) : undefined;
  if (style.inverse) {
    [fg, bg] = [bg ?? "var(--background)", fg ?? "var(--foreground)"];
  }
  if (!fg && !bg) return undefined;
  return { color: fg, backgroundColor: bg };
}

function segmentClass({ style }: AnsiSegment): string | undefined {
  return (
    cn(
      style.bold && "font-semibold",
      style.dim && "opacity-60",
      style.italic && "italic",
      style.underline && "underline",
      style.strike && "line-through",
    ) || undefined
  );
}

function Highlighted({ text, needle }: { text: string; needle: string }) {
  if (!needle) return text;
  const parts: { text: string; match: boolean; at: number }[] = [];
  const lower = text.toLowerCase();
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false, at: from });
    parts.push({ text: text.slice(at, at + needle.length), match: true, at });
    from = at + needle.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false, at: from });
  return parts.map((part) =>
    part.match ? (
      <mark key={part.at} className="rounded-[2px] bg-accent-subtle text-accent-text">
        {part.text}
      </mark>
    ) : (
      <span key={part.at}>{part.text}</span>
    ),
  );
}

/** Props for {@link AnsiText}. */
export interface AnsiTextProps {
  /** One raw line of terminal output. */
  text: string;
  /** Case-insensitive substring to highlight. */
  highlight?: string;
}

/**
 * Renders a line of terminal output with its ANSI colors, as React text nodes only:
 * escape sequences can style text but never inject markup, links or cursor movement.
 *
 * @param props - The raw line and an optional search term to highlight.
 * @returns The styled line.
 */
export const AnsiText = memo(function AnsiText({ text, highlight }: AnsiTextProps) {
  const needle = highlight?.toLowerCase() ?? "";
  return parseAnsi(text).map((segment, index) => (
    <span
      // biome-ignore lint/suspicious/noArrayIndexKey: segments derive from immutable text
      key={index}
      className={segmentClass(segment)}
      style={segmentStyle(segment)}
    >
      <Highlighted text={segment.text} needle={needle} />
    </span>
  ));
});
