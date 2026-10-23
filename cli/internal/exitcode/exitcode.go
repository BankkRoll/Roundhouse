// Package exitcode defines the process exit codes of the roundhouse CLI.
//
// The codes are part of the CLI's public contract: scripts branch on them, so
// a value never changes meaning once released. New conditions get new codes.
package exitcode

import (
	"context"
	"errors"
	"fmt"
)

// Exit codes. Values are stable; see the package doc.
const (
	// OK means the command succeeded.
	OK = 0
	// Error is any failure without a more specific code.
	Error = 1
	// Usage means the command line was invalid: unknown flag, wrong arguments.
	Usage = 2
	// Unauthenticated means there is no valid session for the control plane.
	Unauthenticated = 3
	// Forbidden means the caller's role does not allow the action.
	Forbidden = 4
	// NotFound means the resource does not exist or is not visible.
	NotFound = 5
	// Conflict means the resource is in a state that forbids the action.
	Conflict = 6
	// Invalid means the API rejected the request body or a value.
	Invalid = 7
	// DeploymentFailed means a watched deployment ended failed, crashed or cancelled.
	DeploymentFailed = 8
	// NotLinked means the directory is not linked and no flags named a target.
	NotLinked = 9
	// Unavailable means the control plane does not offer the feature yet.
	Unavailable = 10
	// Network means the control plane could not be reached or failed (5xx).
	Network = 11
	// InputRequired means a prompt was needed but the session is non-interactive.
	InputRequired = 12
	// ProvisionFailed means a watched cloud server provisioning run failed.
	ProvisionFailed = 13
	// Interrupted means the user pressed Ctrl-C (128 + SIGINT, as shells report it).
	Interrupted = 130
)

// Coder is implemented by errors that carry their own exit code.
type Coder interface {
	ExitCode() int
}

// codedError attaches an exit code to an error.
type codedError struct {
	code   int
	err    error
	silent bool
}

// Error returns the wrapped message.
func (e *codedError) Error() string {
	if e.err == nil {
		return fmt.Sprintf("exit status %d", e.code)
	}
	return e.err.Error()
}

// Unwrap returns the wrapped error.
func (e *codedError) Unwrap() error { return e.err }

// ExitCode returns the attached code.
func (e *codedError) ExitCode() int { return e.code }

// New returns an error with a formatted message and the given exit code.
func New(code int, format string, args ...any) error {
	return &codedError{code: code, err: fmt.Errorf(format, args...)}
}

// Wrap attaches an exit code to err. It returns nil when err is nil.
func Wrap(code int, err error) error {
	if err == nil {
		return nil
	}
	return &codedError{code: code, err: err}
}

// Silent returns an error that sets the exit code but prints nothing, for
// example when `roundhouse run` mirrors its child's exit status.
func Silent(code int) error {
	return &codedError{code: code, silent: true}
}

// IsSilent reports whether err should be reported only through the exit code.
func IsSilent(err error) bool {
	var c *codedError
	return errors.As(err, &c) && c.silent
}

// Of returns the exit code for err: OK for nil, the code of the first
// [Coder] in its chain, Interrupted for a cancelled context, Error otherwise.
func Of(err error) int {
	if err == nil {
		return OK
	}
	var c Coder
	if errors.As(err, &c) {
		return c.ExitCode()
	}
	if errors.Is(err, context.Canceled) {
		return Interrupted
	}
	return Error
}
