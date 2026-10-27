//go:build linux

package docker

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"syscall"
)

// signalHostProcess sends sig to pid if its cgroup names containerID.
//
// SECURITY: the check guards against PID reuse and against a PID from
// another PID namespace (an agent that itself runs in a container sees other
// processes under those numbers): only a process inside the container's
// cgroup is ever signalled.
func signalHostProcess(pid int, containerID string, sig syscall.Signal) (bool, error) {
	if len(containerID) < 12 {
		return false, nil
	}
	data, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cgroup")
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	if !strings.Contains(string(data), containerID) {
		return false, nil
	}
	if err := syscall.Kill(pid, sig); err != nil {
		if errors.Is(err, syscall.ESRCH) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}
