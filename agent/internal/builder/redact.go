package builder

import (
	"encoding/base64"
	"strings"

	protocol "github.com/BankkRoll/Roundhouse/packages/protocol/go"
)

// redactedText replaces every secret in build output and error messages; it
// is the marker the control plane uses for runtime logs.
const redactedText = protocol.Redacted

// redactor replaces a job's secret values, and the encodings they take in
// output, in text.
type redactor struct {
	// needles come from [protocol.RedactionNeedles], longest first, so a
	// secret containing another is replaced whole.
	needles []string
}

// newRedactor returns a redactor for the job's git token and its secret
// values: the build args the job marks secret and the opened
// build_secrets_sealed. Only values the job declares secret are redacted;
// names are never guessed at (ADR 0014, "Redaction").
//
// Each value is redacted in every encoding [protocol.RedactionNeedles]
// covers, each line of a multi-line value on its own (build output is
// printed a line at a time), and the token also as the HTTP Basic
// credentials git sends.
func newRedactor(token string, secrets []string) *redactor {
	var values []string
	if token != "" {
		values = append(values, token, gitTokenUser+":"+token,
			base64.StdEncoding.EncodeToString([]byte(gitTokenUser+":"+token)))
	}
	for _, v := range secrets {
		values = append(values, v)
		for line := range strings.SplitSeq(v, "\n") {
			values = append(values, strings.TrimSpace(line))
		}
	}
	return &redactor{needles: protocol.RedactionNeedles(values)}
}

// redact returns s with every secret replaced by [redactedText].
func (r *redactor) redact(s string) string {
	if r == nil {
		return s
	}
	return protocol.Redact(s, r.needles)
}

// jobSecrets returns the values of the job's secret build args followed by
// its sealed secrets.
func jobSecrets(job *protocol.BuildJob, sealed map[string]string) []string {
	var out []string
	for _, k := range job.SecretBuildArgs {
		out = append(out, job.BuildArgs[k])
	}
	for _, v := range sealed {
		out = append(out, v)
	}
	return out
}
