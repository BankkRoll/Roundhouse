package dbquery

import (
	"strings"
)

// quotePostgresIdent quotes an identifier for Postgres.
func quotePostgresIdent(s string) string {
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

// quotePostgresString quotes s as a Postgres string literal that reads the
// same whether or not standard_conforming_strings is on: a backslash makes
// it an escape string (E'…') with the backslashes doubled.
func quotePostgresString(s string) string {
	q := `'` + strings.ReplaceAll(s, `'`, `''`) + `'`
	if strings.Contains(s, `\`) {
		return `E` + strings.ReplaceAll(q, `\`, `\\`)
	}
	return q
}

// quoteMySQLIdent quotes an identifier for MySQL.
func quoteMySQLIdent(s string) string {
	return "`" + strings.ReplaceAll(s, "`", "``") + "`"
}

// quoteMySQLString quotes s as a MySQL string literal. noBackslashEscapes
// is whether the session's sql_mode has NO_BACKSLASH_ESCAPES, where a
// backslash is an ordinary character.
func quoteMySQLString(s string, noBackslashEscapes bool) string {
	var b strings.Builder
	b.Grow(len(s) + 2)
	b.WriteByte('\'')
	for _, r := range s {
		switch {
		case r == '\'':
			b.WriteString("''")
		case noBackslashEscapes:
			b.WriteRune(r)
		case r == '\\':
			b.WriteString(`\\`)
		case r == 0:
			b.WriteString(`\0`)
		case r == '\n':
			b.WriteString(`\n`)
		case r == '\r':
			b.WriteString(`\r`)
		case r == 0x1a:
			b.WriteString(`\Z`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('\'')
	return b.String()
}

// validIdent reports whether s can name a table, schema or column: present,
// short enough, and free of NUL.
func validIdent(s string) bool {
	return s != "" && len(s) <= 256 && !strings.ContainsRune(s, 0)
}
