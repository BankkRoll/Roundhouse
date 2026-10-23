package apitest

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"slices"
	"strings"
)

// classification is the fake's subset of classifyVariable in
// packages/shared/src/variable-classifier.ts: enough of each rule (public
// prefix, known credential format, secret-looking name) for the CLI's
// tests to meet every outcome the API can return.
type classification struct {
	secret   bool
	locked   bool
	public   string
	warnings []classifierWarning
}

type classifierWarning struct {
	code    string
	message string
}

type tierProblem struct {
	code    string
	message string
}

var (
	publicPrefixes    = []string{"NEXT_PUBLIC_", "VITE_", "PUBLIC_", "REACT_APP_"}
	credentialFormats = []string{"sk_live_", "sk_test_", "ghp_", "github_pat_", "sk-ant-", "-----BEGIN "}
	secretWords       = []string{"SECRET", "TOKEN", "PASSWORD", "PASSWD", "CREDENTIALS", "APIKEY"}
	trailingWords     = []string{"KEY", "PASS", "PWD"}
)

func looksLikeCredential(value string) bool {
	return slices.ContainsFunc(credentialFormats, func(p string) bool { return strings.HasPrefix(value, p) })
}

func secretName(key string) bool {
	if key == "DATABASE_URL" {
		return true
	}
	words := strings.Split(strings.ToUpper(key), "_")
	if slices.ContainsFunc(words, func(w string) bool { return slices.Contains(secretWords, w) }) {
		return true
	}
	return slices.Contains(trailingWords, words[len(words)-1])
}

func classify(key, value string) classification {
	for _, p := range publicPrefixes {
		if strings.HasPrefix(key, p) {
			c := classification{locked: true, public: p}
			if looksLikeCredential(value) {
				c.warnings = append(c.warnings, classifierWarning{"public_prefix_secret_value",
					key + " looks like a credential, but " + p + " variables are bundled into the browser"})
			}
			return c
		}
	}
	if looksLikeCredential(value) {
		return classification{secret: true, locked: true}
	}
	return classification{secret: secretName(key)}
}

// decideTier mirrors decideVariableTier: a lock can't be overridden, an
// unrequested write keeps an existing secret secret, and a secret only
// becomes plain with its value re-entered.
func decideTier(c classification, requested string, prior *variable, valueProvided bool) (secret bool, problem *tierProblem) {
	if c.locked {
		if requested != "" && (requested == "secret") != c.secret {
			msg := "This value is a recognised credential and must stay secret"
			if c.public != "" {
				msg = c.public + " variables are public and can't be secret"
			}
			return false, &tierProblem{"tier_locked", msg}
		}
		return c.secret, nil
	}
	secret = c.secret
	switch {
	case requested != "":
		secret = requested == "secret"
	case prior != nil && prior.secret:
		secret = true
	}
	if prior != nil && prior.secret && !secret && !valueProvided {
		return false, &tierProblem{"value_required", "Re-enter the value to make a secret plain"}
	}
	return secret, nil
}

// fingerprintKey stands in for the per-project key the API derives from the
// project's data key.
var fingerprintKey = []byte("apitest-fingerprint-key")

// fingerprint is 8 hex characters of an HMAC of value, like the API's
// variableFingerprint.
func fingerprint(value string) string {
	m := hmac.New(sha256.New, fingerprintKey)
	m.Write([]byte(value))
	return hex.EncodeToString(m.Sum(nil))[:8]
}

// Fingerprint returns the fingerprint the fake lists for value.
func Fingerprint(value string) string { return fingerprint(value) }
