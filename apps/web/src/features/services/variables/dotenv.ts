/**
 * A small, strict `.env` parser for the bulk-paste dialog.
 *
 * Supports `KEY=value`, `export KEY=value`, blank lines, `#` comments (whole-line, or
 * after whitespace in unquoted values), single quotes (literal) and double quotes (with
 * `\n`, `\t`, `\"` and `\\` escapes, possibly spanning lines). Anything else is reported
 * with its line number rather than guessed at.
 *
 * @module
 */
import { VARIABLE_NAME_RE } from "@openrail/shared";

/** One parsed assignment. */
export interface DotenvEntry {
  key: string;
  value: string;
  /** 1-based line where the assignment starts. */
  line: number;
}

/** A line that could not be parsed. */
export interface DotenvError {
  line: number;
  message: string;
}

/** Result of {@link parseDotenv}. */
export interface DotenvResult {
  /** Assignments in order; a repeated key keeps its last value. */
  entries: DotenvEntry[];
  errors: DotenvError[];
}

const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

/**
 * Parses `.env` text.
 *
 * @param text - Pasted file contents.
 * @returns Entries (last one wins per key) and per-line errors.
 * @example
 * parseDotenv('PORT=8080\n# comment\nexport NAME="a b"').entries;
 * // [{ key: "PORT", value: "8080", line: 1 }, { key: "NAME", value: "a b", line: 3 }]
 */
export function parseDotenv(text: string): DotenvResult {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const byKey = new Map<string, DotenvEntry>();
  const errors: DotenvError[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const statement = trimmed.replace(/^export\s+/, "");
    const eq = statement.indexOf("=");
    if (eq <= 0) {
      errors.push({ line: lineNumber, message: "Expected KEY=value" });
      continue;
    }
    const key = statement.slice(0, eq).trim();
    if (!VARIABLE_NAME_RE.test(key)) {
      errors.push({ line: lineNumber, message: `"${key}" is not a valid variable name` });
      continue;
    }
    let rest = statement.slice(eq + 1).trimStart();
    let value: string;

    if (rest.startsWith('"')) {
      let out = "";
      let closed = false;
      let j = 1;
      // A double-quoted value may continue on following lines until its closing quote.
      while (!closed) {
        for (; j < rest.length; j++) {
          const ch = rest[j]!;
          if (ch === "\\" && j + 1 < rest.length) {
            const next = rest[j + 1]!;
            out += ESCAPES[next] ?? `\\${next}`;
            j++;
          } else if (ch === '"') {
            closed = true;
            break;
          } else {
            out += ch;
          }
        }
        if (closed || i + 1 >= lines.length) break;
        i++;
        out += "\n";
        rest = `"${lines[i] ?? ""}`;
        j = 1;
      }
      if (!closed) {
        errors.push({ line: lineNumber, message: "Unterminated double quote" });
        continue;
      }
      const after = rest.slice(j + 1).trim();
      if (after && !after.startsWith("#")) {
        errors.push({ line: lineNumber, message: "Unexpected text after the closing quote" });
        continue;
      }
      value = out;
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      if (end === -1) {
        errors.push({ line: lineNumber, message: "Unterminated single quote" });
        continue;
      }
      const after = rest.slice(end + 1).trim();
      if (after && !after.startsWith("#")) {
        errors.push({ line: lineNumber, message: "Unexpected text after the closing quote" });
        continue;
      }
      value = rest.slice(1, end);
    } else {
      const comment = rest.search(/\s#/);
      value = (comment === -1 ? rest : rest.slice(0, comment)).trim();
    }
    byKey.delete(key);
    byKey.set(key, { key, value, line: lineNumber });
  }

  return { entries: [...byKey.values()], errors };
}
