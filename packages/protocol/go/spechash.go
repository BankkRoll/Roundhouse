package protocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
)

// SpecHashExcludedFields are the WorkloadSpec fields left out of the spec
// hash: they apply without recreating the container (routes via Caddy, drain
// on the next switch) or rotate often (registry credentials). Mirrors
// SPEC_HASH_EXCLUDED_FIELDS in TypeScript.
var SpecHashExcludedFields = []string{"spec_hash", "routes", "registry_auth", "drain_s"}

// ComputeSpecHash returns w's spec hash: lowercase hex SHA-256 of the
// canonical JSON of w without [SpecHashExcludedFields]. It matches the
// TypeScript computeSpecHash for every valid spec, which the spec-hash
// fixture verifies. Any existing w.SpecHash is ignored.
func ComputeSpecHash(w WorkloadSpec) (string, error) {
	input, err := SpecHashInput(w)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(input))
	return hex.EncodeToString(sum[:]), nil
}

// SpecHashInput returns the canonical text [ComputeSpecHash] hashes.
func SpecHashInput(w WorkloadSpec) (string, error) {
	// NOTE: encoding/json writes nil maps and slices as null, which canonical
	// form drops, while TypeScript always has {} or []. Normalise the
	// required collections so both sides hash the same members.
	if w.Env == nil {
		w.Env = map[string]string{}
	}
	if w.Labels == nil {
		w.Labels = map[string]string{}
	}
	if w.Ports == nil {
		w.Ports = []WorkloadPort{}
	}
	raw, err := json.Marshal(w)
	if err != nil {
		return "", err
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var obj map[string]any
	if err := dec.Decode(&obj); err != nil {
		return "", err
	}
	for _, f := range SpecHashExcludedFields {
		delete(obj, f)
	}
	return CanonicalJSON(obj)
}

// CanonicalJSON serialises v (as produced by decoding JSON into any with
// UseNumber, or plain Go maps, slices, strings, bools and integers) in the
// canonical form shared with the TypeScript canonicalJson:
//
//   - object members sorted by key, comparing UTF-16 code units;
//   - members whose value is null omitted;
//   - numbers must be integers within ±(2^53-1), printed in decimal;
//   - strings escape only '"', '\' and U+0000–U+001F (as \u00xx); everything
//     else, U+2028 and U+2029 included, is literal UTF-8;
//   - no whitespace.
func CanonicalJSON(v any) (string, error) {
	var b strings.Builder
	if err := writeCanonical(&b, v); err != nil {
		return "", err
	}
	return b.String(), nil
}

const maxSafeInteger = 1<<53 - 1

func writeCanonical(b *strings.Builder, v any) error {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		b.WriteString(strconv.FormatBool(x))
	case string:
		writeCanonicalString(b, x)
	case json.Number:
		n, err := strconv.ParseInt(string(x), 10, 64)
		if err != nil {
			return fmt.Errorf("canonical json: non-integer number %s", x)
		}
		return writeInt(b, n)
	case int:
		return writeInt(b, int64(x))
	case int64:
		return writeInt(b, x)
	case []any:
		b.WriteByte('[')
		for i, item := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := writeCanonical(b, item); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(x))
		for k, item := range x {
			if item != nil {
				keys = append(keys, k)
			}
		}
		slices.SortFunc(keys, compareUTF16)
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			writeCanonicalString(b, k)
			b.WriteByte(':')
			if err := writeCanonical(b, x[k]); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	default:
		return fmt.Errorf("canonical json: unsupported type %T", v)
	}
	return nil
}

func writeInt(b *strings.Builder, n int64) error {
	if n > maxSafeInteger || n < -maxSafeInteger {
		return fmt.Errorf("canonical json: integer %d outside the safe range", n)
	}
	b.WriteString(strconv.FormatInt(n, 10))
	return nil
}

func writeCanonicalString(b *strings.Builder, s string) {
	const hexDigits = "0123456789abcdef"
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			b.WriteString(`\"`)
		case r == '\\':
			b.WriteString(`\\`)
		case r < 0x20:
			b.WriteString(`\u00`)
			b.WriteByte(hexDigits[r>>4])
			b.WriteByte(hexDigits[r&0xf])
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
}

// compareUTF16 orders strings as JavaScript's default sort does.
func compareUTF16(a, b string) int {
	return slices.Compare(utf16.Encode([]rune(a)), utf16.Encode([]rune(b)))
}
