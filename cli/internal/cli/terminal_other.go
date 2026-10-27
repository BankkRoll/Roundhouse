//go:build !unix && !windows

package cli

// prepareOutput has nothing to do on this system.
func prepareOutput() func() { return func() {} }
