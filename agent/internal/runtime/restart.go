package runtime

import (
	"time"

	protocol "github.com/BankkRoll/Open-Rail/packages/protocol/go"
)

// Crash-loop backoff defaults: the delay before restart n (from 0) is
// min(base·2ⁿ, max), and the streak resets once a container has stayed up
// for resetAfter.
const (
	DefaultRestartBackoff    = time.Second
	DefaultMaxRestartBackoff = 5 * time.Minute
	DefaultBackoffResetAfter = time.Minute
)

// shouldRestart applies a restart policy to a stopped container. For
// on_failure a MaxRetries of 0 means no limit, as in Docker.
func shouldRestart(p protocol.Restart, restarts int, exitCode int, oomKilled bool) bool {
	failed := exitCode != 0 || oomKilled
	switch p.Policy {
	case protocol.RestartAlways:
		return true
	case protocol.RestartOnFailure:
		return failed && (p.MaxRetries == 0 || restarts < p.MaxRetries)
	default:
		return false
	}
}

// stoppedState is the workload state of a container that is not running:
// crashed for a non-zero exit or an OOM kill, exited otherwise.
func stoppedState(exitCode int, oomKilled bool) protocol.WorkloadState {
	if exitCode != 0 || oomKilled {
		return protocol.StateCrashed
	}
	return protocol.StateExited
}

// backoffDelay returns the delay before the next restart after streak
// consecutive quick failures.
func backoffDelay(base, ceiling time.Duration, streak int) time.Duration {
	d := base
	for range streak {
		if d >= ceiling/2 {
			return ceiling
		}
		d *= 2
	}
	return min(d, ceiling)
}
