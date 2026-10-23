//go:build !linux

package docker

// killHostProcess cannot reach engine processes off Linux (Docker Desktop
// runs them in a VM).
func killHostProcess(int, string) (bool, error) { return false, nil }
