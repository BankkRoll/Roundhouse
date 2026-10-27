//go:build !linux

package docker

import "syscall"

// signalHostProcess cannot reach engine processes off Linux (Docker Desktop
// runs them in a VM).
func signalHostProcess(int, string, syscall.Signal) (bool, error) { return false, nil }
