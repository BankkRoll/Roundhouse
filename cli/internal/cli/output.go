package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"text/tabwriter"
	"time"
)

// writeJSON encodes v with two-space indentation. Field order follows the
// struct definitions, so --json output is stable across releases.
func writeJSON(w io.Writer, v any) {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

// writeJSONLine encodes v on one line, for streamed (NDJSON) output.
func writeJSONLine(w io.Writer, v any) {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

// printJSON writes v to stdout as JSON.
func (a *App) printJSON(v any) error {
	writeJSON(a.IO.Out, v)
	return nil
}

// table writes aligned columns to stdout.
type table struct {
	tw *tabwriter.Writer
}

func (a *App) newTable(headers ...string) *table {
	t := &table{tw: tabwriter.NewWriter(a.IO.Out, 0, 0, 3, ' ', 0)}
	if len(headers) > 0 {
		for i, h := range headers {
			headers[i] = strings.ToUpper(h)
		}
		// Colour codes would skew tabwriter's widths, so the header stays plain.
		fmt.Fprintln(t.tw, strings.Join(headers, "\t"))
	}
	return t
}

func (t *table) row(cols ...string) {
	fmt.Fprintln(t.tw, strings.Join(cols, "\t"))
}

func (t *table) flush() {
	_ = t.tw.Flush()
}

// millis converts an API timestamp to a time.
func millis(ms int64) time.Time {
	return time.UnixMilli(ms).UTC()
}

// ago renders a timestamp relative to now, e.g. "3m ago".
func ago(now time.Time, ms int64) string {
	d := now.Sub(millis(ms))
	switch {
	case d < 0:
		return "just now"
	case d < time.Minute:
		return fmt.Sprintf("%ds ago", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}
