/**
 * What log redaction looks for (ADR 0014 "Redaction"). The control plane
 * (runtime and build logs it ingests) and the agent (build output before it
 * leaves the node) redact the same strings: each secret of the deployment's
 * frozen secret set and the encodings a program is likely to print it in.
 * Mirrored by `RedactionNeedles` in `packages/protocol/go`; both sides check
 * `packages/protocol/fixtures/redaction.json`.
 *
 * @module
 */
import { MIN_REDACTABLE_SECRET_LENGTH } from "./variable-classifier";

/** What redacted text is replaced with. */
export const REDACTED = "[REDACTED]";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function utf8(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else {
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return out;
}

function base64(bytes: number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : "=";
    out += i + 2 < bytes.length ? B64[n & 63]! : "=";
  }
  return out;
}

// RFC 3986 unreserved characters stay as they are, like encodeURIComponent
// minus its extra `!'()*`, so Go's url.QueryEscape-style output can match.
function percentEncode(bytes: number[]): string {
  let out = "";
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    out += /[A-Za-z0-9\-._~]/.test(ch) ? ch : `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function jsonEscaped(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out;
}

/**
 * The strings to redact for a set of secrets: each secret as is, and its
 * standard base64 (padded and unpadded), base64url (unpadded), lowercase and
 * uppercase hex, percent-encoding and JSON string escaping. Secrets shorter
 * than {@link MIN_REDACTABLE_SECRET_LENGTH} are skipped (they would redact
 * ordinary words); encodings shorter than it too.
 *
 * Needles are de-duplicated and sorted longest first, so replacing them in
 * order never leaves part of a longer match behind.
 *
 * @param secrets - Plaintext secret values.
 * @returns Strings to replace with {@link REDACTED}.
 * @example
 * redactionNeedles(["hunter22"]).includes("aHVudGVyMjI="); // true (its base64)
 */
export function redactionNeedles(secrets: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of secrets) {
    if ([...s].length < MIN_REDACTABLE_SECRET_LENGTH) continue;
    const bytes = utf8(s);
    const b64 = base64(bytes);
    const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
    for (const needle of [
      s,
      b64,
      b64.replace(/=+$/, ""),
      b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
      hex,
      hex.toUpperCase(),
      percentEncode(bytes),
      jsonEscaped(s),
    ]) {
      if ([...needle].length >= MIN_REDACTABLE_SECRET_LENGTH) out.add(needle);
    }
  }
  // Ordered like Go's: UTF-8 length descending, then bytewise (code point
  // order, which UTF-16 comparison is not), so both sides list needles alike.
  const keyed = [...out].map((n) => ({ n, b: utf8(n) }));
  keyed.sort((x, y) => {
    if (x.b.length !== y.b.length) return y.b.length - x.b.length;
    for (let i = 0; i < x.b.length; i++) if (x.b[i] !== y.b[i]) return x.b[i]! - y.b[i]!;
    return 0;
  });
  return keyed.map((k) => k.n);
}

/**
 * Replaces every needle in a log line.
 *
 * @param text - One log line.
 * @param needles - From {@link redactionNeedles}, longest first.
 * @returns The line with each occurrence replaced by {@link REDACTED}.
 */
export function redact(text: string, needles: readonly string[]): string {
  let out = text;
  for (const n of needles) if (out.includes(n)) out = out.split(n).join(REDACTED);
  return out;
}
