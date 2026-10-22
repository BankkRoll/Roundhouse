package dotenv

import (
	"reflect"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	in := "\ufeff# leading comment\r\n" +
		"PLAIN=hello world  # trailing comment\n" +
		"export EXPORTED=1\n" +
		"  INDENTED = spaced  \n" +
		"EMPTY=\n" +
		"SINGLE='a \"b\" ${{db.URL}} # not a comment'\n" +
		"DOUBLE=\"line1\\nline2 \\\"q\\\" \\$HOME\"\n" +
		"MULTI='first\nsecond'\n" +
		"REF=${{shared.REGION}}\n" +
		"HASH=abc#def\n" +
		"PLAIN=again\n"
	got, err := Parse(in)
	if err != nil {
		t.Fatal(err)
	}
	want := []Entry{
		{"PLAIN", "again"},
		{"EXPORTED", "1"},
		{"INDENTED", "spaced"},
		{"EMPTY", ""},
		{"SINGLE", `a "b" ${{db.URL}} # not a comment`},
		{"DOUBLE", "line1\nline2 \"q\" $HOME"},
		{"MULTI", "first\nsecond"},
		{"REF", "${{shared.REGION}}"},
		{"HASH", "abc#def"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Parse:\n got %q\nwant %q", got, want)
	}
}

func TestParseErrors(t *testing.T) {
	for in, want := range map[string]string{
		"NOVALUE\n":        "line 1: expected KEY=VALUE",
		"A=1\n1BAD=x\n":    `line 2: invalid variable name "1BAD"`,
		"A='open\n":        "line 1: unterminated single-quoted value",
		"A=\"open\n":       "line 1: unterminated double-quoted value",
		"A='x' trailing\n": `line 1: unexpected "trailing" after closing quote`,
		"A='x\ny'\nB\n":    "line 3: expected KEY=VALUE",
	} {
		_, err := Parse(in)
		if err == nil || err.Error() != want {
			t.Errorf("Parse(%q) error = %v, want %q", in, err, want)
		}
	}
}

func TestFormatRoundTrip(t *testing.T) {
	entries := []Entry{
		{"A", "plain-value_1.2:3/4@x"},
		{"B", "has space"},
		{"C", "${{api.DATABASE_URL}}"},
		{"D", "it's \"quoted\"\nand $multi"},
		{"E", ""},
		{"F", `back\slash`},
		{"G", "tab\there # hash"},
	}
	out := Format(entries)
	if !strings.Contains(out, "C='${{api.DATABASE_URL}}'\n") {
		t.Errorf("reference not single-quoted verbatim:\n%s", out)
	}
	got, err := Parse(out)
	if err != nil {
		t.Fatalf("Parse(Format()) error: %v\n%s", err, out)
	}
	if !reflect.DeepEqual(got, entries) {
		t.Fatalf("round trip:\n got %q\nwant %q\n%s", got, entries, out)
	}
}
