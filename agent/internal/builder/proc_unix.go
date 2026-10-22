//go:build !windows

package builder

import (
	"os/exec"
	"syscall"
	"time"
)

// configureKill runs cmd in its own process group and kills the whole group
// when its context ends, so helpers it spawned (git-remote-https, Railpack's
// mise) die with it. wait bounds how long Wait then waits for output pipes.
func configureKill(cmd *exec.Cmd, wait time.Duration) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
	cmd.WaitDelay = wait
}
