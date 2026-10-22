package builder

import (
	"encoding/base64"
	"regexp"
	"slices"
	"strings"
)

// redactedText replaces every secret in build output and error messages.
const redactedText = "********"

// minSecretLen is the shortest value redacted. Shorter values ("1", "on")
// would mangle unrelated output while protecting nothing.
const minSecretLen = 4

// secretArgName matches build argument names whose values are treated as
// secret. BuildJob does not mark secret build args, so this is a heuristic
// on top of the control plane's own redaction of known secret values.
var secretArgName = regexp.MustCompile(`(?i)(secret|token|passw|pwd|private|credential|api_?key|access_?key|auth|signing|cookie|session|dsn|database_url|_key$)`)

// redactor replaces known secret values in text.
type redactor struct {
	// secrets is sorted longest first so a secret containing another is
	// replaced whole.
	secrets []string
}

// newRedactor returns a redactor for the job's git token and the values of
// secret-looking build args. Encodings a token takes on the wire (HTTP Basic
// credentials) are redacted too.
func newRedactor(token string, buildArgs map[string]string) *redactor {
	r := &redactor{}
	if token != "" {
		r.add(token)
		r.add(base64.StdEncoding.EncodeToString([]byte(gitTokenUser + ":" + token)))
		r.add(base64.StdEncoding.EncodeToString([]byte(token)))
	}
	for k, v := range buildArgs {
		if secretArgName.MatchString(k) {
			r.add(v)
			// A value spanning lines is printed one line at a time.
			for line := range strings.SplitSeq(v, "\n") {
				r.add(strings.TrimSpace(line))
			}
		}
	}
	return r
}

func (r *redactor) add(s string) {
	if len(s) < minSecretLen || slices.Contains(r.secrets, s) {
		return
	}
	r.secrets = append(r.secrets, s)
	slices.SortFunc(r.secrets, func(a, b string) int { return len(b) - len(a) })
}

// redact returns s with every secret replaced by [redactedText].
func (r *redactor) redact(s string) string {
	if r == nil {
		return s
	}
	for _, secret := range r.secrets {
		if strings.Contains(s, secret) {
			s = strings.ReplaceAll(s, secret, redactedText)
		}
	}
	return s
}
