package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/BankkRoll/Open-Rail/cli/internal/exitcode"
)

// ErrorDetail is one problem inside a request, such as a malformed `${{…}}`
// reference. Start and End are offsets into the field's value in UTF-16 code
// units, as JavaScript counts them; see [UTF16Span].
type ErrorDetail struct {
	Field   string `json:"field"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Start   *int   `json:"start,omitempty"`
	End     *int   `json:"end,omitempty"`
}

// Error is a non-2xx response from the control plane.
type Error struct {
	// Status is the HTTP status code.
	Status int `json:"status"`
	// Code is the API's stable machine-readable code, e.g. "not_found".
	Code    string        `json:"code"`
	Message string        `json:"message"`
	Details []ErrorDetail `json:"details,omitempty"`
}

// Error returns the API's message, or the status text when it sent none.
func (e *Error) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("%d %s", e.Status, http.StatusText(e.Status))
	}
	return e.Message
}

// ExitCode maps the HTTP status to a stable CLI exit code.
func (e *Error) ExitCode() int {
	switch {
	case e.Status == http.StatusUnauthorized:
		return exitcode.Unauthenticated
	case e.Status == http.StatusForbidden:
		return exitcode.Forbidden
	case e.Status == http.StatusNotFound:
		return exitcode.NotFound
	case e.Status == http.StatusConflict:
		return exitcode.Conflict
	case e.Status == http.StatusBadRequest || e.Status == http.StatusRequestEntityTooLarge ||
		e.Status == http.StatusUnprocessableEntity:
		return exitcode.Invalid
	case e.Status >= 500:
		return exitcode.Network
	default:
		return exitcode.Error
	}
}

// IsStatus reports whether err is an [*Error] with the given HTTP status.
func IsStatus(err error, status int) bool {
	var e *Error
	return errors.As(err, &e) && e.Status == status
}

// NetworkError means the control plane could not be reached or did not
// answer with HTTP.
type NetworkError struct {
	URL string
	Err error
}

// Error names the unreachable control plane and the cause.
func (e *NetworkError) Error() string {
	return fmt.Sprintf("cannot reach %s: %v", e.URL, e.Err)
}

// Unwrap returns the transport error.
func (e *NetworkError) Unwrap() error { return e.Err }

// ExitCode is always [exitcode.Network].
func (e *NetworkError) ExitCode() int { return exitcode.Network }

// parseError decodes an error body. The API uses `{error:{code,message,
// details}}`; Better Auth answers `/api/auth/*` with a flat `{code,message}`.
// Anything else falls back to the status text.
func parseError(status int, body []byte) *Error {
	e := &Error{Status: status}
	var envelope struct {
		Error *struct {
			Code    string        `json:"code"`
			Message string        `json:"message"`
			Details []ErrorDetail `json:"details"`
		} `json:"error"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &envelope) == nil {
		switch {
		case envelope.Error != nil:
			e.Code, e.Message, e.Details = envelope.Error.Code, envelope.Error.Message, envelope.Error.Details
		case envelope.Message != "":
			e.Code, e.Message = strings.ToLower(envelope.Code), envelope.Message
		}
	}
	if e.Message == "" {
		e.Message = fmt.Sprintf("%d %s", status, http.StatusText(status))
	}
	return e
}

// UTF16Span converts a span given in UTF-16 code units, as the API reports
// it, into byte offsets into s. Offsets past the end clamp to len(s).
func UTF16Span(s string, start, end int) (int, int) {
	return utf16ToByte(s, start), utf16ToByte(s, end)
}

func utf16ToByte(s string, units int) int {
	n := 0
	for i, r := range s {
		if n >= units {
			return i
		}
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return len(s)
}
