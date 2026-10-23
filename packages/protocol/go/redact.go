package protocol

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"
)

// Redacted replaces redacted text. Mirrors REDACTED in @roundhouse/shared.
const Redacted = "[REDACTED]"

// MinRedactableSecretLength is the shortest secret (in code points) that is
// redacted. Mirrors MIN_REDACTABLE_SECRET_LENGTH in @roundhouse/shared.
const MinRedactableSecretLength = 6

// RedactionNeedles returns the strings to redact for secrets: each secret,
// its standard base64 (padded and unpadded), base64url (unpadded), lower and
// upper hex, percent-encoding (RFC 3986 unreserved kept) and JSON string
// escaping, longest first. Mirrors redactionNeedles in @roundhouse/shared;
// fixtures/redaction.json pins both.
func RedactionNeedles(secrets []string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(n string) {
		if utf8.RuneCountInString(n) >= MinRedactableSecretLength && !seen[n] {
			seen[n] = true
			out = append(out, n)
		}
	}
	for _, s := range secrets {
		if utf8.RuneCountInString(s) < MinRedactableSecretLength {
			continue
		}
		b := []byte(s)
		h := hex.EncodeToString(b)
		add(s)
		add(base64.StdEncoding.EncodeToString(b))
		add(base64.RawStdEncoding.EncodeToString(b))
		add(base64.RawURLEncoding.EncodeToString(b))
		add(h)
		add(strings.ToUpper(h))
		add(percentEncode(b))
		add(jsonEscape(s))
	}
	slices.SortFunc(out, func(a, b string) int {
		if len(a) != len(b) {
			return len(b) - len(a)
		}
		return strings.Compare(a, b)
	})
	return out
}

// Redact replaces every needle in text with [Redacted]. Needles must come
// from [RedactionNeedles], longest first.
func Redact(text string, needles []string) string {
	for _, n := range needles {
		if strings.Contains(text, n) {
			text = strings.ReplaceAll(text, n, Redacted)
		}
	}
	return text
}

func percentEncode(b []byte) string {
	var sb strings.Builder
	for _, c := range b {
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '.' || c == '_' || c == '~' {
			sb.WriteByte(c)
		} else {
			fmt.Fprintf(&sb, "%%%02X", c)
		}
	}
	return sb.String()
}

// jsonEscape escapes like JSON.stringify inside the quotes, which (unlike
// encoding/json) leaves <, >, & and U+2028/U+2029 literal.
func jsonEscape(s string) string {
	var sb strings.Builder
	for _, r := range s {
		switch {
		case r == '"':
			sb.WriteString(`\"`)
		case r == '\\':
			sb.WriteString(`\\`)
		case r == '\n':
			sb.WriteString(`\n`)
		case r == '\r':
			sb.WriteString(`\r`)
		case r == '\t':
			sb.WriteString(`\t`)
		case r == '\b':
			sb.WriteString(`\b`)
		case r == '\f':
			sb.WriteString(`\f`)
		case r < 0x20:
			fmt.Fprintf(&sb, `\u%04x`, r)
		default:
			sb.WriteRune(r)
		}
	}
	return sb.String()
}
