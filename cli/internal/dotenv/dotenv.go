// Package dotenv reads and writes .env files.
//
// Values are taken literally: there is no `$VAR` or `${VAR}` interpolation,
// so Roundhouse references such as `${{db.DATABASE_URL}}` pass through
// untouched in both directions.
//
// Accepted syntax, one assignment per line:
//
//	KEY=value             # unquoted; " #" starts a comment; whitespace is trimmed
//	export KEY=value      # optional `export` prefix
//	KEY='literal'         # single quotes: no escapes, may span lines
//	KEY="a\nb \"c\" \$"   # double quotes: \n \r \t \" \\ \$ escapes, may span lines
//	# comment
package dotenv

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// KeyPattern matches a valid variable name; it equals ENV_KEY_RE in
// packages/protocol.
var KeyPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Entry is one KEY=VALUE assignment.
type Entry struct {
	Key   string
	Value string
}

// Parse reads .env content. A key assigned twice keeps its last value at the
// position of its first assignment.
func Parse(content string) ([]Entry, error) {
	s := strings.ReplaceAll(strings.TrimPrefix(content, "\ufeff"), "\r\n", "\n")
	var out []Entry
	index := map[string]int{}
	line := 1
	for p := 0; p < len(s); {
		eol := strings.IndexByte(s[p:], '\n')
		if eol < 0 {
			eol = len(s)
		} else {
			eol += p
		}
		raw := s[p:eol]
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			p, line = eol+1, line+1
			continue
		}
		eq := strings.IndexByte(raw, '=')
		if eq < 0 {
			return nil, fmt.Errorf("line %d: expected KEY=VALUE", line)
		}
		key := strings.TrimSpace(raw[:eq])
		if rest, ok := strings.CutPrefix(key, "export"); ok && rest != "" && (rest[0] == ' ' || rest[0] == '\t') {
			key = strings.TrimSpace(rest)
		}
		if !KeyPattern.MatchString(key) {
			return nil, fmt.Errorf("line %d: invalid variable name %q", line, key)
		}
		start := p + eq + 1
		for start < len(s) && (s[start] == ' ' || s[start] == '\t') {
			start++
		}
		value, n, err := parseValue(s[start:])
		if err != nil {
			return nil, fmt.Errorf("line %d: %w", line, err)
		}
		line += strings.Count(s[p:start+n], "\n")
		p = start + n
		if i, dup := index[key]; dup {
			out[i].Value = value
		} else {
			index[key] = len(out)
			out = append(out, Entry{Key: key, Value: value})
		}
	}
	return out, nil
}

// parseValue parses the value at the start of s. It returns the value and
// the bytes consumed, through the newline ending the value's last line.
func parseValue(s string) (string, int, error) {
	if s == "" {
		return "", 0, nil
	}
	switch s[0] {
	case '\'':
		end := strings.IndexByte(s[1:], '\'')
		if end < 0 {
			return "", 0, errors.New("unterminated single-quoted value")
		}
		n, err := afterQuote(s, end+2)
		return s[1 : end+1], n, err
	case '"':
		var b strings.Builder
		for i := 1; i < len(s); i++ {
			c := s[i]
			if c == '"' {
				n, err := afterQuote(s, i+1)
				return b.String(), n, err
			}
			if c == '\\' && i+1 < len(s) {
				i++
				switch s[i] {
				case 'n':
					b.WriteByte('\n')
				case 'r':
					b.WriteByte('\r')
				case 't':
					b.WriteByte('\t')
				case '"', '\\', '$', '\'':
					b.WriteByte(s[i])
				default:
					b.WriteByte('\\')
					b.WriteByte(s[i])
				}
				continue
			}
			b.WriteByte(c)
		}
		return "", 0, errors.New("unterminated double-quoted value")
	}
	line, _, found := strings.Cut(s, "\n")
	n := len(line)
	if found {
		n++
	}
	for _, marker := range []string{" #", "\t#"} {
		if i := strings.Index(line, marker); i >= 0 {
			line = line[:i]
		}
	}
	return strings.TrimSpace(line), n, nil
}

// afterQuote checks that only whitespace or a comment follows a closing
// quote at s[i:] on its line, and returns the bytes consumed through the
// newline.
func afterQuote(s string, i int) (int, error) {
	rest, _, found := strings.Cut(s[i:], "\n")
	if t := strings.TrimSpace(rest); t != "" && !strings.HasPrefix(t, "#") {
		return 0, fmt.Errorf("unexpected %q after closing quote", t)
	}
	n := i + len(rest)
	if found {
		n++
	}
	return n, nil
}

// Format renders entries as .env lines, quoting only when needed so the
// output parses back to the same values.
func Format(entries []Entry) string {
	var b strings.Builder
	for _, e := range entries {
		b.WriteString(e.Key)
		b.WriteByte('=')
		b.WriteString(Quote(e.Value))
		b.WriteByte('\n')
	}
	return b.String()
}

// Quote renders a value for a .env file: bare when it is plain, in single
// quotes when that needs no escapes (so references keep their exact text),
// and in double quotes with escapes otherwise.
func Quote(v string) string {
	if v == "" {
		return ""
	}
	plain := true
	for _, r := range v {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("_-.,/:@+=%", r)) {
			plain = false
			break
		}
	}
	if plain {
		return v
	}
	if !strings.ContainsAny(v, "'\n\r") {
		return "'" + v + "'"
	}
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`, "\r", `\r`, "$", `\$`)
	return `"` + r.Replace(v) + `"`
}
