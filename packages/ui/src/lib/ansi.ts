/**
 * A defensive ANSI escape parser for rendering untrusted log output.
 *
 * Only SGR sequences (`ESC [ … m`: colors, bold, underline …) become styles; every
 * other escape (cursor movement, OSC titles and hyperlinks, DCS, …) and every control
 * character except tab is dropped, so a log line can never move the cursor, inject
 * markup, open a link or hang the parser. The output is plain data: callers render
 * `text` as React text nodes and map styles to class names or numeric colors, never
 * HTML.
 *
 * Runs in O(n) over the input with no backtracking.
 *
 * @module
 */

/** A color picked by an SGR sequence. */
export type AnsiColor =
  /** One of the 16 theme colors (0-7 normal, 8-15 bright); see `--ansi-<n>` tokens. */
  | { kind: "palette"; index: number }
  /** A 256-color cube or truecolor value, each channel 0-255. */
  | { kind: "rgb"; r: number; g: number; b: number };

/** Text attributes in effect for a run of characters. */
export interface AnsiStyle {
  fg?: AnsiColor;
  bg?: AnsiColor;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
}

/** A run of text sharing one style. */
export interface AnsiSegment {
  text: string;
  style: AnsiStyle;
}

const ESC = 0x1b;
const BEL = 0x07;
const TAB = 0x09;
const CR = 0x0d;
const C1_CSI = 0x9b;
const C1_OSC = 0x9d;
const C1_ST = 0x9c;

/** SGR parameters beyond this are ignored, so a hostile line can't make one sequence costly. */
const MAX_SGR_PARAMS = 32;

function isControl(code: number): boolean {
  return (code < 0x20 && code !== TAB) || code === 0x7f || (code >= 0x80 && code <= 0x9f);
}

function cube(level: number): number {
  return level === 0 ? 0 : 55 + level * 40;
}

/**
 * Maps an xterm 256-color index to a color.
 *
 * @param n - Index 0-255.
 * @returns A palette color for 0-15, an RGB color otherwise.
 */
export function xterm256(n: number): AnsiColor {
  if (n < 16) return { kind: "palette", index: n };
  if (n < 232) {
    const i = n - 16;
    return {
      kind: "rgb",
      r: cube(Math.floor(i / 36)),
      g: cube(Math.floor(i / 6) % 6),
      b: cube(i % 6),
    };
  }
  const gray = 8 + (n - 232) * 10;
  return { kind: "rgb", r: gray, g: gray, b: gray };
}

function byte(value: number | undefined): number | null {
  return value !== undefined && Number.isInteger(value) && value >= 0 && value <= 255
    ? value
    : null;
}

/**
 * Reads an extended color (`38;5;n` or `38;2;r;g;b`) starting at `params[i]`, the 5 or 2.
 * Returns the color (or `null` when malformed) and how many params it consumed.
 */
function extendedColor(params: number[], i: number): [AnsiColor | null, number] {
  const mode = params[i];
  if (mode === 5) {
    const n = byte(params[i + 1]);
    return [n === null ? null : xterm256(n), 2];
  }
  if (mode === 2) {
    const r = byte(params[i + 1]);
    const g = byte(params[i + 2]);
    const b = byte(params[i + 3]);
    return [r === null || g === null || b === null ? null : { kind: "rgb", r, g, b }, 4];
  }
  return [null, 1];
}

function applySgr(style: AnsiStyle, raw: string): AnsiStyle {
  const params =
    raw === "" ? [0] : raw.split(/[;:]/, MAX_SGR_PARAMS).map((p) => (p === "" ? 0 : Number(p)));
  let next: AnsiStyle = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (!Number.isFinite(p)) continue;
    if (p === 0) next = {};
    else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 3) next.italic = true;
    else if (p === 4) next.underline = true;
    else if (p === 7) next.inverse = true;
    else if (p === 9) next.strike = true;
    else if (p === 21 || p === 22) {
      next.bold = false;
      next.dim = false;
    } else if (p === 23) next.italic = false;
    else if (p === 24) next.underline = false;
    else if (p === 27) next.inverse = false;
    else if (p === 29) next.strike = false;
    else if (p >= 30 && p <= 37) next.fg = { kind: "palette", index: p - 30 };
    else if (p === 39) next.fg = undefined;
    else if (p >= 40 && p <= 47) next.bg = { kind: "palette", index: p - 40 };
    else if (p === 49) next.bg = undefined;
    else if (p >= 90 && p <= 97) next.fg = { kind: "palette", index: p - 90 + 8 };
    else if (p >= 100 && p <= 107) next.bg = { kind: "palette", index: p - 100 + 8 };
    else if (p === 38 || p === 48) {
      const [color, used] = extendedColor(params, i + 1);
      if (color) {
        if (p === 38) next.fg = color;
        else next.bg = color;
      }
      i += used;
    }
  }
  return next;
}

/**
 * Index just past a string terminator (BEL, `ESC \` or C1 ST) at or after `from`, or the
 * input length when the sequence is never terminated.
 */
function skipToTerminator(input: string, from: number): number {
  for (let i = from; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code === BEL || code === C1_ST) return i + 1;
    if (code === ESC && input.charCodeAt(i + 1) === 0x5c) return i + 2;
  }
  return input.length;
}

/** Index just past a CSI sequence whose parameters start at `from`, plus its final byte. */
function readCsi(input: string, from: number): { end: number; params: string; final: string } {
  let i = from;
  while (i < input.length) {
    const code = input.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) {
      return { end: i + 1, params: input.slice(from, i), final: input[i]! };
    }
    // Parameter (0x30-0x3f) and intermediate (0x20-0x2f) bytes; anything else aborts.
    if (code < 0x20 || code > 0x3f) return { end: i, params: "", final: "" };
    i++;
  }
  return { end: input.length, params: "", final: "" };
}

/**
 * Splits a line of terminal output into styled text runs.
 *
 * Carriage returns behave like a terminal redrawing the line: only the text after the
 * last `\r` is kept (progress bars). Tabs are kept; all other control characters and
 * non-SGR escape sequences are removed.
 *
 * @param input - One raw log line.
 * @returns Runs of text with the style active for each. Empty runs are omitted.
 * @example
 * parseAnsi("\x1b[31merror\x1b[0m: boom");
 * // [{ text: "error", style: { fg: { kind: "palette", index: 1 } } }, { text: ": boom", style: {} }]
 */
export function parseAnsi(input: string): AnsiSegment[] {
  let line = input;
  const lastCr = line.lastIndexOf("\r");
  if (lastCr !== -1 && lastCr < line.length - 1) line = line.slice(lastCr + 1);

  const segments: AnsiSegment[] = [];
  let style: AnsiStyle = {};
  let text = "";
  const flush = () => {
    if (text) segments.push({ text, style });
    text = "";
  };

  let i = 0;
  while (i < line.length) {
    const code = line.charCodeAt(i);
    if (code === ESC || code === C1_CSI || code === C1_OSC) {
      const next = line.charCodeAt(i + 1);
      if (code === C1_CSI || next === 0x5b) {
        const csi = readCsi(line, code === C1_CSI ? i + 1 : i + 2);
        if (csi.final === "m" && !/[^0-9;:]/.test(csi.params)) {
          flush();
          style = applySgr(style, csi.params);
        }
        i = Math.max(csi.end, i + 1);
      } else if (code === C1_OSC || next === 0x5d) {
        i = skipToTerminator(line, code === C1_OSC ? i + 1 : i + 2);
      } else if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        // DCS, SOS, PM and APC strings, all ended by ST.
        i = skipToTerminator(line, i + 2);
      } else {
        i += Number.isNaN(next) ? 1 : 2;
      }
      continue;
    }
    if (code === CR || isControl(code)) {
      i++;
      continue;
    }
    text += line[i];
    i++;
  }
  flush();
  return segments;
}

/**
 * Removes every escape sequence and control character (except tab) from a line.
 *
 * @param input - One raw log line.
 * @returns The visible text, as {@link parseAnsi} would render it.
 * @example
 * stripAnsi("\x1b[1mbuild\x1b[0m ok"); // "build ok"
 */
export function stripAnsi(input: string): string {
  let out = "";
  for (const segment of parseAnsi(input)) out += segment.text;
  return out;
}

/**
 * CSS color for an ANSI color. Palette colors resolve to theme tokens; RGB values are
 * validated integers, so the result is always a well-formed constant.
 *
 * @param color - A color from {@link parseAnsi}.
 * @returns E.g. `"var(--ansi-1)"` or `"rgb(95 135 255)"`.
 */
export function ansiColorCss(color: AnsiColor): string {
  if (color.kind === "palette") return `var(--ansi-${Math.min(15, Math.max(0, color.index | 0))})`;
  return `rgb(${color.r | 0} ${color.g | 0} ${color.b | 0})`;
}
