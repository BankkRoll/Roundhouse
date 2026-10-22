package builder

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	protocol "github.com/BankkRoll/Open-Rail/packages/protocol/go"
)

// userError is a failure caused by the job or the repository, with a message
// written for the person who pushed the code. Anything else is reported as an
// internal builder error.
type userError struct {
	msg string
	err error
}

func (e *userError) Error() string { return e.msg }

func (e *userError) Unwrap() error { return e.err }

// userErrorf returns a [userError] whose message is formatted from format.
// A %w verb also keeps the wrapped error reachable through errors.Is/As.
func userErrorf(format string, args ...any) error {
	err := fmt.Errorf(format, args...)
	return &userError{msg: err.Error(), err: errors.Unwrap(err)}
}

// errTimeout and errBusy are causes the result mapping recognises.
var (
	errTimeout = errors.New("build timed out")
	errBusy    = errors.New("busy")
)

// buildResult maps the outcome of a build to the frame the control plane
// receives. ctx is the build's context, whose cause tells a timeout from a
// cancellation. Messages are redacted and cut to [protocol.MaxMessageBytes].
func buildResult(ctx context.Context, job *protocol.BuildJob, image *protocol.BuiltImage, err error,
	timeout, elapsed time.Duration, r *redactor) protocol.BuildResult {
	res := protocol.BuildResult{
		Type:       protocol.TypeBuildResult,
		BuildID:    job.BuildID,
		DurationMS: max(elapsed.Milliseconds(), 0),
	}
	if err == nil && image != nil {
		res.OK = true
		res.Image = image
		return res
	}
	res.Error = failureMessage(ctx, err, timeout, r)
	return res
}

func failureMessage(ctx context.Context, err error, timeout time.Duration, r *redactor) string {
	var msg string
	var ue *userError
	switch {
	case errors.Is(context.Cause(ctx), errTimeout):
		msg = fmt.Sprintf("Build timed out after %s and was stopped.", timeout)
	case ctx.Err() != nil:
		msg = "Build was cancelled."
	case errors.Is(err, errBusy):
		msg = "Another build is already running on this builder node."
	case errors.As(err, &ue):
		msg = ue.msg
	case err == nil:
		msg = "Internal builder error: the build produced no image."
	default:
		msg = "Internal builder error: " + err.Error()
	}
	msg = strings.ToValidUTF8(r.redact(msg), "�")
	return truncateUTF8(msg, protocol.MaxMessageBytes)
}

// truncateUTF8 cuts s to at most n bytes without splitting a code point.
func truncateUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	const ellipsis = "…"
	cut := n - len(ellipsis)
	for cut > 0 && cut < len(s) && (s[cut]&0xC0) == 0x80 {
		cut--
	}
	return s[:cut] + ellipsis
}
