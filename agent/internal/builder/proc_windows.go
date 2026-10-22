package builder

import (
	"os/exec"
	"time"
)

// configureKill kills cmd when its context ends. Windows has no process
// groups to signal; builds run only on Linux, so this exists for unit tests.
func configureKill(cmd *exec.Cmd, wait time.Duration) {
	cmd.WaitDelay = wait
}
